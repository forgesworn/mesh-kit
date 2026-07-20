# mesh-kit

Transport-agnostic mesh primitives. Applications own discovery, routing policy,
frame vocabulary and environment configuration.

## Store-and-forward reliability

`createMeshBuffer`, `rememberMeshFrame`, `meshManifest` and
`reconcileMeshManifests` provide bounded, TTL-limited retention and manifest
reconciliation for lossy transports. Frames remain opaque `MeshFrame` values;
the consumer supplies the stable id used for deduplication.

`withMeshReliability` is the bounded adapter: it retains only frames admitted by
the product policy, exchanges paged manifests with a known peer and offers the
missing frames while preserving their original author. Per-frame expiry,
priority and replace-by-key metadata let products distinguish ephemeral
presence, durable encrypted work and safety alerts without building parallel
buffers. `meshScopedToken` can hide a stable id behind a room-scoped SHA-256
token; it prevents raw-id disclosure and cross-room linking, but is not an
authenticity proof.

Do not retain an ordered `channel`/Noise byte stream frame-by-frame unless the
application also supplies sequence recovery and acknowledgements. Products
should default handshakes and live channel frames to no retention, then put
durable encrypted messages in an application envelope with its own id, expiry
and acknowledgement semantics. The adapter does not choose hop limits,
discovery identifiers, frame kinds or lane policy.

Flock's original behaviour is frozen in
`compatibility-vectors/flock-mesh-buffer-v1.json`: duplicates do not extend a
frame's lifetime, the exact TTL boundary expires, and the oldest frame is
evicted when capacity is exceeded.

The additive reconciliation control shapes are frozen in
`compatibility-vectors/mesh-reliability-v1.json`. They ride the reserved
`mesh-kit/sync/v1` kind and never reach application subscribers.

The bridge core similarly owns mechanics rather than product policy.
`MeshBridgeWire` receives the consumer's reserved kind and byte codec;
`connectMeshBridge` receives forwarding and throttle functions plus clocks and
TTL values. Relay URLs, metrics, environment detection, room policy and lane
lifecycle stay with the application.

> Transport-agnostic encrypted offline-mesh substrate — a `MeshTransport` interface, a `Noise_XX` `SecureChannel`, and deterministic in-memory sims for tests.

A small, dependency-light building block for **offline, peer-to-peer apps** (BLE mesh, LAN, sim). It carries opaque frames between nodes and lets any consumer run an authenticated, encrypted, in-order byte channel over them — without the transport knowing anything about the application.

Extracted from [`meatchat`](https://github.com/forgesworn/meatchat), where it is the shared floor under the Toll payment rail and the single-bit matcher. See the meatchat **library-extraction map** for the rationale.

## What's in it

| Export | What |
|--------|------|
| `MeshTransport` | The node's view of the mesh: `broadcast` / `send(peer, …)` / `subscribe`. **Presence is implicit — receiving a frame proves range.** |
| `MeshFrame` | `{ kind: string; payload: unknown; from?: string }`. `kind` is **opaque** to the transport (see below). |
| Mesh-buffer functions | Bounded retention, TTL pruning, deduplication and manifest reconciliation for store-and-forward adapters. |
| `withMeshReliability`, `meshScopedToken` | Class-aware volatile retention plus bounded, paged peer reconciliation with room-scoped inventory tokens. |
| `MeshBridgeWire`, `SeenFrameIds` | Injected bridge envelope codec plus bounded first-sight deduplication. |
| `connectMeshBridge`, `withBridgedFrames` | Generic two-lane gateway and single-lane edge shim; consumers inject kinds, clocks, throttles and forwarding policy. |
| `SimMesh` | Deterministic in-memory mesh for tests — hands out per-node `MeshTransport` views. |
| `SecureChannel` | Ordered, authenticated, encrypted byte duplex: `send` / `recv` / `close`. |
| `createSimChannelPair` | Two in-memory `SecureChannel`s wired crosswise (the channel analogue of `SimMesh`). |
| `meshChannel(transport, peerId)` | Adapter: a point-to-point `SecureChannel` over a `MeshTransport`, directed at one peer. |
| `connectNoise(underlying, opts)` | Runs the `Noise_XX_25519_ChaChaPoly_SHA256` handshake over a `SecureChannel` and returns an encrypted one. Total on tampered input (`NoiseError`). |
| `withRecvTimeout(channel, ms)` | Wraps a `SecureChannel` so each `recv()` rejects after `ms` if no frame arrives. |

## The `kind` is opaque — consumers own their vocabulary

The transport carries `MeshFrame.kind` as a **plain string** and never enumerates application message types. Each consumer owns its own frame vocabulary and filters on it:

- the `meshChannel` adapter **reserves the single kind `'channel'`** for the bytes of a `SecureChannel`, and the recv path filters on both `from === peerId` **and** `kind === 'channel'` — so a channel and an application rail (e.g. a payment rail emitting `'offer'`/`'grant'` frames) can share one `MeshTransport` instance without collision;
- everything else is the consumer's to define.

This is the seam that keeps the substrate use-case-agnostic.

## Reliability assumption

`meshChannel` and the Noise channel assume the transport delivers frames to a named peer **reliably and in order** (as `SimMesh` does). The Noise spec (§5.1/§11.4) and any 2PC running over the channel require that. `withMeshReliability` improves eventual delivery for independently verifiable application frames; it does not turn an unordered/lossy byte stream into an ordered channel. A product that needs durable encrypted messaging must add message-level sequencing, acknowledgements and retry above the secure channel.

## Security posture

The `Noise_XX` channel is implemented directly over audited `@noble` primitives (`@noble/curves` x25519, `@noble/ciphers` ChaCha20-Poly1305, `@noble/hashes` SHA-256/HMAC/HKDF) — no bespoke or heavyweight Noise dependency. It is written to be **total** on hostile input: malformed handshake or forged transport frames surface as a single `NoiseError`, never partial plaintext, and any decrypt failure terminates the session in both directions. As with the rest of the offline crypto stack, **no privacy claim ships before the third-party crypto audit.**

## Use

```bash
npm install        # @noble/* only
npm test           # vitest, per-file coverage gates
npm run build      # tsc → dist/
```

```ts
import { SimMesh, meshChannel, connectNoise, withRecvTimeout } from 'mesh-kit'

const mesh = new SimMesh()
const a = mesh.node('alice'), b = mesh.node('bob')

// A directed, in-order byte channel, then an encrypted one on top:
const chan = withRecvTimeout(meshChannel(a, 'bob'), 5000)
const secure = await connectNoise(chan, { initiator: true })
secure.send(new TextEncoder().encode('hello'))
```

> ESM-only, target ES2022, Node16 module resolution. British English throughout.
