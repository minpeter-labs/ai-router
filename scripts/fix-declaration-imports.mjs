import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const relativeSpecifier = /(["'])(\.\.?\/[^"']+)\1/g;
const explicitExtension = /\.(?:[cm]?js|json|node)$/;

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return declarationFiles(path);
      }
      return entry.name.endsWith(".d.ts") ? [path] : [];
    })
  );
  return nested.flat();
}

for (const path of await declarationFiles(dist)) {
  const source = await readFile(path, "utf8");
  const rewritten = source.replace(
    relativeSpecifier,
    (match, quote, specifier) =>
      explicitExtension.test(specifier)
        ? match
        : `${quote}${specifier}.js${quote}`
  );
  await writeFile(path, rewritten);
  relativeSpecifier.lastIndex = 0;
  const invalid = [...rewritten.matchAll(relativeSpecifier)].find(
    ([, , specifier]) => !explicitExtension.test(specifier)
  );
  if (invalid !== undefined) {
    throw new Error(`extensionless declaration import remained in ${path}`);
  }
}
