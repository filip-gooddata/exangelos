import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  clearScreen: false,
  build: { outDir: "dist", emptyOutDir: true },
})
