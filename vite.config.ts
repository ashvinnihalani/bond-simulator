import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves project sites under /<repo>/; the deploy workflow sets VITE_BASE.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 5000,
  },
  worker: { format: "es" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
