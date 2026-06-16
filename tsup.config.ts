import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    friendli: "src/provider/friendli/friendli.ts",
    openrouter: "src/provider/openrouter/openrouter.ts",
    wafer: "src/provider/wafer/wafer.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  treeshake: true,
  clean: true,
  sourcemap: true,
});

// With package.json "type":"module", tsup emits:
//   dist/index.js      dist/index.cjs      dist/index.d.ts
//   dist/friendli.js   dist/friendli.cjs   dist/friendli.d.ts
//   dist/openrouter.js dist/openrouter.cjs dist/openrouter.d.ts
//   dist/wafer.js      dist/wafer.cjs      dist/wafer.d.ts
