# AGENTS.md: mesh-kit

Instructions in this file apply to the entire repository.

## Project Summary

- Transport-agnostic encrypted offline-mesh substrate: a `MeshTransport` interface, a hand-rolled `Noise_XX_25519_ChaChaPoly_SHA256` `SecureChannel`, store-and-forward reliability/reconciliation, a generic two-lane bridge, and deterministic in-memory sims for tests.
- Extracted from a production Nostr application for reuse across ForgeSworn projects.
- ESM-only package (`"type": "module"`), single export path (no subpaths, `package.json` `exports` has only `"."`).
- Requires Node.js 18+ (CI currently builds and tests on Node 24).
- Minimal dependencies: `@noble/curves`, `@noble/ciphers`, `@noble/hashes`: audited, zero-dependency, ESM-native, and already transitive deps of the crypto stack this repo shares with sibling kits.

## Key Commands

- `npm run build`: compile TypeScript into `dist/`
- `npm test`: run the Vitest suite
- `npm run test:watch`: run tests in watch mode
- `npm run test:coverage`: run tests with coverage (per-file thresholds in `vitest.config.ts`)
- `npm run typecheck`: TypeScript type-check without emitting

## Repository Structure

- `src/mesh.ts`: `MeshFrame` / `MeshTransport` core interfaces (no runtime code, no test file)
- `src/sim-mesh.ts`: `SimMesh`, deterministic in-memory mesh for tests
- `src/mesh-buffer.ts`: bounded, TTL-limited retention and manifest reconciliation primitives
- `src/mesh-reliability.ts`: `withMeshReliability`: policy-driven store-and-forward adapter, `meshScopedToken`
- `src/mesh-bridge.ts`: `MeshBridgeWire`, `SeenFrameIds`, `connectMeshBridge`, `withBridgedFrames`: generic two-lane gateway
- `src/channel.ts`: `SecureChannel` interface, `createSimChannelPair`
- `src/mesh-channel.ts`: `meshChannel`, the `MeshTransport` to `SecureChannel` adapter
- `src/timeout-channel.ts`: `withRecvTimeout`, per-call recv timeout wrapper
- `src/noise-channel.ts`: `connectNoise`, `NoiseError`: Noise_XX handshake over `@noble` primitives
- `src/index.ts`: barrel re-export (no test file; nothing here isn't already tested at its source module)
- `compatibility-vectors/`: frozen fixtures locking behaviour: `flock-mesh-buffer-v1.json` (mesh-buffer semantics extracted from Flock), `mesh-reliability-v1.json` (reconciliation control-frame shapes)
- `dist/`: build output (generated)

Each `src/*.ts` implementation file has a co-located `*.test.ts`, except `mesh.ts` (pure interfaces) and `index.ts` (barrel).

## Exports

Single export path, no subpaths:

- **Transport**: `MeshTransport`, `MeshFrame`, `SimMesh`
- **Store-and-forward**: `createMeshBuffer`, `rememberMeshFrame`, `pruneMeshBuffer`, `liveMeshFrames`, `meshManifest`, `meshFramesFor`, `reconcileMeshManifests`, `MESH_BUFFER_DEFAULTS`
- **Reliability adapter**: `withMeshReliability`, `meshScopedToken`, `MESH_SYNC_KIND`
- **Bridge**: `MeshBridgeWire`, `SeenFrameIds`, `connectMeshBridge`, `withBridgedFrames`
- **Secure channel**: `SecureChannel`, `createSimChannelPair`, `meshChannel`, `withRecvTimeout`
- **Noise handshake**: `connectNoise`, `NoiseError`, `KeyPair`, `NoiseSecureChannel`, `ConnectNoiseOpts`

See `llms.txt` for full signatures and the README for the API reference tables.

## Security-Critical Paths

Be extra careful when modifying:

- `src/noise-channel.ts`: the Noise_XX handshake and transport cipher state; any change must keep `recv()` total on hostile input (a `NoiseError`, never partial plaintext) and keep both directions closing on decrypt failure.
- `src/mesh-reliability.ts`: `parseManifest`/`parseOffer` decode untrusted control-frame payloads; they must keep rejecting malformed input as `null` rather than throwing, and `handleOffer` must keep enforcing that a peer cannot bypass product retention policy.
- `src/mesh-bridge.ts`: `MeshBridgeWire.unwrap` decodes untrusted bridge envelopes; must stay total (`null` on malformed input), and the wide/local loop guards (self-origin checks, `SeenFrameIds`) must keep preventing echo loops.

## Coding Conventions

- Use British English spelling in identifiers and prose: `licence`, `colour`, `behaviour`.
- Keep the substrate transport-agnostic and use-case-agnostic: discovery, routing policy, frame vocabulary (any `MeshFrame.kind` beyond the reserved `'channel'` and `'mesh-kit/sync/v1'`), and environment configuration stay with the consuming application; don't let product concerns leak into this package.
- Preserve the minimal-dependency approach (`@noble/*` only) unless the user explicitly asks otherwise.
- Prefer TDD when changing behaviour: add or update a failing test first, then implement.
- Maintain ESM-compatible imports/exports: internal imports use explicit `.js` extensions (`Node16` module resolution).
- Treat `src/noise-channel.ts`, and the untrusted-input parsers in `src/mesh-reliability.ts` (manifest/offer parsing) and `src/mesh-bridge.ts` (`unwrap`), as security-sensitive: every decoder must stay total (malformed/hostile input returns `null` or a typed error, never a thrown low-level exception or partial plaintext).
- Never break a frozen compatibility vector under `compatibility-vectors/*.json` without an explicit, deliberate decision: they lock Flock's original mesh-buffer behaviour and the reconciliation control-frame shapes that ride the reserved `mesh-kit/sync/v1` kind.
- **Git:** commit messages use `type: description` format.
- **Git:** do NOT include `Co-Authored-By` lines in commits.

## Working Guidelines

- Do not edit generated output in `dist/` by hand unless the user explicitly asks for it.
- Prefer targeted tests for the area being changed before broader validation (`npm test` runs the whole suite fast, under a second, so there's little cost to running it all regardless).
- Update documentation (`README.md`, `llms.txt`, this file, `CLAUDE.md`) when public API or behaviour changes.
- Reserving a new `MeshFrame.kind` string is a protocol-level decision: treat it like a breaking change and consider whether it needs its own compatibility vector.
- Per-file coverage thresholds in `vitest.config.ts` are pinned to measured coverage (rounded down for headroom) on `channel.ts`, `mesh-channel.ts`, `noise-channel.ts`, `sim-mesh.ts` and `timeout-channel.ts`: don't lower them to make a change pass; explain any newly-uncovered branch in a comment instead.

## Release Notes

- Conventional commit prefixes matter for releases: `fix:` for patch, `feat:` for minor, and `BREAKING CHANGE:` for major.
- No release automation yet: the only workflow is `.github/workflows/ci.yml` (typecheck, test, build, `npm pack --dry-run` on push/PR to `main`/`dev`/`feat/**`/`fix/**`/`chore/**`). There is no `anvil` integration and no OIDC-based publish workflow in this repo. Releases are fully manual:
  1. Bump `package.json` version by hand (e.g. `0.2.0` to `0.3.0`)
  2. Add a `CHANGELOG.md` entry under the new version heading
  3. Commit (`chore: release 0.3.0`), push main
  4. Tag the commit (`git tag v0.3.0 && git push --tags`) and run `npm publish` by hand; `prepublishOnly` (`npm run typecheck && npm test && npm run build`) is the local pre-publish gate
- Semver rules of thumb:

  | Change | Bump |
  |---|---|
  | Bug fix, no API change | Patch (0.2.x) |
  | New feature, backwards compatible | Minor (0.x.0) |
  | Breaking API change | Major (currently pre-1.0, so a minor bump per semver's 0.x convention) |
  | Tooling, docs, refactor with no behaviour change | Patch or none |

- Tests should pass before release-related changes are considered complete.
- Changing anything under `compatibility-vectors/*.json` is a behavioural decision, not a docs change: treat it with the same care as a breaking API change.
