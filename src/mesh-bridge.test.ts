import { describe, expect, it } from 'vitest'
import type { MeshFrame, MeshTransport } from './mesh.js'
import {
  MeshBridgeWire,
  SeenFrameIds,
  connectMeshBridge,
  withBridgedFrames,
  type MeshFrameCodec,
  type WideBridgeLane,
} from './mesh-bridge.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const codec: MeshFrameCodec = {
  encode: (frame) => textEncoder.encode(JSON.stringify(frame)),
  decode: (bytes) => {
    try {
      return JSON.parse(textDecoder.decode(bytes)) as MeshFrame
    } catch {
      return null
    }
  },
}

class TestLane implements MeshTransport {
  readonly broadcasts: MeshFrame[] = []
  readonly sends: Array<{ peer: string; frame: MeshFrame }> = []
  private readonly handlers = new Set<(frame: MeshFrame) => void>()

  broadcast(frame: MeshFrame): void {
    this.broadcasts.push(frame)
  }

  send(peer: string, frame: MeshFrame): void {
    this.sends.push({ peer, frame })
  }

  subscribe(handler: (frame: MeshFrame) => void): { close(): void } {
    this.handlers.add(handler)
    return { close: () => void this.handlers.delete(handler) }
  }

  inject(frame: MeshFrame): void {
    for (const handler of [...this.handlers]) handler(frame)
  }
}

class TestWideLane extends TestLane implements WideBridgeLane {
  readonly published: Array<{ from: string; frame: MeshFrame; to?: string; id: string }> = []
  private readonly taps = new Set<(frame: MeshFrame, to?: string, id?: string) => void>()

  tap(handler: (frame: MeshFrame, to?: string, id?: string) => void): { close(): void } {
    this.taps.add(handler)
    return { close: () => void this.taps.delete(handler) }
  }

  publishAs(from: string, frame: MeshFrame, options: { to?: string; id: string }): void {
    this.published.push({ from, frame, ...options })
  }

  injectTap(frame: MeshFrame, to?: string, id?: string): void {
    for (const handler of [...this.taps]) handler(frame, to, id)
  }
}

function wire(): MeshBridgeWire {
  let next = 0
  return new MeshBridgeWire({
    kind: 'test-bridge',
    codec,
    randomBytes: (length) => new Uint8Array(length).fill(++next),
  })
}

describe('SeenFrameIds', () => {
  it('keeps first-sight TTLs and a hard capacity bound', () => {
    let now = 0
    const seen = new SeenFrameIds({ capacity: 2, ttlMs: 100, now: () => now })
    expect(seen.check('a')).toBe(true)
    now = 50
    expect(seen.check('a')).toBe(false)
    expect(seen.check('b')).toBe(true)
    expect(seen.check('c')).toBe(true)
    expect(seen.size).toBe(2)
    expect(seen.check('a')).toBe(true)
    expect(seen.size).toBe(2)
    now = 150
    expect(seen.check('a')).toBe(true)
  })
})

describe('MeshBridgeWire', () => {
  it('round-trips byte-safe envelopes and derives stable origin ids', () => {
    const bridgeWire = wire()
    const inner = { kind: 'presence', payload: { nonce: 'n1' } }
    const id = bridgeWire.frameId(inner, 'alice', 'carol')
    expect(id).toBe(bridgeWire.frameId({ ...inner }, 'alice', 'carol'))
    expect(id).not.toBe(bridgeWire.frameId(inner, 'alice'))
    expect(bridgeWire.unwrap(bridgeWire.wrap({ from: 'alice', to: 'carol', id, viaWide: true, inner })))
      .toEqual({ from: 'alice', to: 'carol', id, viaWide: true, inner })
    expect(bridgeWire.unwrap({ kind: 'test-bridge', payload: { f: 'alice', i: 'x', d: 'not-bytes' } }))
      .toBeNull()
  })
})

