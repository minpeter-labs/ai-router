import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entries = [
  ["@minpeter/ai-router", "createRouter"],
  ["@minpeter/ai-router", "createFusion"],
  ["@minpeter/ai-router/friendli", "createFriendli"],
  ["@minpeter/ai-router/fusion", "createFusion"],
  ["@minpeter/ai-router/opengateway", "createOpenGateway"],
  ["@minpeter/ai-router/openrouter", "createOpenRouter"],
  ["@minpeter/ai-router/wafer", "createWafer"],
];

for (const [specifier, exportName] of entries) {
  const esm = await import(specifier);
  const cjs = require(specifier);
  if (typeof esm[exportName] !== "function") {
    throw new Error(`${specifier} ESM export ${exportName} is unavailable`);
  }
  if (typeof cjs[exportName] !== "function") {
    throw new Error(`${specifier} CJS export ${exportName} is unavailable`);
  }
}
