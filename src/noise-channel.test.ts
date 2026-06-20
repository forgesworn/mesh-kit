import { describe, it, expect } from 'vitest'
import { createSimChannelPair } from './channel.js'
import { connectNoise, NoiseError } from './noise-channel.js'
import type { SecureChannel } from './channel.js'

/**
 * Wrap one side of a SimChannel pair so that `recv()` can transform inbound
 * frames before they reach the Noise layer. `transform(frame, recvIndex)` is
 * called with a 1-based count of how many frames have been received so far and
 * returns the (possibly altered) frame to deliver.
 *
 * XX handshake recv() ordering on the *initiator's* underlying channel:
 *   recvIndex 1 = handshake msg2 (must stay clean to complete the handshake)
 *   recvIndex 2 = first application transport frame
 */
function tamperRecv(
  side: SecureChannel,
  transform: (frame: Uint8Array, recvIndex: number) => Uint8Array,
): SecureChannel {
  let recvIndex = 0
  return {
    send: side.send.bind(side),
    recv: async (): Promise<Uint8Array> => {
      const frame = await side.recv()
      recvIndex++
      return transform(frame, recvIndex)
    },
    close: side.close.bind(side),
  }
}

function flipAll(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length)
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] ^ 0xff
  return out
}

describe('NoiseChannel', () => {
  it('XX handshake then authenticated encrypted transport', async () => {
    const [t0, t1] = createSimChannelPair()
    const [initiator, responder] = await Promise.all([
      connectNoise(t0, { initiator: true }),
      connectNoise(t1, { initiator: false }),
    ])
    initiator.send(new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(await responder.recv())).toBe('hello')
  })

  it('tampered transport ciphertext fails with a clean NoiseError — no plaintext, no crash', async () => {
    const [pairI, pairR] = createSimChannelPair()

    // Corrupt the first application transport frame the initiator receives
    // (recvIndex 2; recvIndex 1 is the clean handshake msg2).
    const tamperI = tamperRecv(pairI, (frame, i) => (i === 2 ? flipAll(frame) : frame))

    const [noiseInitiator, noiseResponder] = await Promise.all([
      connectNoise(tamperI, { initiator: true }),
      connectNoise(pairR, { initiator: false }),
    ])

    noiseResponder.send(new TextEncoder().encode('secret payload'))

    // recv() must reject with a NoiseError — not return corrupted/partial plaintext.
    await expect(noiseInitiator.recv()).rejects.toBeInstanceOf(NoiseError)
  })

  it('after one auth failure the channel is dead in BOTH directions (no silent desync)', async () => {
    const [pairI, pairR] = createSimChannelPair()

    // Corrupt only the FIRST application frame the initiator receives.
    const tamperI = tamperRecv(pairI, (frame, i) => (i === 2 ? flipAll(frame) : frame))

    const [noiseInitiator, noiseResponder] = await Promise.all([
      connectNoise(tamperI, { initiator: true }),
      connectNoise(pairR, { initiator: false }),
    ])

    // Responder sends frame A → initiator receives a forged version → recv rejects.
    noiseResponder.send(new TextEncoder().encode('frame A'))
    await expect(noiseInitiator.recv()).rejects.toBeInstanceOf(NoiseError)

    // Responder now sends a perfectly CLEAN frame B.
    noiseResponder.send(new TextEncoder().encode('frame B'))

    // The session is poisoned: a subsequent recv() must reject (the receive nonce
    // is desynced from the sender's), NOT decrypt frame B against the wrong nonce.
    await expect(noiseInitiator.recv()).rejects.toThrow('channel closed')

    // And the reverse direction must be dead too: the initiator's send() is a no-op,
    // so the responder never receives anything more. We assert nothing leaks by
    // confirming a send does not throw and the responder's queue stays empty.
    noiseInitiator.send(new TextEncoder().encode('should never arrive'))
    // A recv() on the responder would block forever if the channel were truly dead;
    // instead we close and assert the responder recv rejects (proving no frame queued).
    noiseResponder.close()
    await expect(noiseResponder.recv()).rejects.toThrow('channel closed')
  })

  it('a short/garbage transport frame rejects cleanly (NoiseError, no raw @noble throw)', async () => {
    const [pairI, pairR] = createSimChannelPair()

    // Replace the first application transport frame with a 3-byte garbage frame,
    // shorter than the 16-byte ChaChaPoly tag.
    const tamperI = tamperRecv(pairI, (frame, i) =>
      i === 2 ? new Uint8Array([1, 2, 3]) : frame,
    )

    const [noiseInitiator, noiseResponder] = await Promise.all([
      connectNoise(tamperI, { initiator: true }),
      connectNoise(pairR, { initiator: false }),
    ])

    noiseResponder.send(new TextEncoder().encode('real frame'))

    const err = await noiseInitiator.recv().then(
      () => { throw new Error('expected rejection') },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NoiseError)
    // Must be our clean message, not @noble's '"ciphertext" expected length ...'.
    expect((err as Error).message).toMatch(/Noise: decryption failed/)
  })

  it('a truncated handshake message rejects cleanly (NoiseError, no crash)', async () => {
    const [pairI, pairR] = createSimChannelPair()

    // Truncate the responder's handshake msg2 (the first frame the initiator
    // receives, recvIndex 1) to 10 bytes — far short of the required 96.
    const tamperI = tamperRecv(pairI, (frame, i) => (i === 1 ? frame.slice(0, 10) : frame))

    // The responder's handshake will complete its writes; the initiator's must
    // reject when it tries to parse the truncated msg2.
    const responderPromise = connectNoise(pairR, { initiator: false })
    await expect(connectNoise(tamperI, { initiator: true })).rejects.toBeInstanceOf(NoiseError)

    // Tidy up the responder side so the test does not leak a pending promise.
    pairR.close()
    await responderPromise.catch(() => {})
  })

  it('Adjacent: hostile/garbage first handshake frame rejects with NoiseError, not a raw @noble throw', async () => {
    // Feed an all-zeros 32-byte frame as msg1 (the initiator's ephemeral public key).
    // An all-zeros Curve25519 public key is a low-order point; x25519.getSharedSecret
    // throws on it. connectNoise must catch this inside runHandshake and rethrow as
    // a NoiseError — never surfacing a raw @noble error to the caller.
    const [pairI, pairR] = createSimChannelPair()

    // Responder receives a garbage msg1 (all-zeros ephemeral pub from the initiator).
    const tamperR = tamperRecv(pairR, (frame, i) =>
      i === 1 ? new Uint8Array(32) /* all-zeros = low-order / degenerate */ : frame,
    )

    const initiatorPromise = connectNoise(pairI, { initiator: true })
    const responderResult = await connectNoise(tamperR, { initiator: false }).then(
      () => null,
      (e: unknown) => e,
    )

    // The responder must reject with a NoiseError (not a raw @noble error).
    expect(responderResult).toBeInstanceOf(NoiseError)

    // Clean up the initiator side.
    pairI.close()
    await initiatorPromise.catch(() => {})
  })

  // ---------------------------------------------------------------------------
  // Channel binding (handshake hash)
  // ---------------------------------------------------------------------------

  it('both ends of a handshake expose an identical 32-byte binding (channel binding)', async () => {
    const [t0, t1] = createSimChannelPair()
    const [initiator, responder] = await Promise.all([
      connectNoise(t0, { initiator: true }),
      connectNoise(t1, { initiator: false }),
    ])

    // Both channels must carry a `binding` property.
    expect('binding' in initiator).toBe(true)
    expect('binding' in responder).toBe(true)

    const a = (initiator as { binding: Uint8Array }).binding
    const b = (responder as { binding: Uint8Array }).binding

    // Must be exactly 32 bytes (SHA-256 output).
    expect(a).toBeInstanceOf(Uint8Array)
    expect(b).toBeInstanceOf(Uint8Array)
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)

    // Both peers must share the identical final transcript hash.
    expect(a).toEqual(b)
  })

  it('two independent handshakes produce different bindings (transcript-specific, not a constant)', async () => {
    const [t0a, t1a] = createSimChannelPair()
    const [t0b, t1b] = createSimChannelPair()

    const [[chA], [chB]] = await Promise.all([
      Promise.all([
        connectNoise(t0a, { initiator: true }),
        connectNoise(t1a, { initiator: false }),
      ]),
      Promise.all([
        connectNoise(t0b, { initiator: true }),
        connectNoise(t1b, { initiator: false }),
      ]),
    ])

    const bindingA = (chA as { binding: Uint8Array }).binding
    const bindingB = (chB as { binding: Uint8Array }).binding

    // Independent handshakes (fresh ephemeral key pairs) must differ.
    expect(bindingA).not.toEqual(bindingB)
  })
})
