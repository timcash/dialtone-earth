import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        "auth-globe": resolve(import.meta.dirname, "src/auth-globe.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === "auth-globe" ? "auth-globe.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
