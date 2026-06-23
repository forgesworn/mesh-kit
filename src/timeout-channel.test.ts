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

  it('does not drop a frame that arrives after a recv timeout (frame-safe)', async () => {
    vi.useFakeTimers()
    // A FIFO channel: a delivered frame resolves the OLDEST pending recv (like the
    // real channel's waiter queue). A wrapper that abandons its recv on timeout
    // would lose this frame and desync a Noise stream layered above.
    const queue: Uint8Array[] = []
    const waiters: Array<(f: Uint8Array) => void> = []
    const channel: SecureChannel = {
      send() {},
      recv() {
        return new Promise<Uint8Array>((res) => {
          const f = queue.shift()
          if (f) res(f)
          else waiters.push(res)
        })
      },
      close() {},
    }
    const deliver = (f: Uint8Array): void => {
      const w = waiters.shift()
      if (w) w(f)
      else queue.push(f)
    }

    const c = withRecvTimeout(channel, 1000)
    // Attach the rejection assertion BEFORE advancing the clock so the timeout
    // rejection is never momentarily unhandled.
    const first = c.recv()
    const firstAssertion = expect(first).rejects.toThrow('recv timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await firstAssertion

    // The frame arrives now, on the still-pending underlying recv; the NEXT recv()
    // must receive it rather than hang.
    const second = c.recv()
    deliver(new Uint8Array([7, 7, 7]))
    await expect(second).resolves.toEqual(new Uint8Array([7, 7, 7]))
  })
})
