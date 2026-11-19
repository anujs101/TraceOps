import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { PORTS } from '@traceops/contracts';

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORTS.traceopsUi,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${PORTS.traceopsApi}` },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
