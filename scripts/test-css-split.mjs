// The stylesheet split (audit P2, src/app/styles/component-sheets.css): a
// sheet that leaves globals.css to load with its components must not be in
// globals.css as well, must be imported by a component that uses it (or
// nothing on the web would load it), and must share no class with any other
// sheet, since its place in the cascade is no longer fixed. The apps read
// the same list and fold it into their one sheet.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const styles = path.join(root, "src", "app", "styles");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function classes(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set();
  for (const [, selector] of text.matchAll(/([^{}@;]+)\{/g)) {
    if (/^\s*(from|to|\d+%)/.test(selector)) continue;
    for (const [, name] of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) found.add(name);
  }
  return found;
}

function imports(file) {
  return [...fs.readFileSync(file, "utf8").matchAll(/^@import\s+"\.\/(?:styles\/)?([^"]+\.css)";/gm)].map((match) => match[1]);
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const split = imports(path.join(styles, "component-sheets.css"));
const global = imports(path.join(root, "src", "app", "globals.css"));
const sources = sourceFiles(path.join(root, "src"));

test("the split list names at least the rulebook", () => {
  assert.ok(split.includes("rulebook.css"), split.join(", "));
});

test("a split sheet is no longer loaded by every page", () => {
  for (const sheet of split) assert.ok(!global.includes(sheet), sheet);
});

test("each split sheet is imported by a component that uses it", () => {
  for (const sheet of split) {
    const importers = sources.filter((file) => fs.readFileSync(file, "utf8").includes(`import "@/app/styles/${sheet}";`));
    assert.ok(importers.length > 0, `${sheet} is imported by nothing`);
    const own = classes(path.join(styles, sheet));
    for (const importer of importers) {
      const text = fs.readFileSync(importer, "utf8");
      assert.ok([...own].some((name) => text.includes(name)), `${path.relative(root, importer)} imports ${sheet} but uses none of it`);
    }
  }
});

test("a split sheet shares no class with any other sheet", () => {
  const others = [path.join(root, "src", "app", "globals.css"), ...fs.readdirSync(styles).map((name) => path.join(styles, name))]
    .filter((file) => file.endsWith(".css") && !split.includes(path.basename(file)) && path.basename(file) !== "component-sheets.css");
  for (const sheet of split) {
    const own = classes(path.join(styles, sheet));
    for (const other of others) {
      const shared = [...classes(other)].filter((name) => own.has(name));
      assert.deepEqual(shared, [], `${sheet} and ${path.basename(other)} both style ${shared.join(", ")}`);
    }
  }
});

console.log(`\n${passed} css-split tests passed.`);
