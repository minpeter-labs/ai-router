import { defineConfig } from "tsup";

// TypeScript 7 ships a native `tsc` and no longer exports the classic
// compiler JS API that tsup's rollup-plugin-dts depends on. JS bundles stay
// here; declaration emit is handled by `tsc -p tsconfig.build.json`.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    friendli: "src/provider/friendli/friendli.ts",
    opengateway: "src/provider/opengateway/opengateway.ts",
    openrouter: "src/provider/openrouter/openrouter.ts",
    wafer: "src/provider/wafer/wafer.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  treeshake: true,
  clean: true,
  sourcemap: true,
});
