// Source-component browser fixtures, bound locally with no API proxy or file-change reloads.
// Start with: node scripts/acceptance/review-dev-server.mjs
// Then run: node scripts/acceptance/workspace-interactions.cjs
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const server = await createServer({
  configFile: false,
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1', port: Number(process.env.TICKGROVE_REVIEW_PORT || 18894), strictPort: true,
    watch: null, hmr: { overlay: false }, forwardConsole: false,
  },
});
await server.listen();
server.printUrls();
