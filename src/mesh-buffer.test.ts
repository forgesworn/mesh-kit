import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MeshFrame } from './mesh.js'
import {
  MESH_BUFFER_DEFAULTS,
  createMeshBuffer,
  liveMeshFrames,
  meshFramesFor,
  meshManifest,
  pruneMeshBuffer,
  reconcileMeshManifests,
  rememberMeshFrame,
  type MeshBufferOptions,
  type MeshBufferState,
} from './mesh-buffer.js'

interface FixtureEntry {
  id: string
  frame: MeshFrame
  storedAt: number
}

interface Fixture {
  options: MeshBufferOptions
  entries: FixtureEntry[]
  expected: {
    defaults: MeshBufferOptions
    manifestBeforeCapacityEviction: string[]
    manifestAfterCapacityEviction: string[]
    manifestAtTtlMinusOne: string[]
    manifestAtTtlBoundary: string[]
    reconcile: {
      mine: string[]
      theirs: string[]
      result: { toSend: string[]; toRequest: string[] }
    }
  }
}

const fixture = JSON.parse(readFileSync(new URL('../compatibility-vectors/flock-mesh-buffer-v1.json', import.meta.url), 'utf8')) as Fixture

function retain(entries: FixtureEntry[], options = fixture.options): MeshBufferState {
  return entries.reduce(
    (state, entry) => rememberMeshFrame(state, entry, entry.storedAt, options),
    createMeshBuffer(),
  )
}

describe('Flock mesh-buffer compatibility vectors', () => {
  it('preserves defaults, sorted manifests and oldest-first capacity eviction', () => {
    expect(MESH_BUFFER_DEFAULTS).toEqual(fixture.expected.defaults)
    expect(meshManifest(retain(fixture.entries.slice(0, 3)), 1002, fixture.options))
      .toEqual(fixture.expected.manifestBeforeCapacityEviction)
    expect(meshManifest(retain(fixture.entries), 1003, fixture.options))
      .toEqual(fixture.expected.manifestAfterCapacityEviction)
  })

  it('preserves the exclusive TTL boundary', () => {
    const state = retain(fixture.entries)
    expect(meshManifest(state, 1003 + fixture.options.ttlSeconds - 1, fixture.options))
      .toEqual(fixture.expected.manifestAtTtlMinusOne)
    expect(meshManifest(state, 1003 + fixture.options.ttlSeconds, fixture.options))
      .toEqual(fixture.expected.manifestAtTtlBoundary)
  })

  it('preserves manifest reconciliation order', () => {
    const vector = fixture.expected.reconcile
    expect(reconcileMeshManifests(vector.mine, vector.theirs)).toEqual(vector.result)
  })
})

