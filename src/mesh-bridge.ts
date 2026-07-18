import type { MeshFrame, MeshTransport } from './mesh.js'

export interface MeshFrameCodec {
  encode(frame: MeshFrame): Uint8Array
  /** Total decoder: malformed input returns null. */
  decode(bytes: Uint8Array): MeshFrame | null
}

export interface BridgedMeshFrame {
  from: string
  to?: string
  id: string
  /** Marks a frame that has already crossed from the wide lane. */
  viaWide?: boolean
  inner: MeshFrame
}

export interface MeshBridgeWireOptions {
  /** Consumer-owned frame kind reserved for bridge envelopes. */
  kind: string
  codec: MeshFrameCodec
  /** Injectable random source for origin-minted ids. */
  randomBytes?: (length: number) => Uint8Array
}

/** Wire-format operations for one consumer-selected bridge kind and frame codec. */
export class MeshBridgeWire {
  readonly kind: string
  private readonly frameCodec: MeshFrameCodec
  private readonly randomBytes: (length: number) => Uint8Array

  constructor(options: MeshBridgeWireOptions) {
    this.kind = options.kind
    this.frameCodec = options.codec
    this.randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)))
  }

  /** Deterministic FNV-1a 64 id, keyed by origin and optional target. */
  frameId(frame: MeshFrame, from: string, to?: string): string {
    const bytes = this.frameCodec.encode({ kind: frame.kind, payload: frame.payload })
    let hash = 0xcbf29ce484222325n
    const prime = 0x100000001b3n
    const mask = 0xffffffffffffffffn
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * prime) & mask
    const metadata = new TextEncoder().encode(`|${from}|${to ?? '*'}`)
    for (const byte of metadata) hash = ((hash ^ BigInt(byte)) * prime) & mask
    return hash.toString(16)
  }

  /** Fresh per-send id for an envelope minted at its origin node. */
  freshId(): string {
    return Array.from(this.randomBytes(8), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  wrap(frame: BridgedMeshFrame): MeshFrame {
    return {
      kind: this.kind,
      payload: {
        f: frame.from,
        ...(frame.to !== undefined ? { t: frame.to } : {}),
        i: frame.id,
        ...(frame.viaWide === true ? { w: 1 } : {}),
        d: this.frameCodec.encode({ kind: frame.inner.kind, payload: frame.inner.payload }),
      },
    }
  }

  /** Decode a bridge envelope. Malformed or hostile input returns null. */
  unwrap(frame: MeshFrame): BridgedMeshFrame | null {
    if (frame.kind !== this.kind) return null
    const payload = frame.payload
    if (payload === null || typeof payload !== 'object') return null
    const record = payload as Record<string, unknown>
    if (typeof record['f'] !== 'string' || typeof record['i'] !== 'string') return null
    if (record['t'] !== undefined && typeof record['t'] !== 'string') return null
    if (!(record['d'] instanceof Uint8Array)) return null
    const inner = this.frameCodec.decode(record['d'])
    if (inner === null) return null
    return {
      from: record['f'],
      ...(record['t'] !== undefined ? { to: record['t'] as string } : {}),
      id: record['i'],
      ...(record['w'] === 1 ? { viaWide: true } : {}),
      inner,
    }
  }
}

export interface SeenFrameIdsOptions {
  capacity: number
  ttlMs: number
  now?: () => number
}

/** Bounded first-sight TTL cache shared by bridge forwarding and delivery. */
export class SeenFrameIds {
  private readonly entries = new Map<string, number>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: SeenFrameIdsOptions) {
    this.capacity = options.capacity
    this.ttlMs = options.ttlMs
    this.now = options.now ?? (() => Date.now())
  }

  /** True only when the id was not currently suppressed; records first sight. */
  check(id: string): boolean {
    const at = this.now()
    const seenAt = this.entries.get(id)
    if (seenAt !== undefined && at - seenAt < this.ttlMs) return false

    this.entries.delete(id)
    this.entries.set(id, at)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.entries.size
  }
}

export interface BridgeEdgeOptions {
  wire: MeshBridgeWire
  seen: SeenFrameIds
  /** How long a plain inbound frame proves a peer is local to this lane. */
  localPeerTtlMs: number
  now?: () => number
}

export interface RunningBridgeEdge extends MeshTransport {
  /** Close the bridge subscription; the caller still owns the lane lifecycle. */
  close(): void
}

/** Decorate a single-lane edge so directed traffic can traverse any bridge. */
export function withBridgedFrames(
  transport: MeshTransport,
  selfId: string,
  options: BridgeEdgeOptions,
): RunningBridgeEdge {
  const { wire, seen, localPeerTtlMs } = options
  const now = options.now ?? (() => Date.now())
  const localPeers = new Map<string, number>()
  const consumers = new Set<(frame: MeshFrame) => void>()
  const isLocal = (peer: string): boolean => {
    const at = localPeers.get(peer)
    return at !== undefined && now() - at < localPeerTtlMs
  }

  const inbound = transport.subscribe((frame) => {
    if (frame.kind !== wire.kind) {
      if (frame.from !== undefined) localPeers.set(frame.from, now())
      for (const handler of [...consumers]) handler(frame)
      return
    }

    const bridged = wire.unwrap(frame)
    if (bridged === null) return
    if (bridged.from === selfId) return
    if (bridged.to !== undefined && bridged.to !== selfId) return
    if (!seen.check(bridged.id)) return
    const restored: MeshFrame = { ...bridged.inner, from: bridged.from }
    for (const handler of [...consumers]) handler(restored)
  })

  return {
    broadcast: (frame) => transport.broadcast(frame),
    send: (peer, frame) => {
      transport.send(peer, frame)
      if (isLocal(peer)) return
      transport.broadcast(wire.wrap({ from: selfId, to: peer, id: wire.freshId(), inner: frame }))
    },
    subscribe: (handler) => {
      consumers.add(handler)
      return { close: () => void consumers.delete(handler) }
    },
    close: () => {
      inbound.close()
      consumers.clear()
    },
  }
}

