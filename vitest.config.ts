import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // mesh.ts is pure interfaces (no runtime); index.ts is a barrel re-export.
      exclude: ['dist/**', 'src/index.ts', 'src/mesh.ts'],
      thresholds: {
        // Per-file gates — pinned to actual measured coverage (rounded down ~1pp for fragility headroom).
        // Re-baselined for vitest 4's v8 provider, which remaps coverage through the AST
        // (ast-v8-to-istanbul) and counts statements/branches more strictly than vitest 2 did —
        // same tests, same code, stricter measurement. The defensively-unreachable paths this exposes
        // are channel.ts:34 (`_enqueue` closed-guard — close() is symmetric, so nothing enqueues into a
        // closed side) and noise-channel.ts:138,198 (handshake error paths).
        'src/channel.ts': { lines: 100, branches: 90, functions: 100, statements: 96 },
        'src/mesh-channel.ts': { lines: 100, branches: 92, functions: 100, statements: 96 },
        'src/noise-channel.ts': { lines: 98, branches: 75, functions: 95, statements: 95 },
        'src/sim-mesh.ts': { lines: 90, branches: 90, functions: 100, statements: 90 },
        'src/timeout-channel.ts': { lines: 95, branches: 90, functions: 100, statements: 95 }
      }
    }
  }
})
