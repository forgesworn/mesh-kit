import type { MeshFrame, MeshTransport } from './mesh.js'
import { SeenFrameIds } from './mesh-bridge.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  MESH_BUFFER_DEFAULTS,
  createMeshBuffer,
  liveMeshFrames,
  meshManifest,
  pruneMeshBuffer,
  rememberMeshFrame,
  type MeshBufferOptions,
  type MeshBufferState,
  type RetainedMeshFrame,
} from './mesh-buffer.js'

/** Reserved transport frame used only by the reliability wrapper. */
export const MESH_SYNC_KIND = 'mesh-kit/sync/v1'

export interface MeshRetentionDirective {
  /** Retain for this many seconds. Zero or less means do not retain. */
  ttlSeconds: number
  priority?: number
  /** Replace an older live frame carrying the same application-owned key. */
  supersedesKey?: string
}

export interface MeshReliabilityContext {
  direction: 'inbound' | 'outbound'
  peer?: string
}

export interface MeshReliabilityPolicy {
  /** Stable application id used for deduplication and reconciliation. */
  frameId(frame: MeshFrame): string | null
  /** Product-owned decision: what may persist in the volatile mesh buffer. */
  retention(frame: MeshFrame, context: MeshReliabilityContext): MeshRetentionDirective | null
  /**
   * Optional privacy-preserving inventory token. Peers in one reliability
   * domain must derive the same token for the same id. A room-keyed token keeps
   * stable application ids out of manifest control traffic.
   */
  inventoryToken?(id: string): string
}

export interface MeshReliabilityOptions {
  selfId: string
  transport: MeshTransport
  policy: MeshReliabilityPolicy
  buffer?: MeshBufferState
  bufferOptions?: MeshBufferOptions
  /** Maximum ids accepted or advertised in a reconciliation round. */
  maxManifestEntries?: number
  /** Maximum ids per directed manifest control frame. */
  manifestPageSize?: number
  /** Maximum retained frames offered in response to one manifest. */
  maxOffersPerRound?: number
  /** Per-peer reconciliation cooldown. */
  syncIntervalSeconds?: number
  /** Incomplete manifest lifetime. */
  assemblyTtlSeconds?: number
  /** Unix seconds, injectable for deterministic tests. */
  now?: () => number
  /** Short opaque round id, injectable for compatibility tests. */
  roundId?: () => string
}

export interface MeshReliabilityStats {
  retained: number
  duplicatesDropped: number
  manifestsSent: number
  manifestsReceived: number
  offersSent: number
  offersReceived: number
  invalidControlFrames: number
}

export interface RunningMeshReliability extends MeshTransport {
  /** Explicitly reconcile with a known peer; normal inbound traffic also triggers this. */
  sync(peer: string): void
  /** Live retained frames, oldest first. */
  retained(): RetainedMeshFrame[]
  stats(): MeshReliabilityStats
  close(): void
}

interface ManifestPage {
  v: 1
  t: 'manifest'
  r: string
  p: number
  n: number
  ids: string[]
}

interface FrameOffer {
  v: 1
  t: 'offer'
  i: string
  f: MeshFrame
}

interface ManifestAssembly {
  round: string
  total: number
  pages: Map<number, string[]>
  startedAt: number
}

const DEFAULT_MAX_MANIFEST_ENTRIES = 200
const DEFAULT_MANIFEST_PAGE_SIZE = 24
const DEFAULT_MAX_OFFERS = 64
const DEFAULT_SYNC_INTERVAL_SECONDS = 10
const DEFAULT_ASSEMBLY_TTL_SECONDS = 15
const MAX_TOKEN_CHARS = 128
const MAX_ROUND_CHARS = 64

/**
 * Derive a fixed-size, domain-separated token for frame ids or inventories.
 * A room scope prevents passive cross-room correlation and keeps the original
 * stable id out of reconciliation traffic. This is a privacy transform, not
 * an authenticity proof; products must still validate the offered frame.
 */
