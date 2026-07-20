import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { MeshFrame } from './mesh.js'
import {
  MESH_SYNC_KIND,
  meshScopedToken,
  withMeshReliability,
  type MeshReliabilityPolicy,
} from './mesh-reliability.js'
import { SimMesh } from './sim-mesh.js'

function idOf(frame: MeshFrame): string | null {
  const payload = frame.payload
  if (payload === null || typeof payload !== 'object') return null
  const id = (payload as Record<string, unknown>)['id']
  return typeof id === 'string' ? id : null
}

const policy: MeshReliabilityPolicy = {
  frameId: idOf,
  retention: (frame) => {
    const id = idOf(frame)
    if (!id || frame.kind === 'live-only') return null
    return {
      ttlSeconds: 900,
      ...(frame.kind === 'presence' ? { supersedesKey: `presence:${frame.from ?? 'unknown'}` } : {}),
      ...(frame.kind === 'alert' ? { priority: 10 } : {}),
    }
  },
  inventoryToken: (id) => `room-token:${id}`,
}

function rounder(prefix: string): () => string {
  let round = 0
  return () => `${prefix}-${++round}`
}

describe('withMeshReliability', () => {
  it('keeps the v1 reconciliation compatibility fixture in sync', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../compatibility-vectors/mesh-reliability-v1.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    expect(fixture['kind']).toBe(MESH_SYNC_KIND)
    expect(fixture['manifest']).toEqual({
      v: 1,
      t: 'manifest',
      r: 'round-01',
      p: 0,
      n: 1,
      ids: ['room-scoped-token-a', 'room-scoped-token-b'],
    })
    expect(fixture['offer']).toMatchObject({
      v: 1,
      t: 'offer',
      i: 'room-scoped-token-a',
      f: { kind: 'signed-message', from: 'original-author' },
    })
  })

  it('derives fixed-size scoped inventory tokens without exposing the source id', () => {
    const value = 'sensitive-stable-id'
    const first = meshScopedToken('room-a', value)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain(value)
    expect(meshScopedToken('room-a', value)).toBe(first)
    expect(meshScopedToken('room-b', value)).not.toBe(first)
  })

  it('reconciles a frame sent before a peer arrived', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice',
      transport: mesh.node('alice'),
      policy,
      now: () => 1_000,
      roundId: rounder('a'),
    })
    alice.broadcast({ kind: 'message', payload: { id: 'late', text: 'hello' } })

    const bob = withMeshReliability({
      selfId: 'bob',
      transport: mesh.node('bob'),
      policy,
      now: () => 1_001,
      roundId: rounder('b'),
    })
    const received: MeshFrame[] = []
    bob.subscribe((frame) => received.push(frame))

    bob.sync('alice')

    expect(received).toEqual([
      { kind: 'message', payload: { id: 'late', text: 'hello' }, from: 'alice' },
    ])
    expect(bob.retained().map(({ id }) => id)).toEqual(['late'])
    expect(bob.stats()).toMatchObject({ offersReceived: 1, invalidControlFrames: 0 })
  })

  it('preserves the original author across a physical courier', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice', transport: mesh.node('alice'), policy, now: () => 2_000, roundId: rounder('a'),
    })
    const bob = withMeshReliability({
      selfId: 'bob', transport: mesh.node('bob'), policy, now: () => 2_000, roundId: rounder('b'),
    })
    bob.subscribe(() => {})
    alice.broadcast({ kind: 'message', payload: { id: 'carried', text: 'from alice' } })
    expect(bob.retained().map(({ frame }) => frame.from)).toEqual(['alice'])

    const carol = withMeshReliability({
      selfId: 'carol', transport: mesh.node('carol'), policy, now: () => 2_001, roundId: rounder('c'),
    })
    const received: MeshFrame[] = []
    carol.subscribe((frame) => received.push(frame))
    carol.sync('bob')

    expect(received).toEqual([
      { kind: 'message', payload: { id: 'carried', text: 'from alice' }, from: 'alice' },
    ])
  })

  it('deduplicates a later direct copy after reconciliation', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice', transport: mesh.node('alice'), policy, now: () => 3_000, roundId: rounder('a'),
    })
    alice.broadcast({ kind: 'message', payload: { id: 'same', text: 'one' } })
    const bob = withMeshReliability({
      selfId: 'bob', transport: mesh.node('bob'), policy, now: () => 3_001, roundId: rounder('b'),
    })
    const received: MeshFrame[] = []
    bob.subscribe((frame) => received.push(frame))
    bob.sync('alice')
    alice.broadcast({ kind: 'message', payload: { id: 'same', text: 'one' } })

    expect(received).toHaveLength(1)
    expect(bob.stats().duplicatesDropped).toBe(1)
  })

  it('never store-forwards a frame rejected by product policy', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice', transport: mesh.node('alice'), policy, now: () => 4_000, roundId: rounder('a'),
    })
    alice.broadcast({ kind: 'live-only', payload: { id: 'secret' } })
    expect(alice.retained()).toEqual([])

    const bob = withMeshReliability({
      selfId: 'bob', transport: mesh.node('bob'), policy, now: () => 4_001, roundId: rounder('b'),
    })
    const received: MeshFrame[] = []
    bob.subscribe((frame) => received.push(frame))
    bob.sync('alice')
    expect(received).toEqual([])
  })

  it('coalesces replaceable presence while retaining ordinary messages', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice', transport: mesh.node('alice'), policy, now: () => 5_000, roundId: rounder('a'),
    })
    alice.broadcast({ kind: 'presence', payload: { id: 'p1' } })
    alice.broadcast({ kind: 'message', payload: { id: 'm1' } })
    alice.broadcast({ kind: 'presence', payload: { id: 'p2' } })

    expect(alice.retained().map(({ id }) => id)).toEqual(['m1', 'p2'])
  })

  it('pages bounded manifests and rejects malformed control traffic', () => {
    const mesh = new SimMesh()
    const aliceNode = mesh.node('alice')
    const alice = withMeshReliability({
      selfId: 'alice',
      transport: aliceNode,
      policy,
      maxManifestEntries: 3,
      manifestPageSize: 2,
      now: () => 6_000,
      roundId: rounder('a'),
    })
    for (const id of ['1', '2', '3']) alice.broadcast({ kind: 'message', payload: { id } })

    const rawBob = mesh.node('bob')
    const controls: MeshFrame[] = []
    rawBob.subscribe((frame) => controls.push(frame))
    alice.sync('bob')
    expect(controls.filter((frame) => frame.kind === MESH_SYNC_KIND)).toHaveLength(2)

    rawBob.send('alice', {
      kind: MESH_SYNC_KIND,
      payload: { v: 1, t: 'manifest', r: 'bad', p: 0, n: 999, ids: [] },
    })
    expect(alice.stats().invalidControlFrames).toBe(1)
  })

  it('reserves the control kind from applications', () => {
    const mesh = new SimMesh()
    const alice = withMeshReliability({
      selfId: 'alice', transport: mesh.node('alice'), policy, now: () => 7_000, roundId: rounder('a'),
    })
    expect(() => alice.broadcast({ kind: MESH_SYNC_KIND, payload: {} })).toThrow(/reserved/)
  })
})
