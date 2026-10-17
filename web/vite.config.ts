import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // three.js is one lazy chunk of about 530 kB (135 kB gzipped), loaded behind the loader.
  build: { chunkSizeWarningLimit: 600 },
  define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)) },
});
