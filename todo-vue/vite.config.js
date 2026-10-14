import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// /api is proxied to the Laravel app, so the browser never needs CORS.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:8000' },
  },
});
