/**
 * `withRecvTimeout` — wraps a {@link SecureChannel} so every `recv()` call
 * races the underlying promise against a wall-clock timer.
 *
 * If a frame arrives before the timer fires, it is returned normally and the
 * timer is cancelled immediately (no leaked handle). If the timer fires first,
 * the timer is also cleared and the promise rejects with
 * `new Error('recv timeout')`. The timeout is per-call: each `recv()` gets a
 * fresh timer of `ms` milliseconds.
 *
 * `send` and `close` are delegated unchanged. The wrapper is use-case-agnostic:
 * it knows nothing about the matching protocol and can wrap any SecureChannel.
 */

import type { SecureChannel } from './channel.js'

/**
 * Wrap `channel` so every `recv()` rejects after `ms` milliseconds if no
 * frame arrives. Timers are always cleared — on resolve AND on reject — so no
 * `setTimeout` handle is ever left dangling.
 *
 * @param channel - The underlying channel to wrap.
 * @param ms      - Receive timeout in milliseconds. Must be a positive finite number.
 */
export function withRecvTimeout(channel: SecureChannel, ms: number): SecureChannel {
  return {
    send(frame: Uint8Array): void {
      channel.send(frame)
    },

    recv(): Promise<Uint8Array> {
      return new Promise<Uint8Array>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined

        const clearTimer = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
        }

        timer = setTimeout(() => {
          timer = undefined
          reject(new Error('recv timeout'))
        }, ms)

        channel.recv().then(
          (frame) => {
            clearTimer()
            resolve(frame)
          },
          (err: unknown) => {
            clearTimer()
            reject(err)
          },
        )
      })
    },

    close(): void {
      channel.close()
    },
  }
}
