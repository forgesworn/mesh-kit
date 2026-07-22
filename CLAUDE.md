# CLAUDE.md — mesh-kit

Transport-agnostic encrypted offline-mesh substrate — a `MeshTransport` interface, a Noise_XX `SecureChannel`, reliability/reconciliation, a two-lane bridge, and deterministic in-memory sims for tests.

## Commands

- `npm run build` — compile TypeScript to dist/
- `npm test` — run all tests (vitest)
- `npm run test:watch` — watch mode
- `npm run test:coverage` — coverage report (per-file thresholds in `vitest.config.ts`)
- `npm run typecheck` — type-check without emitting

## Structure

- `src/mesh.ts` — `MeshFrame`, `MeshTransport` core interfaces
- `src/sim-mesh.ts` — `SimMesh`, deterministic in-memory mesh for tests
- `src/mesh-buffer.ts` — bounded, TTL-limited retention and manifest reconciliation
- `src/mesh-reliability.ts` — `withMeshReliability`, policy-driven store-and-forward adapter
- `src/mesh-bridge.ts` — `MeshBridgeWire`, `SeenFrameIds`, `connectMeshBridge`, `withBridgedFrames`
- `src/channel.ts` — `SecureChannel` interface, `createSimChannelPair`
- `src/mesh-channel.ts` — `meshChannel`, MeshTransport → SecureChannel adapter
- `src/timeout-channel.ts` — `withRecvTimeout`, per-call recv timeout
- `src/noise-channel.ts` — `connectNoise`, `Noise_XX_25519_ChaChaPoly_SHA256` handshake
- `src/index.ts` — barrel re-export

## Exports

Single export path — no subpaths (`package.json` `exports` has only `"."`):

- **Transport** — `MeshTransport`, `MeshFrame`, `SimMesh`
- **Store-and-forward** — `createMeshBuffer`, `rememberMeshFrame`, `pruneMeshBuffer`, `liveMeshFrames`, `meshManifest`, `meshFramesFor`, `reconcileMeshManifests`, `MESH_BUFFER_DEFAULTS`
- **Reliability adapter** — `withMeshReliability`, `meshScopedToken`, `MESH_SYNC_KIND`
- **Bridge** — `MeshBridgeWire`, `SeenFrameIds`, `connectMeshBridge`, `withBridgedFrames`
- **Secure channel** — `SecureChannel`, `createSimChannelPair`, `meshChannel`, `withRecvTimeout`
- **Noise handshake** — `connectNoise`, `NoiseError`, `KeyPair`, `NoiseSecureChannel`, `ConnectNoiseOpts`

See `llms.txt` for full signatures and the README for the API reference tables.

## Security-Critical Paths

Be extra careful when modifying:

- `src/noise-channel.ts` — the Noise_XX handshake and transport cipher state; any change must keep `recv()` total on hostile input (a `NoiseError`, never partial plaintext) and keep both directions closing on decrypt failure.
- `src/mesh-reliability.ts` — `parseManifest`/`parseOffer` decode untrusted control-frame payloads; they must keep rejecting malformed input as `null` rather than throwing, and `handleOffer` must keep enforcing that a peer cannot bypass product retention policy.
- `src/mesh-bridge.ts` — `MeshBridgeWire.unwrap` decodes untrusted bridge envelopes; must stay total (`null` on malformed input), and the wide/local loop guards (self-origin checks, `SeenFrameIds`) must keep preventing echo loops.

## Conventions

- **British English** — licence, colour, behaviour
- **Minimal dependencies** — `@noble/curves`, `@noble/ciphers`, `@noble/hashes` only (audited, zero-dependency, ESM-native); no runtime deps beyond those
- **ESM-only** — `"type": "module"` in package.json, `Node16` module resolution (internal imports use explicit `.js` extensions)
- **TDD** — write a failing test first, then implement
- **Git:** commit messages use `type: description` format
- **Git:** Do NOT include `Co-Authored-By` lines in commits

## Release & Versioning

No release automation yet — the only workflow is `.github/workflows/ci.yml` (typecheck, test, build, `npm pack --dry-run` on push/PR to `main`/`dev`/`feat/**`/`fix/**`/`chore/**`). There is no `anvil` integration and no OIDC-based publish workflow in this repo. Releases are fully manual:

1. Bump `package.json` version by hand (e.g. `0.2.0` → `0.3.0`)
2. Add a `CHANGELOG.md` entry under the new version heading
3. Commit (`chore: release 0.3.0`), push main
4. Tag the commit (`git tag v0.3.0 && git push --tags`) and run `npm publish` by hand — `prepublishOnly` (`npm run typecheck && npm test && npm run build`) is the local pre-publish gate

Semver rules of thumb:

| Change | Bump |
|---|---|
| Bug fix, no API change | Patch (0.2.x) |
| New feature, backwards compatible | Minor (0.x.0) |
| Breaking API change | Major (currently pre-1.0, so a minor bump per semver's 0.x convention) |
| Tooling, docs, refactor with no behaviour change | Patch or none |

Changing anything under `compatibility-vectors/*.json` is a behavioural decision, not a docs change — treat it with the same care as a breaking API change.
