/**
 * Noise_XX_25519_ChaChaPoly_SHA256 SecureChannel
 *
 * Library choice: NO new dependency — implemented directly over the already-installed
 * `@noble/curves` (x25519), `@noble/ciphers` (chacha20poly1305), and `@noble/hashes`
 * (sha256, hmac, hkdf). These audited, zero-dependency, ESM-native packages are
 * transitive deps already present in node_modules.
 *
 * Why not a dedicated Noise library?
 *   - `noise-protocol`, `noise-handshake`, `simple-handshake` (holepunchto family):
 *     CJS only, no ESM exports — break under Node16 moduleResolution in this repo.
 *   - `@chainsafe/libp2p-noise`: ESM, but bundles the entire libp2p abstraction stack
 *     (13 dependencies, 1.2 MB unpacked) and its Noise state machine is entangled with
 *     libp2p Connection/PeerId types. Extracting just the XX cryptography is not cleaner
 *     than writing it from scratch over noble.
 *   - `noise-c.wasm`: WASM, complex build, far heavier.
 *
 * Implementing Noise_XX over noble primitives is ~150 lines, spec-compliant, and leaves
 * no new dependency in the tree.
 *
 * Spec reference: https://noiseprotocol.org/noise.html (revision 34)
 * Pattern XX (both parties authenticate static keys):
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import type { SecureChannel } from './channel.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export interface ConnectNoiseOpts {
  initiator: boolean
  /** Optional static keypair. A fresh ephemeral Curve25519 pair is generated if omitted. */
  staticKeyPair?: KeyPair
}

/**
 * Single error type for every Noise failure — handshake parse errors, malformed
 * frames, and transport authentication failures all surface as a `NoiseError`.
 * This keeps the channel total: callers see one clean error type, never a raw
 * `@noble` length/tag exception.
 */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoiseError'
  }
}

/** Throw a clean NoiseError if `frame` is shorter than `min` bytes. */
function requireLength(frame: Uint8Array, min: number, what: string): void {
  if (frame.length < min) {
    throw new NoiseError(`Noise: malformed ${what} — expected ≥${min} bytes, got ${frame.length}`)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256'
const PROTOCOL_NAME_BYTES = new TextEncoder().encode(PROTOCOL_NAME)

// Maximum nonce value before cipher state is exhausted (§5.1)
const NONCE_MAX = BigInt('0xffffffffffffffff')

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

function dhKeyPair(): KeyPair {
  return x25519.keygen()
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey)
}

// ---------------------------------------------------------------------------
// Hash / HMAC helpers (§4)
// ---------------------------------------------------------------------------

function hashFn(data: Uint8Array): Uint8Array {
  return sha256(data)
}

function hmacHash(key: Uint8Array, ...data: Uint8Array[]): Uint8Array {
  return hmac(sha256, key, concat(...data))
}

/**
 * HKDF-SHA256 yielding two 32-byte outputs (Noise §4: HKDF(ck, input, 2)).
 * The Noise spec defines HKDF as:
 *   temp_key = HMAC-HASH(chaining_key, input)
 *   output1  = HMAC-HASH(temp_key, 0x01)
 *   output2  = HMAC-HASH(temp_key, output1 || 0x02)
 */
function hkdf2(ck: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmacHash(ck, input)
  const out1 = hmacHash(temp, new Uint8Array([0x01]))
  const out2 = hmacHash(temp, out1, new Uint8Array([0x02]))
  return [out1, out2]
}

// ---------------------------------------------------------------------------
// CipherState (§5.1)
// ---------------------------------------------------------------------------

class CipherState {
  private k: Uint8Array | null = null
  private n = 0n // 64-bit nonce counter

  initializeKey(key: Uint8Array): void {
    this.k = key.slice(0, 32)
    this.n = 0n
  }

  hasKey(): boolean { return this.k !== null }

  /**
   * Noise_XX with ChaChaPoly: encode the 64-bit nonce as a 96-bit IETF ChaCha20
   * nonce — 4 zero bytes (little-endian 32-bit 0) followed by 8 bytes LE nonce.
   */
  private nonceBytes(): Uint8Array {
    if (this.n >= NONCE_MAX) throw new Error('Noise: nonce exhausted')
    const nonce = new Uint8Array(12)
    let v = this.n
    for (let i = 4; i < 12; i++) {
      nonce[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return nonce
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext // no key: pass-through (pre-handshake)
    const cipher = chacha20poly1305(this.k, this.nonceBytes(), ad)
    const ciphertext = cipher.encrypt(plaintext)
    this.n++
    return ciphertext
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext // no key: pass-through (pre-handshake)
    // A valid ChaChaPoly frame is at least the 16-byte tag; reject shorter inputs
    // cleanly rather than letting @noble throw its own length error.
    if (ciphertext.length < 16) {
      throw new NoiseError('Noise: decryption failed — frame shorter than authentication tag')
    }
    const cipher = chacha20poly1305(this.k, this.nonceBytes(), ad)
    try {
      const plaintext = cipher.decrypt(ciphertext)
      this.n++
      return plaintext
    } catch {
      // §5.1: on failure the nonce MUST NOT increment; the channel is unusable.
      // Callers (handshake + transport) MUST terminate the session on this error.
      throw new NoiseError('Noise: decryption failed — authentication tag mismatch')
    }
  }
}

// ---------------------------------------------------------------------------
// SymmetricState (§5.2)
// ---------------------------------------------------------------------------

class SymmetricState {
  private ck: Uint8Array
  private h: Uint8Array
  private cs = new CipherState()

  constructor() {
    // h = protocol_name if len ≤ HASHLEN, else HASH(protocol_name)
    if (PROTOCOL_NAME_BYTES.length <= 32) {
      this.h = new Uint8Array(32)
      this.h.set(PROTOCOL_NAME_BYTES)
    } else {
      this.h = hashFn(PROTOCOL_NAME_BYTES)
    }
    this.ck = this.h.slice()
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, inputKeyMaterial)
    this.ck = ck
    this.cs.initializeKey(k.slice(0, 32))
  }

  mixHash(data: Uint8Array): void {
    this.h = hashFn(concat(this.h, data))
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cs.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cs.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  /** §5.2 Split() — returns [cs1, cs2]: initiator-send/responder-recv, responder-send/initiator-recv */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0))
    const cs1 = new CipherState()
    const cs2 = new CipherState()
    cs1.initializeKey(k1)
    cs2.initializeKey(k2)
    return [cs1, cs2]
  }
}

