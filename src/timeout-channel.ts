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
 * **Frame-safety across timeouts.** A timed-out `recv()` does NOT abandon the
 * underlying receive: the single in-flight `channel.recv()` is kept and reused by
 * the next `recv()` call. So a frame that arrives *after* a timeout is delivered
 * to the next caller, never silently dropped. This matters because a dropped
 * frame would desync a Noise stream layered above (the engine wraps the raw mesh
 * channel with this BEFORE `connectNoise`, and the post-match §8 reveal flow keeps
 * recv-ing over that very channel long after the 30 s handshake bound).
 *
 * `send` and `close` are delegated unchanged. The wrapper is use-case-agnostic:
 * it knows nothing about the matching protocol and can wrap any SecureChannel.
 */

import type { SecureChannel } from './channel.js'

/**
 * Wrap `channel` so every `recv()` rejects after `ms` milliseconds if no
 * frame arrives — without ever dropping a frame that arrives later. Timers are
 * always cleared (on resolve AND reject) so no `setTimeout` handle is left
 * dangling.
 *
 * @param channel - The underlying channel to wrap.
 * @param ms      - Receive timeout in milliseconds. Must be a positive finite number.
 */
export function withRecvTimeout(channel: SecureChannel, ms: number): SecureChannel {
  // The single underlying recv() in flight, shared across timed-out callers so its
  // eventual frame is never lost. Released (set back to null) once it settles, so
  // the next fresh recv() starts a new underlying receive.
  let inflight: Promise<Uint8Array> | null = null

  return {
    send(frame: Uint8Array): void {
      channel.send(frame)
    },

    recv(): Promise<Uint8Array> {
      const under = inflight ?? (inflight = channel.recv())
      const release = (): void => {
        if (inflight === under) inflight = null
      }
      under.then(release, release)

      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('recv timeout')), ms)
        under.then(
          (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
          (err: unknown) => {
            clearTimeout(timer)
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