describe('deterministic two-lane bridge simulation', () => {
  it('kills echo loops and delivers one copy across duplicate routes', () => {
    const local = new TestLane()
    const wide = new TestWideLane()
    const bridgeWire = wire()
    const bridge = connectMeshBridge({
      selfId: 'bridge',
      local,
      wide,
      wire: bridgeWire,
      seen: new SeenFrameIds({ capacity: 16, ttlMs: 20_000, now: () => 1_000 }),
      policy: { forwardLocalBroadcast: (frame) => frame.kind === 'presence' },
      localPeerTtlMs: 60_000,
      now: () => 1_000,
    })
    const delivered: MeshFrame[] = []
    bridge.subscribe((frame) => delivered.push(frame))

    const alice = { kind: 'presence', payload: { nonce: 1 }, from: 'alice' }
    local.inject(alice)
    expect(wide.published).toHaveLength(1)
    expect(delivered).toEqual([alice])

    const forwardedId = wide.published[0]!.id
    wide.injectTap(alice, undefined, forwardedId)
    expect(delivered).toEqual([alice])
    expect(local.broadcasts).toHaveLength(0)

    const carol = { kind: 'presence', payload: { nonce: 2 }, from: 'carol' }
    wide.injectTap(carol, undefined, 'carol-frame')
    wide.injectTap(carol, undefined, 'carol-frame')
    expect(delivered).toEqual([alice, carol])
    expect(local.broadcasts).toHaveLength(1)
    expect(bridge.stats()).toMatchObject({
      forwardedToWide: 1,
      forwardedToLocal: 1,
      duplicatesDropped: 2,
    })
  })

  it('edge shims unwrap one copy and route non-local directed frames via a bridge', () => {
    const lane = new TestLane()
    const bridgeWire = wire()
    const edge = withBridgedFrames(lane, 'alice', {
      wire: bridgeWire,
      seen: new SeenFrameIds({ capacity: 8, ttlMs: 20_000, now: () => 0 }),
      localPeerTtlMs: 60_000,
      now: () => 0,
    })
    const delivered: MeshFrame[] = []
    edge.subscribe((frame) => delivered.push(frame))

    const wrapped = bridgeWire.wrap({
      from: 'carol',
      to: 'alice',
      id: 'one-route',
      inner: { kind: 'channel', payload: [1, 2, 3] },
    })
    lane.inject(wrapped)
    lane.inject(wrapped)
    expect(delivered).toEqual([{ kind: 'channel', payload: [1, 2, 3], from: 'carol' }])

    edge.send('remote', { kind: 'channel', payload: [4] })
    expect(lane.sends).toHaveLength(1)
    expect(lane.broadcasts).toHaveLength(1)

    lane.inject({ kind: 'presence', payload: {}, from: 'local' })
    edge.send('local', { kind: 'channel', payload: [5] })
    expect(lane.sends).toHaveLength(2)
    expect(lane.broadcasts).toHaveLength(1)
  })

  it('broadcast() crosses the wide lane via the tapped publishAs surface, not the untapped wide.broadcast', () => {
    const local = new TestLane()
    const wide = new TestWideLane()
    const bridge = connectMeshBridge({
      selfId: 'bridge',
      local,
      wide,
      wire: wire(),
      seen: new SeenFrameIds({ capacity: 16, ttlMs: 20_000, now: () => 1_000 }),
      policy: { forwardLocalBroadcast: () => false },
      localPeerTtlMs: 60_000,
      now: () => 1_000,
    })

    bridge.broadcast({ kind: 'presence', payload: { nonce: 'n' } })

    // Local peers get it directly.
    expect(local.broadcasts).toHaveLength(1)
    // Remote bridge nodes get it via publishAs — the surface the bridge taps —
    // NOT via wide.broadcast, which no bridge node subscribes to.
    expect(wide.published).toHaveLength(1)
    expect(wide.published[0]?.from).toBe('bridge')
    expect(wide.broadcasts).toHaveLength(0)
  })
})
