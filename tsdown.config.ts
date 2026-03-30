import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  clean: true,
  dts: false,
  fixedExtension: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
