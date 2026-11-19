import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { PORTS } from '@traceops/contracts';

export function apiTarget(env: Record<string, string | undefined> = process.env): string {
  return env.VITE_API_TARGET || `http://localhost:${PORTS.traceopsApi}`;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORTS.traceopsUi,
    strictPort: true,
    // VITE_API_TARGET=http://localhost:4100 for the dev API (scripts/dev-api-run.ts); default is the real app.
    proxy: { '/api': apiTarget() },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