// ---------------------------------------------------------------------------
// Handshake — Noise_XX (§5.3 + §7)
// ---------------------------------------------------------------------------

/**
 * Execute the XX handshake over `underlying`. Returns directional CipherStates
 * for the transport phase.
 *
 * XX token sequence:
 *   msg1 I→R: e
 *   msg2 R→I: e, ee, s, es
 *   msg3 I→R: s, se
 */
async function runHandshake(
  underlying: SecureChannel,
  initiator: boolean,
  staticKP: KeyPair,
): Promise<{ send: CipherState; recv: CipherState }> {
  const ss = new SymmetricState()
  const localStatic = staticKP
  const localEphemeral = dhKeyPair()

  // MixHash with prologue (empty — no transport binding needed for PoC)
  ss.mixHash(new Uint8Array(0))

  if (initiator) {
    // ---- msg1: -> e ----
    ss.mixHash(localEphemeral.publicKey)
    underlying.send(localEphemeral.publicKey) // 32 bytes

    // ---- msg2: <- e, ee, s, es ----
    const msg2 = await underlying.recv()
    // Layout: e_pub(32) | ENCRYPT(s_pub)(32+16=48) | ENCRYPT(payload)(0+16=16) = 96 bytes
    requireLength(msg2, 32 + 48 + 16, 'handshake msg2')
    let off = 0
    const remoteEphemeralPub = msg2.slice(off, off + 32); off += 32
    ss.mixHash(remoteEphemeralPub)
    ss.mixKey(dh(localEphemeral.secretKey, remoteEphemeralPub)) // MixKey(ee)
    const sEnc = msg2.slice(off, off + 48); off += 48
    const remoteStaticPub = ss.decryptAndHash(sEnc) // s: decrypt 48 bytes → 32 bytes
    ss.mixKey(dh(localEphemeral.secretKey, remoteStaticPub)) // MixKey(es): initiator ephemeral × responder static
    const payload2 = msg2.slice(off) // empty payload (encrypted as 16-byte tag)
    ss.decryptAndHash(payload2)

    // ---- msg3: -> s, se ----
    const sEnc3 = ss.encryptAndHash(localStatic.publicKey) // 32 + 16 = 48 bytes
    ss.mixKey(dh(localStatic.secretKey, remoteEphemeralPub)) // MixKey(se): initiator static × responder ephemeral
    const payload3 = ss.encryptAndHash(new Uint8Array(0)) // empty payload → 16-byte tag
    underlying.send(concat(sEnc3, payload3))

    const [cs1, cs2] = ss.split()
    return { send: cs1, recv: cs2 }

  } else {
    // ---- msg1: <- e ----
    const msg1 = await underlying.recv()
    // Layout: e_pub(32)
    requireLength(msg1, 32, 'handshake msg1')
    const remoteEphemeralPub = msg1.slice(0, 32)
    ss.mixHash(remoteEphemeralPub)

    // ---- msg2: -> e, ee, s, es ----
    ss.mixHash(localEphemeral.publicKey)
    ss.mixKey(dh(localEphemeral.secretKey, remoteEphemeralPub)) // MixKey(ee)
    const sEnc2 = ss.encryptAndHash(localStatic.publicKey) // 48 bytes
    ss.mixKey(dh(localStatic.secretKey, remoteEphemeralPub)) // MixKey(es): responder static × initiator ephemeral
    const payload2 = ss.encryptAndHash(new Uint8Array(0)) // 16-byte tag
    underlying.send(concat(localEphemeral.publicKey, sEnc2, payload2))

    // ---- msg3: <- s, se ----
    const msg3 = await underlying.recv()
    // Layout: ENCRYPT(s_pub)(32+16=48) | ENCRYPT(payload)(0+16=16) = 64 bytes
    requireLength(msg3, 48 + 16, 'handshake msg3')
    let off3 = 0
    const sEnc3 = msg3.slice(off3, off3 + 48); off3 += 48
    const remoteStaticPub = ss.decryptAndHash(sEnc3) // s
    ss.mixKey(dh(localEphemeral.secretKey, remoteStaticPub)) // MixKey(se): responder ephemeral × initiator static
    const payload3 = msg3.slice(off3)
    ss.decryptAndHash(payload3) // empty payload

    const [cs1, cs2] = ss.split()
    return { send: cs2, recv: cs1 }
  }
}

