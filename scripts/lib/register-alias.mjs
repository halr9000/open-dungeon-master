// Module resolve hook mapping the tsconfig "@/" alias to src/ so test
// scripts can import alias-using TypeScript modules directly. Activate in
// a script with: register("./lib/register-alias.mjs", import.meta.url)
// before dynamically importing the module under test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = path.resolve(import.meta.dirname, "../../src");
const nodeModules = path.resolve(import.meta.dirname, "../../node_modules");

function withExtension(bare) {
  if (/\.(ts|tsx|json|js|mjs)$/.test(bare)) {
    return bare;
  }
  if (fs.existsSync(path.join(bare, "index.ts"))) {
    return path.join(bare, "index.ts");
  }
  return fs.existsSync(`${bare}.tsx`) && !fs.existsSync(`${bare}.ts`) ? `${bare}.tsx` : `${bare}.ts`;
}

export function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(withExtension(path.join(srcDir, spec.slice(2)))).href;
  } else if (
    // A TS module's extensionless relative import ("./submit"), which the
    // bundler resolves and plain Node does not.
    /^\.\.?\//.test(spec) &&
    !/\.[a-z]+$/i.test(spec) &&
    context.parentURL?.startsWith("file:") &&
    /\.tsx?$/.test(context.parentURL)
  ) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    spec = pathToFileURL(withExtension(path.resolve(parentDir, spec))).href;
  } else if (/^next\/[\w/-]+$/.test(spec) && fs.existsSync(path.join(nodeModules, `${spec}.js`))) {
    // Next publishes no exports map, so a bare subpath ("next/server") names
    // a file whose extension plain Node will not guess. Vitest's resolver
    // does, which is why a script passed there and failed run on its own.
    spec = `${spec}.js`;
  }
  return nextResolve(spec, context);
}

// TS source imports JSON without attributes (the bundler allows it);
// plain Node insists on them, so stamp the attribute at load time.
export function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    return nextLoad(url, { ...context, importAttributes: { type: "json" } });
  }
  return nextLoad(url, context);
}
