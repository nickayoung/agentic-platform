// Vite build for kairos-console: the Cloudflare plugin runs the SSR environment in workerd, TanStack Start
// generates the route tree from src/routes, and React comes last (§19.14).
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 3000 },
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(), viteReact()],
});
