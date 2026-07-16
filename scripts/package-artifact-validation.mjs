import { posix } from "node:path";

const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
const allowedDistFile = /(?:\.d\.ts|\.[cm]?js|\.map)$/;
const sourcePath = /^\.\.\/src\/(?:[^/]+\/)*[^/]+\.ts$/;
const suspiciousSecret = /(?:flp_|sk-|gh[pousr]_|npm_|AKIA)[A-Za-z0-9_-]{12,}/;
const kibibyte = 1024;
const javascriptBudgets = new Map([
  ["dist/index.js", 300 * kibibyte],
  ["dist/index.cjs", 330 * kibibyte],
  ["dist/friendli.js", 20 * kibibyte],
  ["dist/friendli.cjs", 32 * kibibyte],
  ["dist/openrouter.js", 20 * kibibyte],
  ["dist/openrouter.cjs", 32 * kibibyte],
  ["dist/opengateway.js", 110 * kibibyte],
  ["dist/opengateway.cjs", 110 * kibibyte],
  ["dist/wafer.js", 32 * kibibyte],
  ["dist/wafer.cjs", 48 * kibibyte],
]);
const sharedChunk = /^dist\/chunk-[A-Z0-9]+\.js$/;
const sharedChunkBudget = 100 * kibibyte;

export function packageFilesFromPackJson(value) {
  const pack = Array.isArray(value) ? value[0] : value;
  if (pack === null || typeof pack !== "object" || !Array.isArray(pack.files)) {
    throw new Error("npm pack returned an invalid JSON payload");
  }
  return pack.files.map((file) => {
    if (
      file === null ||
      typeof file !== "object" ||
      typeof file.path !== "string"
    ) {
      throw new Error("npm pack returned an invalid file entry");
    }
    return file.path;
  });
}

export function validateTarballPaths(paths) {
  for (const path of paths) {
    if (
      !(
        allowedRootFiles.has(path) ||
        (path.startsWith("dist/") && allowedDistFile.test(path))
      )
    ) {
      throw new Error(`unexpected npm tarball entry: ${path}`);
    }
  }
}

export function exportTargets(
  value,
  targets = new Set(),
  state = { nodes: 0 }
) {
  if (typeof value === "string") {
    targets.add(value);
    return targets;
  }
  if (value === null) {
    return targets;
  }
  if (typeof value !== "object" || state.nodes >= 1000) {
    throw new Error("package exports contain an invalid or oversized target");
  }
  state.nodes += 1;
  for (const nested of Object.values(value)) {
    exportTargets(nested, targets, state);
  }
  return targets;
}

export function validateExportTargets(exportsValue, packedFiles) {
  for (const target of exportTargets(exportsValue)) {
    if (
      !target.startsWith("./") ||
      target.includes("\\") ||
      `./${posix.normalize(target.slice(2))}` !== target
    ) {
      throw new Error(`package export target is not canonical: ${target}`);
    }
    const path = target.slice(2);
    if (!packedFiles.has(path)) {
      throw new Error(`package export target is absent from tarball: ${path}`);
    }
  }
}

export function validateSourceMap(map, name) {
  if (
    map === null ||
    typeof map !== "object" ||
    map.version !== 3 ||
    !(map.sourceRoot === undefined || map.sourceRoot === "") ||
    !Array.isArray(map.sources) ||
    map.sources.some(
      (source) =>
        typeof source !== "string" ||
        !sourcePath.test(source) ||
        posix.normalize(source) !== source
    ) ||
    !Array.isArray(map.sourcesContent) ||
    map.sourcesContent.length !== map.sources.length ||
    map.sourcesContent.some((content) => typeof content !== "string")
  ) {
    throw new Error(`sourcemap includes a non-source build input: ${name}`);
  }
}

export function validateNoCredential(content, name) {
  if (suspiciousSecret.test(content)) {
    throw new Error(`npm artifact includes a credential-shaped value: ${name}`);
  }
}

export function validateJavaScriptArtifactSize(name, bytes) {
  const budget =
    javascriptBudgets.get(name) ??
    (sharedChunk.test(name) ? sharedChunkBudget : undefined);
  if (budget === undefined) {
    throw new Error(`JavaScript artifact has no size budget: ${name}`);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget) {
    throw new Error(
      `JavaScript artifact exceeds its size budget: ${name} (${bytes} > ${budget})`
    );
  }
}

export const packageArtifactAllowedRootFiles = allowedRootFiles;
