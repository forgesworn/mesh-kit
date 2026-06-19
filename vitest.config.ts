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
        // channel.ts:34 (`_enqueue` closed-guard) is defensively unreachable via the public API —
        // close() is symmetric (closes both sides), so nothing enqueues into a closed side. Hence 94, not 95.
        'src/channel.ts': { lines: 100, branches: 94, functions: 100, statements: 100 },
        'src/mesh-channel.ts': { lines: 100, branches: 95, functions: 100, statements: 100 },
        'src/noise-channel.ts': { lines: 98, branches: 88, functions: 95, statements: 98 },
        'src/sim-mesh.ts': { lines: 90, branches: 90, functions: 100, statements: 90 },
        'src/timeout-channel.ts': { lines: 95, branches: 90, functions: 100, statements: 95 }
      }
    }
  }
})
