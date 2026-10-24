// Pure package: plain Node is enough. It uses only `node:crypto` createHash, which Workers provide with nodejs_compat.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
