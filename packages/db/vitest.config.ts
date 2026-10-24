import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
    // occupancy property test size; Phase 0 acceptance needs 10⁵ operations (§15)
    provide: { occRuns: Number(process.env.OCC_RUNS ?? 200), occOps: Number(process.env.OCC_OPS ?? 500) },
  },
});
