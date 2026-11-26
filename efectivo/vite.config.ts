// Vite config for efectivo ARENA (a separate entry from Kong Royale): `npm run efectivo` serves it on port 5320 and
// proxies the game socket to efectivo/server.ts on port 3030; `npm run efectivo:build` writes efectivo/dist.

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const target = `http://127.0.0.1:${process.env.EF_PORT || 3030}`;

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  server: {
    port: 5320,
    strictPort: true,
    proxy: {
      "/efws": { target: target.replace("http", "ws"), ws: true },
      "/efectivo/health": { target },
    },
  },
  preview: { port: 5321, proxy: { "/efws": { target: target.replace("http", "ws"), ws: true }, "/efectivo/health": { target } } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