// ---------------------------------------------------------------------------
// NoiseChannel (transport phase) — implements SecureChannel
// ---------------------------------------------------------------------------

class NoiseChannel implements SecureChannel {
  private closed = false

  constructor(
    private readonly underlying: SecureChannel,
    private readonly sendCs: CipherState,
    private readonly recvCs: CipherState,
  ) {}

  send(frame: Uint8Array): void {
    if (this.closed) return
    const ciphertext = this.sendCs.encryptWithAd(new Uint8Array(0), frame)
    this.underlying.send(ciphertext)
  }

  async recv(): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('channel closed'))
    const ciphertext = await this.underlying.recv()
    try {
      // Any decryption failure propagates as a rejection — never leaks plaintext.
      return this.recvCs.decryptWithAd(new Uint8Array(0), ciphertext)
    } catch (err) {
      // §5.1/§11.4: Noise assumes a reliable, in-order, lossless transport. A failed
      // or forged frame means the stream is irrecoverably desynchronised (the receive
      // nonce did NOT advance while the peer's send nonce did). Terminate the session
      // in BOTH directions so a poisoned channel can never silently desync: after this,
      // every send() is a no-op and every recv() rejects with 'channel closed'.
      this.close()
      throw err
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.underlying.close()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Noise_XX_25519_ChaChaPoly_SHA256 handshake over `underlying` and
 * return a new `SecureChannel` whose `send`/`recv` encrypt/decrypt application
 * frames with the established transport keys.
 *
 * The handshake authenticates both peers' static keys (XX pattern). If no
 * `staticKeyPair` is supplied, an ephemeral Curve25519 pair is generated.
 *
 * The returned channel is total on tampered input: `recv()` rejects with a
 * `NoiseError` on bad/short/forged ciphertext — never returning partial plaintext
 * and never throwing synchronously. Per the Noise spec (§5.1/§11.4), any decrypt
 * failure terminates the session in BOTH directions: after one failure every
 * subsequent `send()` is a no-op and every `recv()` rejects, so a poisoned channel
 * can never silently desynchronise.
 *
 * Malformed handshake messages (truncated frames) also reject with a `NoiseError`
 * rather than a raw `@noble` length exception.
 */
export async function connectNoise(
  underlying: SecureChannel,
  opts: ConnectNoiseOpts,
): Promise<SecureChannel> {
  const staticKP = opts.staticKeyPair ?? dhKeyPair()
  let send: CipherState
  let recv: CipherState
  try {
    ;({ send, recv } = await runHandshake(underlying, opts.initiator, staticKP))
  } catch (err) {
    // Normalise every handshake failure — DH errors (low-order keys, wrong-length
    // public bytes), malformed/truncated handshake frames, and decrypt failures —
    // to a single typed NoiseError. Callers see one clean error type, never a raw
    // `@noble` throw or a `NoiseError` already raised inside runHandshake (which
    // we pass through as-is to preserve the message).
    if (err instanceof NoiseError) throw err
    const wrapped = new NoiseError(
      `Noise: handshake failed — ${err instanceof Error ? err.message : String(err)}`,
    )
    wrapped.cause = err
    throw wrapped
  }
  return new NoiseChannel(underlying, send, recv)
}
