import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    friendli: "src/provider/friendli/friendli.ts",
    opengateway: "src/provider/opengateway/opengateway.ts",
    openrouter: "src/provider/openrouter/openrouter.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  treeshake: true,
  clean: true,
  sourcemap: true,
});
