/**
 * A frame on the mesh. `from` is set by the transport on delivery.
 *
 * `kind` is **opaque to the transport** — a plain string the substrate never
 * interprets. Each consumer owns its own frame vocabulary and filters on it
 * (e.g. a payment rail's `'offer'`/`'grant'`, a presence layer's `'presence'`).
 * The only kind this package reserves is `'channel'`, used by {@link meshChannel}
 * to carry the bytes of a {@link SecureChannel}; that reservation is what lets a
 * channel and an application rail share one {@link MeshTransport} without collision.
 */
export interface MeshFrame {
  kind: string
  payload: unknown
  from?: string
}

/** A single node's view of the mesh. Presence is implicit: receiving a frame proves range. */
export interface MeshTransport {
  /** Send to every other node. */
  broadcast(frame: MeshFrame): void
  /** Send to one addressed node. */
  send(peer: string, frame: MeshFrame): void
  /** Receive frames addressed to this node (directed or broadcast). */
  subscribe(handler: (frame: MeshFrame) => void): { close: () => void }
}
