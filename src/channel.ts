/** Ordered, authenticated, encrypted byte duplex — the interface the matcher protocol runs over. */
export interface SecureChannel {
  /** Enqueue a frame to the peer. May be called synchronously. */
  send(frame: Uint8Array): void
  /**
   * Resolves with the next inbound frame in arrival order.
   * Rejects with `Error('channel closed')` if the channel is closed before a
   * frame arrives, or if the channel is already closed when called.
   */
  recv(): Promise<Uint8Array>
  /**
   * Close this channel. Any pending or future `recv()` calls on this channel
   * reject with `Error('channel closed')`. Idempotent.
   */
  close(): void
}

/** A pending resolver waiting for the next inbound frame. */
type Waiter = {
  resolve: (frame: Uint8Array) => void
  reject: (err: Error) => void
}

/** One half of a SimChannel pair — an in-memory FIFO byte channel. */
class SimChannelSide implements SecureChannel {
  /** Frames enqueued by the peer, not yet consumed by recv(). */
  private readonly queue: Uint8Array[] = []
  /** Callers blocked in recv() waiting for the next frame. */
  private readonly waiters: Waiter[] = []
  private closed = false

  /** Called by the peer to push a frame into this side's inbound queue. */
  _enqueue(frame: Uint8Array): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(frame)
    } else {
      this.queue.push(frame)
    }
  }

  /** Called when either side closes — drains all waiters with a rejection. */
  _closeInbound(): void {
    this.closed = true
    const err = new Error('channel closed')
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(err)
    }
  }

  send(frame: Uint8Array): void {
    if (this.closed) return
    this._peer._enqueue(frame)
  }

  recv(): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('channel closed'))
    const next = this.queue.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  close(): void {
    if (this.closed) return
    this._closeInbound()
    this._peer._closeInbound()
  }

  // Assigned immediately after construction — safe to assert non-null.
  _peer!: SimChannelSide
}

/**
 * Create a pair of in-memory `SecureChannel`s wired crosswise.
 * Each `send()` on one side enqueues to the other's inbound FIFO; `recv()`
 * returns the next frame or awaits until one arrives.
 *
 * Closing either side closes both: all pending and future `recv()`s reject
 * with `Error('channel closed')`. This is the deterministic test transport,
 * the channel analogue of {@link SimMesh}.
 */
export function createSimChannelPair(): [SecureChannel, SecureChannel] {
  const a = new SimChannelSide()
  const b = new SimChannelSide()
  a._peer = b
  b._peer = a
  return [a, b]
}