export function meshScopedToken(scope: string, value: string): string {
  const input = JSON.stringify(['mesh-kit/scoped-token/v1', scope, value])
  return bytesToHex(sha256(new TextEncoder().encode(input)))
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_CHARS
}

function parseManifest(value: unknown, maxPages: number, pageSize: number): ManifestPage | null {
  if (!isRecord(value) || value['v'] !== 1 || value['t'] !== 'manifest') return null
  const round = value['r']
  const page = value['p']
  const total = value['n']
  const ids = value['ids']
  if (typeof round !== 'string' || round.length === 0 || round.length > MAX_ROUND_CHARS) return null
  if (!Number.isInteger(page) || !Number.isInteger(total)) return null
  if ((page as number) < 0 || (total as number) < 1 || (total as number) > maxPages || (page as number) >= (total as number)) return null
  if (!Array.isArray(ids) || ids.length > pageSize || !ids.every(isToken)) return null
  if (new Set(ids).size !== ids.length) return null
  return { v: 1, t: 'manifest', r: round, p: page as number, n: total as number, ids }
}

function parseOffer(value: unknown): FrameOffer | null {
  if (!isRecord(value) || value['v'] !== 1 || value['t'] !== 'offer' || !isToken(value['i'])) return null
  const frame = value['f']
  if (!isRecord(frame) || typeof frame['kind'] !== 'string' || frame['kind'] === MESH_SYNC_KIND) return null
  if (frame['from'] !== undefined && typeof frame['from'] !== 'string') return null
  return { v: 1, t: 'offer', i: value['i'], f: frame as unknown as MeshFrame }
}

function defaultRoundId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Add bounded store-and-forward reconciliation to any MeshTransport.
 *
 * The wrapper is deliberately transport-agnostic: it learns a peer from the
 * first authenticated/application frame, exchanges paged manifests directly
 * with that peer, and offers only missing retained frames. Original `from`
 * attribution is carried inside an offer so a courier never becomes the
 * apparent author. Control frames are bounded, rate-limited and never exposed
 * to application subscribers.
 */
