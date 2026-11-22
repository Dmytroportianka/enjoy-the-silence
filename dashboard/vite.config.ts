import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend stack: React + Vite + Tailwind 4.
const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