describe('mesh buffer retention', () => {
  it('is immutable and keeps the original frame object opaque', () => {
    const empty = createMeshBuffer()
    const frame: MeshFrame = { kind: 'opaque', payload: new Uint8Array([0, 255]) }
    const retained = rememberMeshFrame(empty, { id: 'frame-1', frame }, 100, fixture.options)

    expect(retained).not.toBe(empty)
    expect(liveMeshFrames(empty, 100, fixture.options)).toEqual([])
    expect(liveMeshFrames(retained, 100, fixture.options)[0]?.frame).toBe(frame)
  })

  it('does not re-date, reorder or replace an unexpired duplicate', () => {
    const first = rememberMeshFrame(
      createMeshBuffer(),
      { id: 'same', frame: { kind: 'first', payload: 1 } },
      100,
      fixture.options,
    )
    const duplicate = rememberMeshFrame(
      first,
      { id: 'same', frame: { kind: 'replacement', payload: 2 } },
      200,
      fixture.options,
    )

    expect(duplicate).toBe(first)
    expect(liveMeshFrames(duplicate, 200, fixture.options)).toEqual([
      { id: 'same', frame: { kind: 'first', payload: 1 }, storedAt: 100 },
    ])
  })

  it('prunes before insertion and returns the original state when no entry expired', () => {
    const first = rememberMeshFrame(
      createMeshBuffer(),
      { id: 'old', frame: { kind: 'test', payload: null } },
      100,
      fixture.options,
    )
    expect(pruneMeshBuffer(first, 101, fixture.options)).toBe(first)

    const next = rememberMeshFrame(
      first,
      { id: 'new', frame: { kind: 'test', payload: null } },
      100 + fixture.options.ttlSeconds,
      fixture.options,
    )
    expect(meshManifest(next, 100 + fixture.options.ttlSeconds, fixture.options)).toEqual(['new'])
  })

  it('resolves requested ids in order and skips entries lost to a race', () => {
    const state = retain(fixture.entries.slice(0, 2))
    expect(meshFramesFor(state, ['a', 'missing', 'b']).map(({ id }) => id)).toEqual(['a', 'b'])
  })

  it('converges two peers to the same union in one reconciliation round', () => {
    let alice = retain(fixture.entries.slice(0, 2))
    let bob = retain(fixture.entries.slice(1, 3))
    const now = 1002
    const aliceDiff = reconcileMeshManifests(
      meshManifest(alice, now, fixture.options),
      meshManifest(bob, now, fixture.options),
    )
    const bobDiff = reconcileMeshManifests(
      meshManifest(bob, now, fixture.options),
      meshManifest(alice, now, fixture.options),
    )

    for (const entry of meshFramesFor(alice, aliceDiff.toSend)) {
      bob = rememberMeshFrame(bob, entry, now, fixture.options)
    }
    for (const entry of meshFramesFor(bob, bobDiff.toSend)) {
      alice = rememberMeshFrame(alice, entry, now, fixture.options)
    }

    expect(meshManifest(alice, now, fixture.options)).toEqual(['a', 'b', 'c'])
    expect(meshManifest(bob, now, fixture.options)).toEqual(['a', 'b', 'c'])
  })

  it('supports per-frame expiry without changing the v1 default TTL', () => {
    let state = createMeshBuffer()
    state = rememberMeshFrame(
      state,
      { id: 'presence', frame: { kind: 'presence', payload: 1 }, expiresAt: 105 },
      100,
      fixture.options,
    )
    state = rememberMeshFrame(
      state,
      { id: 'message', frame: { kind: 'message', payload: 2 }, expiresAt: 500 },
      100,
      fixture.options,
    )

    expect(meshManifest(state, 104, fixture.options)).toEqual(['message', 'presence'])
    expect(meshManifest(state, 105, fixture.options)).toEqual(['message'])
  })

  it('coalesces replaceable frames by supersedesKey', () => {
    let state = createMeshBuffer()
    state = rememberMeshFrame(
      state,
      { id: 'old', frame: { kind: 'presence', payload: 1 }, supersedesKey: 'presence:alice' },
      100,
      fixture.options,
    )
    state = rememberMeshFrame(
      state,
      { id: 'other', frame: { kind: 'presence', payload: 2 }, supersedesKey: 'presence:bob' },
      101,
      fixture.options,
    )
    state = rememberMeshFrame(
      state,
      { id: 'new', frame: { kind: 'presence', payload: 3 }, supersedesKey: 'presence:alice' },
      102,
      fixture.options,
    )

    expect(meshManifest(state, 102, fixture.options)).toEqual(['new', 'other'])
    expect(liveMeshFrames(state, 102, fixture.options).map(({ id }) => id)).toEqual(['other', 'new'])
  })

  it('evicts the oldest lowest-priority frame under capacity pressure', () => {
    const options = { maxEntries: 2, ttlSeconds: 900 }
    let state = createMeshBuffer()
    state = rememberMeshFrame(
      state,
      { id: 'critical', frame: { kind: 'alert', payload: 1 }, priority: 10 },
      100,
      options,
    )
    state = rememberMeshFrame(
      state,
      { id: 'routine-1', frame: { kind: 'presence', payload: 2 }, priority: 0 },
      101,
      options,
    )
    state = rememberMeshFrame(
      state,
      { id: 'routine-2', frame: { kind: 'presence', payload: 3 }, priority: 0 },
      102,
      options,
    )

    expect(meshManifest(state, 102, options)).toEqual(['critical', 'routine-2'])
  })
})
