/**
 * MeshTransport → SecureChannel adapter.
 *
 * Presents a point-to-point {@link SecureChannel} over a {@link MeshTransport}
 * directed at a single named peer. The channel knows nothing about matching —
 * it is a pure byte seam that lets any {@link SecureChannel} consumer (Noise,
 * runMatch, …) run over any {@link MeshTransport} implementor without change.
 *
 * Assumption: the transport delivers frames to the named peer reliably and in
 * order (as {@link SimMesh} does). The Noise spec (§5.1/§11.4) and the GMW
 * matcher both require a reliable, in-order, lossless transport. In a real
 * lossy BLE mesh the §3 store-and-forward/relay layer beneath this adapter
 * provides that guarantee — that layer is out of scope here.
 *
 * Frames are carried in a {@link MeshFrame} with `kind: 'channel'` and the raw
 * bytes as `payload`. The recv path filters on BOTH `frame.from === peerId` AND
 * `frame.kind === 'channel'`, so frames from the same peer carrying a different
 * kind (e.g. toll `'grant'` frames from {@link VenueTollRail}) are never
 * misdelivered here — allowing a matcher channel and a toll rail to share one
 * {@link MeshTransport} instance without collision.
 *
 * Half-close / peer-liveness note: {@link meshChannel.close} closes only this
 * side and does not notify the peer (unlike {@link SimChannel}, which closes
 * both). Over a real lossy/relay transport a peer blocked in `recv()` will not
 * be woken until an outer timeout fires; the §3 store-and-forward layer is the
 * appropriate fix. Over the in-memory sim a one-sided error may leave the peer
 * awaiting indefinitely until an outer timeout.
 */

import type { MeshTransport } from './mesh.js'
import type { SecureChannel } from './channel.js'

/** A pending resolver waiting for the next inbound byte frame. */
type Waiter = {
  resolve: (frame: Uint8Array) => void
  reject: (err: Error) => void
}

/**
 * Return a {@link SecureChannel} that sends to and receives from exactly one
 * `peerId` over the given `transport`.
 *
 * - `send(frame)` encodes the bytes into a {@link MeshFrame} and calls
 *   `transport.send(peerId, …)`.
 * - `recv()` returns the next frame received FROM `peerId`, skipping frames
 *   from any other sender (defensive filter; in a 2-party sim there is only
 *   one other node). Frames arrive in the order the transport delivers them.
 * - `close()` unsubscribes from the transport and rejects all pending `recv()`
 *   calls with `Error('channel closed')`. Idempotent.
 */
export function meshChannel(transport: MeshTransport, peerId: string): SecureChannel {
  const queue: Uint8Array[] = []
  const waiters: Waiter[] = []
  let closed = false

  const subscription = transport.subscribe((frame) => {
    // Filter: only accept channel frames from our target peer.
    // The kind guard drops toll 'grant' frames (or any other kind) emitted by
    // the same peer, preventing mis-delivery when a matcher channel and a toll
    // rail share one MeshTransport.
    if (frame.from !== peerId) return
    if (frame.kind !== 'channel') return
    if (closed) return

    // The payload is the raw Uint8Array we put there in send().
    const data = frame.payload as Uint8Array
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(data)
    } else {
      queue.push(data)
    }
  })

  function closeInbound(): void {
    closed = true
    subscription.close()
    const err = new Error('channel closed')
    for (const w of waiters.splice(0)) {
      w.reject(err)
    }
  }

  return {
    send(frame: Uint8Array): void {
      if (closed) return
      transport.send(peerId, { kind: 'channel', payload: frame })
    },

    recv(): Promise<Uint8Array> {
      if (closed) return Promise.reject(new Error('channel closed'))
      const next = queue.shift()
      if (next !== undefined) return Promise.resolve(next)
      return new Promise<Uint8Array>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    },

    close(): void {
      if (closed) return
      closeInbound()
    },
  }
}
