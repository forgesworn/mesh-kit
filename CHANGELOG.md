# Changelog

## 0.1.1 - 2026-07-18

- Extract mesh-kit from Meatchat — transport-agnostic encrypted offline-mesh substrate.
- Expose the Noise channel binding (handshake hash) for relay-resistant app-layer auth.
- Fix `withRecvTimeout` to keep the underlying recv in flight across timeouts (no dropped frame on idle).
- Add store-and-forward mesh reliability.
- Add a generic two-lane mesh bridge.
- Pin git installs to reproducible commit references.
