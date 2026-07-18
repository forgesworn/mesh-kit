import type { MeshFrame } from './mesh.js'

/** A retained opaque mesh frame, identified by the consumer's stable frame id. */
export interface RetainedMeshFrame {
  id: string
  frame: MeshFrame
  /** Unix seconds when this node first retained the frame. */
  storedAt: number
}

/** Immutable store-and-forward state. Use the functions below rather than mutating it. */
export interface MeshBufferState {
  /** Insertion order, oldest first. */
  order: string[]
  byId: Map<string, RetainedMeshFrame>
}

export interface MeshBufferOptions {
  /** Hard memory bound; the oldest entry is evicted first. */
  maxEntries: number
  /** Retention time in seconds. */
  ttlSeconds: number
}

/** The values originally proven in Flock: 200 frames retained for 15 minutes. */
export const MESH_BUFFER_DEFAULTS: MeshBufferOptions = {
  maxEntries: 200,
  ttlSeconds: 15 * 60,
}

export function createMeshBuffer(): MeshBufferState {
  return { order: [], byId: new Map() }
}

/**
 * Drop expired entries. The TTL boundary is exclusive: an entry whose age is
 * exactly `ttlSeconds` is expired. Returns the original state when unchanged.
 */
export function pruneMeshBuffer(
  state: MeshBufferState,
  now: number,
  options: MeshBufferOptions = MESH_BUFFER_DEFAULTS,
): MeshBufferState {
  const order = state.order.filter((id) => {
    const entry = state.byId.get(id)
    return entry !== undefined && now - entry.storedAt < options.ttlSeconds
  })

  if (order.length === state.order.length) return state

  const byId = new Map<string, RetainedMeshFrame>()
  for (const id of order) byId.set(id, state.byId.get(id) as RetainedMeshFrame)
  return { order, byId }
}

/**
 * Retain a frame after pruning expired entries. An unexpired duplicate is a
 * no-op: it is neither reordered nor re-dated, preventing a looped frame from
 * extending its own lifetime forever.
 */
export function rememberMeshFrame(
  state: MeshBufferState,
  entry: { id: string; frame: MeshFrame },
  now: number,
  options: MeshBufferOptions = MESH_BUFFER_DEFAULTS,
): MeshBufferState {
  const pruned = pruneMeshBuffer(state, now, options)
  if (pruned.byId.has(entry.id)) return pruned

  const byId = new Map(pruned.byId)
  byId.set(entry.id, { ...entry, storedAt: now })
  const order = [...pruned.order, entry.id]

  while (order.length > options.maxEntries) {
    const dropped = order.shift() as string
    byId.delete(dropped)
  }

  return { order, byId }
}

/** Return live retained frames, oldest first. */
export function liveMeshFrames(
  state: MeshBufferState,
  now: number,
  options: MeshBufferOptions = MESH_BUFFER_DEFAULTS,
): RetainedMeshFrame[] {
  const pruned = pruneMeshBuffer(state, now, options)
  return pruned.order.map((id) => pruned.byId.get(id) as RetainedMeshFrame)
}

/** Return the order-independent, sorted manifest advertised during reconciliation. */
export function meshManifest(
  state: MeshBufferState,
  now: number,
  options: MeshBufferOptions = MESH_BUFFER_DEFAULTS,
): string[] {
  return [...pruneMeshBuffer(state, now, options).byId.keys()].sort()
}

/** Compute the frames to send and request from two peer manifests. */
export function reconcileMeshManifests(
  mine: readonly string[],
  theirs: readonly string[],
): { toSend: string[]; toRequest: string[] } {
  const mineSet = new Set(mine)
  const theirSet = new Set(theirs)
  return {
    toSend: mine.filter((id) => !theirSet.has(id)),
    toRequest: theirs.filter((id) => !mineSet.has(id)),
  }
}

/**
 * Resolve manifest ids to retained frames in the supplied order. Missing ids
 * are skipped because an entry can expire or be evicted after reconciliation.
 */
export function meshFramesFor(
  state: MeshBufferState,
  ids: readonly string[],
): RetainedMeshFrame[] {
  const frames: RetainedMeshFrame[] = []
  for (const id of ids) {
    const frame = state.byId.get(id)
    if (frame) frames.push(frame)
  }
  return frames
}
