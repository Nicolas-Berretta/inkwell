import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Single-user local app: one bundle is fine, so the default 500 kB advisory is raised.
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
