import { describe, expect, it } from "vitest";
import {
  exportTargets,
  validateExportTargets,
  validateJavaScriptArtifactSize,
  validateNoCredential,
  validateSourceMap,
  validateTarballPaths,
} from "../scripts/package-artifact-validation.mjs";

const VALID_MAP = {
  version: 3,
  sources: ["../src/index.ts"],
  sourcesContent: ["export const value = 1;"],
};
const ABSENT_TARGET_RE = /absent from tarball/;
const CREDENTIAL_RE = /credential-shaped value/;
const INVALID_EXPORTS_RE = /invalid or oversized/;
const INVALID_MAP_RE = /non-source build input/;
const NON_CANONICAL_RE = /not canonical/;
const UNEXPECTED_ENTRY_RE = /unexpected npm tarball entry/;
const SIZE_BUDGET_RE = /size budget/;

describe("package artifact validation", () => {
  it("accepts the intended package surface", () => {
    const files = new Set([
      "LICENSE",
      "README.md",
      "package.json",
      "dist/index.js",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.js.map",
    ]);

    expect(() => validateTarballPaths(files)).not.toThrow();
    expect(() =>
      validateExportTargets(
        {
          ".": {
            import: "./dist/index.js",
            require: "./dist/index.cjs",
            types: "./dist/index.d.ts",
          },
        },
        files
      )
    ).not.toThrow();
    expect(() => validateSourceMap(VALID_MAP, "index.js.map")).not.toThrow();
    expect(() =>
      validateNoCredential("ordinary package text", "README.md")
    ).not.toThrow();
  });

  it("rejects unexpected tarball entries and absent export targets", () => {
    expect(() => validateTarballPaths(["src/private.ts"])).toThrow(
      UNEXPECTED_ENTRY_RE
    );
    expect(() => validateExportTargets("./dist/missing.js", new Set())).toThrow(
      ABSENT_TARGET_RE
    );
  });

  it.each([
    "../outside.js",
    "./dist/../outside.js",
    "./dist\\index.js",
    "/absolute/index.js",
  ])("rejects non-canonical export target %s", (target) => {
    expect(() => validateExportTargets(target, new Set([target]))).toThrow(
      NON_CANONICAL_RE
    );
  });

  it("bounds recursive export-condition traversal", () => {
    const recursive = {};
    recursive.default = recursive;
    expect(() => exportTargets(recursive)).toThrow(INVALID_EXPORTS_RE);
  });

  it("enforces entry and shared-chunk JavaScript size budgets", () => {
    expect(() =>
      validateJavaScriptArtifactSize("dist/opengateway.js", 110 * 1024)
    ).not.toThrow();
    expect(() =>
      validateJavaScriptArtifactSize("dist/opengateway.js", 110 * 1024 + 1)
    ).toThrow(SIZE_BUDGET_RE);
    expect(() =>
      validateJavaScriptArtifactSize("dist/chunk-ABC123.js", 100 * 1024 + 1)
    ).toThrow(SIZE_BUDGET_RE);
    expect(() =>
      validateJavaScriptArtifactSize("dist/unbudgeted.js", 1)
    ).toThrow(SIZE_BUDGET_RE);
  });

  it.each([
    [{ ...VALID_MAP, version: 2 }, "wrong version"],
    [{ ...VALID_MAP, sourceRoot: "../" }, "non-empty sourceRoot"],
    [{ ...VALID_MAP, sources: ["../../private.ts"] }, "traversing source"],
    [{ ...VALID_MAP, sourcesContent: [] }, "unaligned sourcesContent"],
    [{ ...VALID_MAP, sourcesContent: [null] }, "non-string source content"],
  ])("rejects an invalid sourcemap: %s", (map) => {
    expect(() => validateSourceMap(map, "bad.js.map")).toThrow(INVALID_MAP_RE);
  });

  it.each([
    "flp_abcdefghijkl",
    "sk-abcdefghijkl",
    "ghp_abcdefghijkl",
    "npm_abcdefghijkl",
    "AKIAabcdefghijkl",
  ])("rejects credential-shaped text without exposing it: %s", (content) => {
    expect(() => validateNoCredential(content, "dist/index.js")).toThrow(
      CREDENTIAL_RE
    );
  });
});
