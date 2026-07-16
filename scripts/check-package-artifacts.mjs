import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  packageArtifactAllowedRootFiles,
  packageFilesFromPackJson,
  validateExportTargets,
  validateJavaScriptArtifactSize,
  validateNoCredential,
  validateSourceMap,
  validateTarballPaths,
} from "./package-artifact-validation.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
});
const files = new Set(packageFilesFromPackJson(JSON.parse(stdout)));
validateTarballPaths(files);

const packageJson = JSON.parse(await readFile(new URL("package.json", root)));
validateExportTargets(packageJson.exports, files);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const url = new URL(entry.name, directory);
      return entry.isDirectory()
        ? filesUnder(new URL(`${entry.name}/`, directory))
        : [url];
    })
  );
  return nested.flat();
}

const distFiles = await filesUnder(dist);
for (const url of distFiles) {
  if (!url.pathname.endsWith(".map")) {
    continue;
  }
  const map = JSON.parse(await readFile(url, "utf8"));
  const name = url.pathname.slice(dist.pathname.length);
  validateSourceMap(map, name);
}

const packedTextFiles = [
  ...[...packageArtifactAllowedRootFiles].map((name) => new URL(name, root)),
  ...distFiles,
];
for (const url of packedTextFiles) {
  const content = await readFile(url, "utf8");
  const name = url.pathname.startsWith(dist.pathname)
    ? `dist/${url.pathname.slice(dist.pathname.length)}`
    : url.pathname.slice(root.pathname.length);
  validateNoCredential(content, name);
  if (/^dist\/(?:.+\.)?[cm]?js$/.test(name)) {
    validateJavaScriptArtifactSize(name, Buffer.byteLength(content));
  }
}
