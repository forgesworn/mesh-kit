import type { MeshFrame, MeshTransport } from './mesh.js'

type Handler = (frame: MeshFrame) => void

/** Deterministic in-memory mesh for tests. Hands out per-node {@link MeshTransport} views. */
export class SimMesh {
  private readonly handlers = new Map<string, Set<Handler>>()

  node(id: string): MeshTransport {
    return {
      broadcast: (frame) => {
        for (const [peer, set] of this.handlers) {
          if (peer === id) continue
          for (const h of set) h({ ...frame, from: id })
        }
      },
      send: (peer, frame) => {
        for (const h of this.handlers.get(peer) ?? []) h({ ...frame, from: id })
      },
      subscribe: (handler) => {
        const set = this.handlers.get(id) ?? new Set<Handler>()
        set.add(handler)
        this.handlers.set(id, set)
        return { close: () => set.delete(handler) }
      }
    }
  }
}
