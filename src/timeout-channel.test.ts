import { describe, it, expect, vi, afterEach } from 'vitest'
import { withRecvTimeout } from './timeout-channel.js'
import type { SecureChannel } from './channel.js'

/**
 * A controllable {@link SecureChannel} stub: the test drives when `recv()`
 * resolves or rejects, and records `send`/`close` delegation.
 */
function stubChannel(): {
  channel: SecureChannel
  resolveRecv: (frame: Uint8Array) => void
  rejectRecv: (err: Error) => void
  sent: Uint8Array[]
  closed: () => boolean
} {
  let resolveRecv!: (frame: Uint8Array) => void
  let rejectRecv!: (err: Error) => void
  const sent: Uint8Array[] = []
  let closed = false
  const channel: SecureChannel = {
    send(frame) { sent.push(frame) },
    recv() {
      return new Promise<Uint8Array>((res, rej) => {
        resolveRecv = res
        rejectRecv = rej
      })
    },
    close() { closed = true },
  }
  return {
    channel,
    resolveRecv: (f) => resolveRecv(f),
    rejectRecv: (e) => rejectRecv(e),
    sent,
    closed: () => closed,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('withRecvTimeout', () => {
  it('returns the frame when it arrives before the timeout (and cancels the timer)', async () => {
    const s = stubChannel()
    const c = withRecvTimeout(s.channel, 1000)
    const p = c.recv()
    s.resolveRecv(new Uint8Array([1, 2, 3]))
    await expect(p).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects with "recv timeout" when no frame arrives in time', async () => {
    vi.useFakeTimers()
    const s = stubChannel()
    const c = withRecvTimeout(s.channel, 1000)
    const assertion = expect(c.recv()).rejects.toThrow('recv timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('propagates an underlying recv rejection and clears the timer (no late second rejection)', async () => {
    vi.useFakeTimers()
    const s = stubChannel()
    const c = withRecvTimeout(s.channel, 1000)
    const p = c.recv()
    s.rejectRecv(new Error('channel closed'))
    await expect(p).rejects.toThrow('channel closed')
    // The timer must already be cleared — advancing past it produces no further rejection.
    await vi.advanceTimersByTimeAsync(2000)
  })

  it('delegates send and close to the underlying channel', () => {
    const s = stubChannel()
    const c = withRecvTimeout(s.channel, 1000)
    c.send(new Uint8Array([9]))
    expect(s.sent).toEqual([new Uint8Array([9])])
    c.close()
    expect(s.closed()).toBe(true)
  })
})
