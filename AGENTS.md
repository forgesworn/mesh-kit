# AGENTS.md — mesh-kit

Instructions in this file apply to the entire repository.

## Project Summary

- Transport-agnostic encrypted offline-mesh substrate: a `MeshTransport` interface, a hand-rolled `Noise_XX_25519_ChaChaPoly_SHA256` `SecureChannel`, store-and-forward reliability/reconciliation, a generic two-lane bridge, and deterministic in-memory sims for tests.
- Extracted from [`meatchat`](https://github.com/forgesworn/meatchat), where it is the shared floor under the Toll payment rail and the single-bit matcher.
- ESM-only package (`"type": "module"`), single export path (no subpaths).
- Requires Node.js 18+ (CI currently builds and tests on Node 24).
- Minimal dependencies: `@noble/curves`, `@noble/ciphers`, `@noble/hashes` — audited, zero-dependency, ESM-native, and already transitive deps of the crypto stack this repo shares with sibling kits.

## Key Commands

- `npm run build` — compile TypeScript into `dist/`
- `npm test` — run the Vitest suite
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run tests with coverage (per-file thresholds in `vitest.config.ts`)
- `npm run typecheck` — TypeScript type-check without emitting

## Repository Structure

- `src/mesh.ts` — `MeshFrame` / `MeshTransport` core interfaces (no runtime code, no test file)
- `src/sim-mesh.ts` — `SimMesh`, deterministic in-memory mesh for tests
- `src/mesh-buffer.ts` — bounded, TTL-limited retention and manifest reconciliation primitives
- `src/mesh-reliability.ts` — `withMeshReliability`: policy-driven store-and-forward adapter, `meshScopedToken`
- `src/mesh-bridge.ts` — `MeshBridgeWire`, `SeenFrameIds`, `connectMeshBridge`, `withBridgedFrames`: generic two-lane gateway
- `src/channel.ts` — `SecureChannel` interface, `createSimChannelPair`
- `src/mesh-channel.ts` — `meshChannel`, the `MeshTransport` → `SecureChannel` adapter
- `src/timeout-channel.ts` — `withRecvTimeout`, per-call recv timeout wrapper
- `src/noise-channel.ts` — `connectNoise`, `NoiseError`: Noise_XX handshake over `@noble` primitives
- `src/index.ts` — barrel re-export (no test file; nothing here isn't already tested at its source module)
- `compatibility-vectors/` — frozen fixtures locking behaviour: `flock-mesh-buffer-v1.json` (mesh-buffer semantics extracted from Flock), `mesh-reliability-v1.json` (reconciliation control-frame shapes)
- `dist/` — build output (generated)

Each `src/*.ts` implementation file has a co-located `*.test.ts`, except `mesh.ts` (pure interfaces) and `index.ts` (barrel).

## Coding Conventions

- Use British English spelling in identifiers and prose: `licence`, `colour`, `behaviour`.
- Keep the substrate transport-agnostic and use-case-agnostic: discovery, routing policy, frame vocabulary (any `MeshFrame.kind` beyond the reserved `'channel'` and `'mesh-kit/sync/v1'`), and environment configuration stay with the consuming application — don't let product concerns leak into this package.
- Preserve the minimal-dependency approach (`@noble/*` only) unless the user explicitly asks otherwise.
- Prefer TDD when changing behaviour: add or update a failing test first, then implement.
- Maintain ESM-compatible imports/exports — internal imports use explicit `.js` extensions (`Node16` module resolution).
- Treat `src/noise-channel.ts`, and the untrusted-input parsers in `src/mesh-reliability.ts` (manifest/offer parsing) and `src/mesh-bridge.ts` (`unwrap`), as security-sensitive: every decoder must stay total (malformed/hostile input returns `null` or a typed error, never a thrown low-level exception or partial plaintext).
- Never break a frozen compatibility vector under `compatibility-vectors/*.json` without an explicit, deliberate decision — they lock Flock's original mesh-buffer behaviour and the reconciliation control-frame shapes that ride the reserved `mesh-kit/sync/v1` kind.

## Working Guidelines

- Do not edit generated output in `dist/` by hand unless the user explicitly asks for it.
- Prefer targeted tests for the area being changed before broader validation (`npm test` runs the whole suite fast — under a second — so there's little cost to running it all regardless).
- Update documentation (`README.md`, `llms.txt`, this file, `CLAUDE.md`) when public API or behaviour changes.
- Reserving a new `MeshFrame.kind` string is a protocol-level decision — treat it like a breaking change and consider whether it needs its own compatibility vector.
- Per-file coverage thresholds in `vitest.config.ts` are pinned to measured coverage (rounded down for headroom) on `channel.ts`, `mesh-channel.ts`, `noise-channel.ts`, `sim-mesh.ts` and `timeout-channel.ts` — don't lower them to make a change pass; explain any newly-uncovered branch in a comment instead.

## Release Notes

- Conventional commit prefixes matter for releases: `fix:` for patch, `feat:` for minor, and `BREAKING CHANGE:` for major.
- Tests should pass before release-related changes are considered complete.