export function withMeshReliability(options: MeshReliabilityOptions): RunningMeshReliability {
  const { selfId, transport, policy } = options
  const bufferOptions = options.bufferOptions ?? MESH_BUFFER_DEFAULTS
  const maxManifestEntries = positiveInteger(options.maxManifestEntries, DEFAULT_MAX_MANIFEST_ENTRIES)
  const manifestPageSize = Math.min(
    maxManifestEntries,
    positiveInteger(options.manifestPageSize, DEFAULT_MANIFEST_PAGE_SIZE),
  )
  const maxOffersPerRound = positiveInteger(options.maxOffersPerRound, DEFAULT_MAX_OFFERS)
  const syncIntervalSeconds = positiveInteger(options.syncIntervalSeconds, DEFAULT_SYNC_INTERVAL_SECONDS)
  const assemblyTtlSeconds = positiveInteger(options.assemblyTtlSeconds, DEFAULT_ASSEMBLY_TTL_SECONDS)
  const maxPages = Math.ceil(maxManifestEntries / manifestPageSize)
  const now = options.now ?? (() => Date.now() / 1000)
  const makeRoundId = options.roundId ?? defaultRoundId
  const tokenFor = policy.inventoryToken ?? ((id: string) => id)

  let buffer = options.buffer ?? createMeshBuffer()
  // Dedup is independent of retention: even a frame the policy declines to RETAIN
  // (a live channel frame, a handshake) must not reach the consumer twice when it
  // arrives via several relay paths on a flooding mesh. Retained frames dedup via
  // the buffer's byId; this set covers the non-retained-but-identified ones.
  const dedupSeen = new SeenFrameIds({
    capacity: Math.max(64, bufferOptions.maxEntries),
    ttlMs: bufferOptions.ttlSeconds * 1000,
    now: () => now() * 1000,
  })
  let closed = false
  const consumers = new Set<(frame: MeshFrame) => void>()
  const sentManifestAt = new Map<string, number>()
  const handledManifestAt = new Map<string, number>()
  const assemblies = new Map<string, ManifestAssembly>()
  const counters: MeshReliabilityStats = {
    retained: 0,
    duplicatesDropped: 0,
    manifestsSent: 0,
    manifestsReceived: 0,
    offersSent: 0,
    offersReceived: 0,
    invalidControlFrames: 0,
  }

  function liveBuffer(): MeshBufferState {
    buffer = pruneMeshBuffer(buffer, now(), bufferOptions)
    return buffer
  }

  function tokenMap(): Map<string, string> {
    const result = new Map<string, string>()
    const collisions = new Set<string>()
    for (const id of meshManifest(liveBuffer(), now(), bufferOptions).slice(0, maxManifestEntries)) {
      const token = tokenFor(id)
      if (!isToken(token)) continue
      if (result.has(token)) {
        result.delete(token)
        collisions.add(token)
      } else if (!collisions.has(token)) {
        result.set(token, id)
      }
    }
    return result
  }

  function retain(frame: MeshFrame, context: MeshReliabilityContext): { retained: boolean; fresh: boolean } {
    const id = policy.frameId(frame)
    if (!isToken(id)) return { retained: false, fresh: true }
    const directive = policy.retention(frame, context)
    if (directive === null || !Number.isFinite(directive.ttlSeconds) || directive.ttlSeconds <= 0) {
      // Not retained for reconciliation, but still deduplicated by id — a repeat
      // delivery of the same identified frame must not reach the consumer twice.
      return { retained: false, fresh: dedupSeen.check(id) }
    }
    const current = liveBuffer()
    if (current.byId.has(id)) return { retained: true, fresh: false }
    buffer = rememberMeshFrame(
      current,
      {
        id,
        frame,
        expiresAt: now() + directive.ttlSeconds,
        ...(directive.priority !== undefined ? { priority: directive.priority } : {}),
        ...(directive.supersedesKey !== undefined ? { supersedesKey: directive.supersedesKey } : {}),
      },
      now(),
      bufferOptions,
    )
    counters.retained += 1
    return { retained: true, fresh: true }
  }

  function sendManifest(peer: string, force = false): void {
    if (closed || peer.length === 0 || peer === selfId) return
    const at = now()
    const last = sentManifestAt.get(peer)
    if (!force && last !== undefined && at - last < syncIntervalSeconds) return

    const ids = [...tokenMap().keys()].sort()
    const total = Math.max(1, Math.ceil(ids.length / manifestPageSize))
    const round = makeRoundId()
    if (round.length === 0 || round.length > MAX_ROUND_CHARS) return
    // Record before the first synchronous transport send: deterministic test
    // transports (and some in-process lanes) can deliver immediately, and the
    // peer's reply must not re-enter an unmarked round forever.
    sentManifestAt.set(peer, at)
    for (let page = 0; page < total; page += 1) {
      const payload: ManifestPage = {
        v: 1,
        t: 'manifest',
        r: round,
        p: page,
        n: total,
        ids: ids.slice(page * manifestPageSize, (page + 1) * manifestPageSize),
      }
      transport.send(peer, { kind: MESH_SYNC_KIND, payload })
      counters.manifestsSent += 1
    }
  }

  function offerMissing(peer: string, remoteTokens: string[]): void {
    const at = now()
    const last = handledManifestAt.get(peer)
    if (last !== undefined && at - last < syncIntervalSeconds) return
    handledManifestAt.set(peer, at)

    const remote = new Set(remoteTokens)
    const local = tokenMap()
    let offered = 0
    for (const [token, id] of local) {
      if (remote.has(token) || offered >= maxOffersPerRound) continue
      const retained = liveBuffer().byId.get(id)
      if (!retained) continue
      const payload: FrameOffer = { v: 1, t: 'offer', i: token, f: retained.frame }
      transport.send(peer, { kind: MESH_SYNC_KIND, payload })
      counters.offersSent += 1
      offered += 1
    }
  }

  function handleManifest(peer: string, payload: ManifestPage): void {
    const key = peer
    const at = now()
    const existing = assemblies.get(key)
    let assembly: ManifestAssembly
    if (!existing || existing.round !== payload.r || existing.total !== payload.n || at - existing.startedAt >= assemblyTtlSeconds) {
      assembly = { round: payload.r, total: payload.n, pages: new Map(), startedAt: at }
      assemblies.set(key, assembly)
    } else {
      assembly = existing
    }
    assembly.pages.set(payload.p, payload.ids)
    counters.manifestsReceived += 1
    if (assembly.pages.size !== assembly.total) return

    const ids: string[] = []
    for (let page = 0; page < assembly.total; page += 1) {
      const values = assembly.pages.get(page)
      if (!values) return
      ids.push(...values)
    }
    assemblies.delete(key)
    if (ids.length > maxManifestEntries || new Set(ids).size !== ids.length) {
      counters.invalidControlFrames += 1
      return
    }
    // A received manifest proves the peer speaks this protocol. Reply with our
    // current view (subject to the per-peer rate limit), then offer its gaps.
    sendManifest(peer)
    offerMissing(peer, ids)
  }

  function handleOffer(peer: string, payload: FrameOffer): void {
    const frame = { ...payload.f }
    const id = policy.frameId(frame)
    if (id === null || tokenFor(id) !== payload.i) {
      counters.invalidControlFrames += 1
      return
    }
    const result = retain(frame, { direction: 'inbound', peer })
    if (!result.retained) {
      // A peer must not bypass product retention policy via store-and-forward.
      counters.invalidControlFrames += 1
      return
    }
    if (!result.fresh) {
      counters.duplicatesDropped += 1
      return
    }
    counters.offersReceived += 1
    for (const handler of [...consumers]) handler(frame)
  }

  const inbound = transport.subscribe((frame) => {
    if (closed) return
    if (frame.kind === MESH_SYNC_KIND) {
      const peer = frame.from
      if (typeof peer !== 'string' || peer.length === 0 || peer === selfId) {
        counters.invalidControlFrames += 1
        return
      }
      const manifest = parseManifest(frame.payload, maxPages, manifestPageSize)
      if (manifest) {
        handleManifest(peer, manifest)
        return
      }
      const offer = parseOffer(frame.payload)
      if (offer) {
        handleOffer(peer, offer)
        return
      }
      counters.invalidControlFrames += 1
      return
    }

    const peer = frame.from
    const result = retain(frame, { direction: 'inbound', ...(peer !== undefined ? { peer } : {}) })
    if (!result.fresh) {
      counters.duplicatesDropped += 1
    } else {
      for (const handler of [...consumers]) handler(frame)
    }
    if (typeof peer === 'string') sendManifest(peer)
  })

  function assertApplicationFrame(frame: MeshFrame): void {
    if (frame.kind === MESH_SYNC_KIND) throw new Error(`${MESH_SYNC_KIND} is reserved by mesh-kit`)
  }

  return {
    broadcast(frame): void {
      assertApplicationFrame(frame)
      retain({ ...frame, from: selfId }, { direction: 'outbound' })
      transport.broadcast(frame)
    },
    send(peer, frame): void {
      assertApplicationFrame(frame)
      retain({ ...frame, from: selfId }, { direction: 'outbound', peer })
      transport.send(peer, frame)
    },
    subscribe(handler): { close(): void } {
      consumers.add(handler)
      return { close: () => void consumers.delete(handler) }
    },
    sync(peer): void {
      sendManifest(peer, true)
    },
    retained(): RetainedMeshFrame[] {
      return liveMeshFrames(liveBuffer(), now(), bufferOptions)
    },
    stats(): MeshReliabilityStats {
      return { ...counters }
    },
    close(): void {
      if (closed) return
      closed = true
      inbound.close()
      consumers.clear()
      assemblies.clear()
    },
  }
}