export interface WideBridgeLane extends MeshTransport {
  tap(handler: (frame: MeshFrame, to?: string, bridgeId?: string) => void): { close(): void }
  publishAs(from: string, frame: MeshFrame, options: { to?: string; id: string }): void
}

export interface MeshBridgePolicy {
  /** Select plain local broadcasts that may cross onto the wide lane. */
  forwardLocalBroadcast(frame: MeshFrame, from: string): boolean
  /** Optional per-frame throttle window. No value means no throttle. */
  throttleMs?(frame: MeshFrame, from: string, to?: string): number | undefined
}

export interface MeshBridgeOptions {
  selfId: string
  local: MeshTransport
  wide: WideBridgeLane
  wire: MeshBridgeWire
  seen: SeenFrameIds
  policy: MeshBridgePolicy
  localPeerTtlMs: number
  now?: () => number
}

export interface MeshBridgeStats {
  forwardedToWide: number
  forwardedToLocal: number
  duplicatesDropped: number
  localPeers: number
}

export interface RunningMeshBridge extends MeshTransport {
  stats(): MeshBridgeStats
  /** Close bridge subscriptions; the caller still owns both lane lifecycles. */
  close(): void
}

/** Join two lanes while leaving frame policy, metrics and lane lifecycle outside. */
export function connectMeshBridge(options: MeshBridgeOptions): RunningMeshBridge {
  const { selfId, local, wide, wire, seen, policy, localPeerTtlMs } = options
  const now = options.now ?? (() => Date.now())
  const handlers = new Set<(frame: MeshFrame) => void>()
  const localPeers = new Map<string, number>()
  const lastForwarded = new Map<string, number>()
  let forwardedToWide = 0
  let forwardedToLocal = 0
  let duplicatesDropped = 0

  const isLocalFresh = (peer: string): boolean => {
    const at = localPeers.get(peer)
    return at !== undefined && now() - at < localPeerTtlMs
  }
  const throttled = (frame: MeshFrame, from: string, to?: string): boolean => {
    const window = policy.throttleMs?.(frame, from, to)
    if (window === undefined) return false
    const key = `${frame.kind}|${from}|${to ?? '*'}`
    const last = lastForwarded.get(key)
    if (last !== undefined && now() - last < window) return true
    lastForwarded.set(key, now())
    return false
  }
  const deliver = (frame: MeshFrame): void => {
    for (const handler of [...handlers]) handler(frame)
  }

  const localSubscription = local.subscribe((frame) => {
    if (frame.kind === wire.kind) {
      const bridged = wire.unwrap(frame)
      if (bridged === null || bridged.from === selfId) return
      if (!seen.check(bridged.id)) {
        duplicatesDropped += 1
        return
      }
      if (bridged.to === undefined || bridged.to === selfId) {
        deliver({ ...bridged.inner, from: bridged.from })
        return
      }
      if (bridged.viaWide === true || throttled(bridged.inner, bridged.from, bridged.to)) return
      wide.publishAs(bridged.from, bridged.inner, { to: bridged.to, id: bridged.id })
      forwardedToWide += 1
      return
    }

    if (frame.from === undefined) return
    localPeers.set(frame.from, now())
    const id = wire.frameId(frame, frame.from)
    if (!seen.check(id)) {
      duplicatesDropped += 1
      return
    }
    deliver(frame)
    if (policy.forwardLocalBroadcast(frame, frame.from)) {
      if (throttled(frame, frame.from)) return
      wide.publishAs(frame.from, frame, { id })
      forwardedToWide += 1
    }
  })

  const wideTap = wide.tap((frame, to, suppliedId) => {
    if (frame.from === undefined) return
    const id = suppliedId ?? wire.frameId(frame, frame.from, to)
    if (!seen.check(id)) {
      duplicatesDropped += 1
      return
    }
    if (to === undefined) {
      deliver(frame)
      local.broadcast(wire.wrap({ from: frame.from, id, viaWide: true, inner: frame }))
      forwardedToLocal += 1
      return
    }
    if (to === selfId) {
      deliver(frame)
      return
    }
    if (isLocalFresh(to)) {
      if (throttled(frame, frame.from, to)) return
      local.broadcast(wire.wrap({ from: frame.from, to, id, viaWide: true, inner: frame }))
      forwardedToLocal += 1
    }
  })

  return {
    broadcast: (frame) => {
      local.broadcast(frame)
      wide.broadcast(frame)
    },
    send: (peer, frame) => {
      if (isLocalFresh(peer)) {
        local.send(peer, frame)
        return
      }
      const id = wire.freshId()
      wide.publishAs(selfId, frame, { to: peer, id })
      local.broadcast(wire.wrap({ from: selfId, to: peer, id, inner: frame }))
    },
    subscribe: (handler) => {
      handlers.add(handler)
      return { close: () => void handlers.delete(handler) }
    },
    stats: () => ({
      forwardedToWide,
      forwardedToLocal,
      duplicatesDropped,
      localPeers: [...localPeers.values()].filter((at) => now() - at < localPeerTtlMs).length,
    }),
    close: () => {
      localSubscription.close()
      wideTap.close()
      handlers.clear()
    },
  }
}
