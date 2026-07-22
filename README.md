# mesh-kit

**Nostr:** [`npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`](https://njump.me/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

**Transport-agnostic encrypted offline-mesh substrate — a `MeshTransport` interface, a hand-rolled `Noise_XX` `SecureChannel`, store-and-forward reliability, and deterministic in-memory sims for tests.**

[![CI](https://github.com/forgesworn/mesh-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/forgesworn/mesh-kit/actions)
[![licence](https://img.shields.io/badge/Licence-MIT-blue.svg)](https://github.com/forgesworn/mesh-kit/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-native-blue)](https://www.typescriptlang.org/)
[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/TheCryptoDonkey?logo=githubsponsors&color=ea4aaa&label=Sponsor)](https://github.com/sponsors/TheCryptoDonkey)

A small, dependency-light building block for **offline, peer-to-peer apps** (BLE mesh, LAN, sim). It carries opaque frames between nodes and lets any consumer run an authenticated, encrypted, in-order byte channel over them — without the transport knowing anything about the application.

ESM-only, target ES2022, `Node16` module resolution. British English throughout.

Extracted from a production Nostr application for reuse across ForgeSworn projects.

## Why mesh-kit?

- **Transport-agnostic** — carries opaque `MeshFrame`s between nodes; discovery, routing policy, frame vocabulary and environment configuration all stay with the consuming application.
- **A real encrypted channel, not just framing** — `Noise_XX_25519_ChaChaPoly_SHA256` implemented directly over audited `@noble` primitives (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) — no bespoke or heavyweight Noise dependency. Total on hostile input: malformed or forged frames surface as a single `NoiseError`, never partial plaintext.
- **Store-and-forward without a bespoke buffer per product** — bounded, TTL-limited retention plus manifest reconciliation (`withMeshReliability`) lets independently verifiable frames catch up over a lossy mesh, with class-aware expiry/priority/replace-by-key and room-scoped inventory tokens.
- **A generic two-lane bridge** — `connectMeshBridge` joins a local lane and a wide lane (e.g. BLE mesh + Nostr relay) while frame policy, metrics and lane lifecycle stay with the application.
- **Deterministic tests** — `SimMesh` and `createSimChannelPair` give in-memory, synchronous stand-ins for the transport and the secure channel, so consumer test suites never need real BLE/network I/O.
- **Production-hardened parsers** — every control-frame decoder (`mesh-reliability`'s manifest/offer parsing, `mesh-bridge`'s envelope `unwrap`) is total: malformed or hostile input is rejected rather than thrown.
- **57 tests** across 8 files, with per-file coverage gates pinned to measured coverage on the channel/Noise-adjacent files.

## Install

```bash
npm install mesh-kit
```

## Quick Start

```typescript
import { SimMesh, meshChannel, connectNoise, withRecvTimeout } from 'mesh-kit'

const mesh = new SimMesh()
const alice = mesh.node('alice')
const bob = mesh.node('bob')

// A directed, in-order byte channel each way, then an encrypted one on top:
const aliceChannel = withRecvTimeout(meshChannel(alice, 'bob'), 5000)
const bobChannel = withRecvTimeout(meshChannel(bob, 'alice'), 5000)

const [aliceSecure, bobSecure] = await Promise.all([
  connectNoise(aliceChannel, { initiator: true }),
  connectNoise(bobChannel, { initiator: false }),
])

aliceSecure.send(new TextEncoder().encode('hello'))
await bobSecure.recv() // Uint8Array decoding to 'hello'
```

## The `kind` is opaque — consumers own their vocabulary

The transport carries `MeshFrame.kind` as a **plain string** and never enumerates application message types. Each consumer owns its own frame vocabulary and filters on it:

- the `meshChannel` adapter **reserves the single kind `'channel'`** for the bytes of a `SecureChannel`, and the recv path filters on both `from === peerId` **and** `kind === 'channel'` — so a channel and an application rail (e.g. a payment rail emitting `'offer'`/`'grant'` frames) can share one `MeshTransport` instance without collision;
- `withMeshReliability` reserves `'mesh-kit/sync/v1'` for its own manifest/offer control frames, which never reach application subscribers;
- everything else is the consumer's to define.

This is the seam that keeps the substrate use-case-agnostic.

## Store-and-forward reliability

`createMeshBuffer`, `rememberMeshFrame`, `meshManifest` and `reconcileMeshManifests` provide bounded, TTL-limited retention and manifest reconciliation for lossy transports. Frames remain opaque `MeshFrame` values; the consumer supplies the stable id used for deduplication.

```typescript
import { createMeshBuffer, rememberMeshFrame, meshManifest, reconcileMeshManifests, meshFramesFor } from 'mesh-kit'

const now = () => Math.floor(Date.now() / 1000)

let mine = createMeshBuffer()
mine = rememberMeshFrame(mine, { id: 'msg-1', frame: { kind: 'chat', payload: 'hi' } }, now())
const theirs = createMeshBuffer() // peer has not seen msg-1 yet

const { toSend } = reconcileMeshManifests(meshManifest(mine, now()), meshManifest(theirs, now()))
// toSend = ['msg-1']
const offers = meshFramesFor(mine, toSend) // frames to send the peer
```

### `withMeshReliability`

`withMeshReliability` is the bounded adapter: it retains only frames admitted by the product policy, exchanges paged manifests with a known peer and offers the missing frames while preserving their original author. Per-frame expiry, priority and replace-by-key metadata let products distinguish ephemeral presence, durable encrypted work and safety alerts without building parallel buffers. `meshScopedToken` can hide a stable id behind a room-scoped SHA-256 token; it prevents raw-id disclosure and cross-room linking, but is **not** an authenticity proof.

Defaults (all overridable via `MeshReliabilityOptions`): 200 max manifest entries, 24 ids per manifest page, 64 offers per reconciliation round, a 10-second per-peer sync cooldown, and a 15-second incomplete-manifest assembly TTL.

Do not retain an ordered `channel`/Noise byte stream frame-by-frame unless the application also supplies sequence recovery and acknowledgements. Products should default handshakes and live channel frames to no retention, then put durable encrypted messages in an application envelope with its own id, expiry and acknowledgement semantics. The adapter does not choose hop limits, discovery identifiers, frame kinds or lane policy.

### Compatibility vectors

Flock's original behaviour is frozen in `compatibility-vectors/flock-mesh-buffer-v1.json`: duplicates do not extend a frame's lifetime, the exact TTL boundary expires, and the oldest frame is evicted when capacity is exceeded.

The additive reconciliation control shapes are frozen in `compatibility-vectors/mesh-reliability-v1.json`. They ride the reserved `mesh-kit/sync/v1` kind and never reach application subscribers.

These are regression fixtures guarding this package's own behaviour over time, not a cross-language compatibility contract — see `src/mesh-buffer.test.ts` and `src/mesh-reliability.test.ts` for how they're exercised.

## The bridge

The bridge core owns mechanics rather than product policy. `MeshBridgeWire` receives the consumer's reserved kind and byte codec; `connectMeshBridge` receives forwarding and throttle functions plus clocks and TTL values; `withBridgedFrames` is the lighter single-lane edge shim for directed traffic that needs to traverse a bridge without joining two full lanes. Relay URLs, metrics, environment detection, room policy and lane lifecycle all stay with the application.

## Reliability assumption

`meshChannel` and the Noise channel assume the transport delivers frames to a named peer **reliably and in order** (as `SimMesh` does). The Noise spec (§5.1/§11.4) and any 2PC running over the channel require that. `withMeshReliability` improves eventual delivery for independently verifiable application frames; it does not turn an unordered/lossy byte stream into an ordered channel. A product that needs durable encrypted messaging must add message-level sequencing, acknowledgements and retry above the secure channel.

## Security posture

The `Noise_XX` channel is implemented directly over audited `@noble` primitives (`@noble/curves` x25519, `@noble/ciphers` ChaCha20-Poly1305, `@noble/hashes` SHA-256/HMAC/HKDF) — no bespoke or heavyweight Noise dependency. It is written to be **total** on hostile input: malformed handshake or forged transport frames surface as a single `NoiseError`, never partial plaintext, and any decrypt failure terminates the session in both directions. As with the rest of the offline crypto stack, **no privacy claim ships before the third-party crypto audit.**

## API Reference

### Transport & sim

| Export | Description |
|---|---|
| `MeshTransport` | `{ broadcast(frame), send(peer, frame), subscribe(handler) → { close() } }` |
| `MeshFrame` | `{ kind: string; payload: unknown; from?: string }` |
| `SimMesh` | Deterministic in-memory mesh for tests; `.node(id)` → `MeshTransport` |

### Store-and-forward (`mesh-buffer`)

| Export | Description |
|---|---|
| `MESH_BUFFER_DEFAULTS` | `{ maxEntries: 200, ttlSeconds: 900 }` |
| `createMeshBuffer()` | New empty `MeshBufferState` |
| `rememberMeshFrame(state, entry, now, options?)` | Retain a frame after pruning; an unexpired duplicate is a no-op |
| `pruneMeshBuffer(state, now, options?)` | Drop expired entries (exclusive TTL boundary) |
| `liveMeshFrames(state, now, options?)` | Live retained frames, oldest first |
| `meshManifest(state, now, options?)` | Sorted id list for reconciliation |
| `reconcileMeshManifests(mine, theirs)` | `{ toSend, toRequest }` |
| `meshFramesFor(state, ids)` | Resolve ids to retained frames, skipping any since expired/evicted |

### Reliability adapter (`mesh-reliability`)

| Export | Description |
|---|---|
| `withMeshReliability(options)` | Bounded store-and-forward adapter over any `MeshTransport` → `RunningMeshReliability` |
| `meshScopedToken(scope, value)` | Room-scoped SHA-256 token; hides a stable id in manifest traffic |
| `MESH_SYNC_KIND` | `'mesh-kit/sync/v1'` — the reserved control-frame kind |

`RunningMeshReliability` extends `MeshTransport` with `sync(peer)`, `retained()`, `stats()` and `close()`.

### Bridge (`mesh-bridge`)

| Export | Description |
|---|---|
| `MeshBridgeWire` | Wire codec for one consumer-selected bridge kind: `frameId`, `freshId`, `wrap`, `unwrap` |
| `SeenFrameIds` | Bounded first-sight TTL cache: `check(id)`, `.size` |
| `connectMeshBridge(options)` | Joins a local lane and a wide lane → `RunningMeshBridge` (`stats()`, `close()`) |
| `withBridgedFrames(transport, selfId, options)` | Single-lane edge shim → `RunningBridgeEdge` |

### Secure channel

| Export | Description |
|---|---|
| `SecureChannel` | `{ send(frame), recv(): Promise<Uint8Array>, close() }` |
| `createSimChannelPair()` | Two in-memory `SecureChannel`s wired crosswise |
| `meshChannel(transport, peerId)` | Point-to-point `SecureChannel` over a `MeshTransport`; reserves `kind: 'channel'` |
| `withRecvTimeout(channel, ms)` | Each `recv()` rejects after `ms` if idle; never drops a frame that arrives late |

### Noise handshake

| Export | Description |
|---|---|
| `connectNoise(underlying, opts)` | Runs `Noise_XX_25519_ChaChaPoly_SHA256` → `Promise<NoiseSecureChannel>` |
| `NoiseSecureChannel` | `SecureChannel` + `readonly binding: Uint8Array` (handshake transcript hash) |
| `NoiseError` | Single error type for every Noise failure |
| `KeyPair` | `{ secretKey: Uint8Array; publicKey: Uint8Array }` |

## Why not a Noise library dependency?

The `Noise_XX_25519_ChaChaPoly_SHA256` handshake (`src/noise-channel.ts`) is written directly over the already-installed `@noble/curves`, `@noble/ciphers` and `@noble/hashes` rather than adding a dedicated Noise Protocol dependency:

- **noise-protocol / noise-handshake / simple-handshake** (holepunchto family) — CommonJS only, no ESM exports; break under this repo's `Node16` module resolution.
- **@chainsafe/libp2p-noise** — ESM, but bundles the entire libp2p abstraction stack (13 dependencies, 1.2 MB unpacked), with its Noise state machine entangled in libp2p `Connection`/`PeerId` types. Extracting just the XX cryptography isn't cleaner than writing it from scratch over noble.
- **noise-c.wasm** — WASM, complex build, far heavier than needed.

Implementing Noise_XX over already-installed noble primitives is ~150 lines, spec-compliant ([revision 34](https://noiseprotocol.org/noise.html)), and adds no new dependency to the tree.

## Development

```bash
npm install        # @noble/* only
npm test           # vitest, per-file coverage gates
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
```

## Runtime Compatibility

Requires Node.js 18+ (the `engines` field); CI currently builds and tests on Node 24. The cryptography runs on `@noble/curves`, `@noble/ciphers` and `@noble/hashes` — pure TypeScript, no native bindings — so the Noise layer has no Node-specific dependency. The one runtime touchpoint outside `@noble/*` is the global Web Crypto `crypto.getRandomValues()` (used for round/frame id generation in `mesh-reliability` and `mesh-bridge`), which is a standard global in Node 18+, browsers, Deno and Bun.

## For AI Assistants

See [llms.txt](./llms.txt) for a concise, machine-readable API summary.

## Part of the ForgeSworn Toolkit

[ForgeSworn](https://forgesworn.dev) builds open-source cryptographic identity, payments, and coordination tools for Nostr.

| Library | What it does |
|---------|-------------|
| [nsec-tree](https://github.com/forgesworn/nsec-tree) | Deterministic sub-identity derivation |
| [ring-sig](https://github.com/forgesworn/ring-sig) | SAG/LSAG ring signatures on secp256k1 |
| [range-proof](https://github.com/forgesworn/range-proof) | Pedersen commitment range proofs |
| [canary-kit](https://github.com/forgesworn/canary-kit) | Coercion-resistant spoken verification |
| [spoken-token](https://github.com/forgesworn/spoken-token) | Human-speakable verification tokens |
| [toll-booth](https://github.com/forgesworn/toll-booth) | L402 payment middleware |
| [geohash-kit](https://github.com/forgesworn/geohash-kit) | Geohash toolkit with polygon coverage |
| [mesh-kit](https://github.com/forgesworn/mesh-kit) | Transport-agnostic encrypted offline-mesh substrate |
| [nostr-attestations](https://github.com/forgesworn/nostr-attestations) | NIP-VA verifiable attestations |
| [dominion](https://github.com/forgesworn/dominion) | Epoch-based encrypted access control |
| [rendezvous-kit](https://github.com/forgesworn/rendezvous-kit) | Fair meeting point discovery using isochrones |
| [nostr-veil](https://github.com/forgesworn/nostr-veil) | Privacy-preserving Web of Trust |

## Licence

[MIT](https://github.com/forgesworn/mesh-kit/blob/main/LICENSE)

## Support

For issues and feature requests, see [GitHub Issues](https://github.com/forgesworn/mesh-kit/issues).

If you find mesh-kit useful, consider sending a tip:

- **Lightning:** `profusemeat89@walletofsatoshi.com`
- **Nostr zaps:** `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`
