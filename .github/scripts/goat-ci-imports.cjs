"use strict";

// A static import graph of the workspace sources, used by goat-ci-scope.cjs to pick the server test
// files a pull request reaches. It reads every source file under apps/ and packages/ once and
// follows relative imports, workspace package imports (through each package.json "exports"), the
// "~" alias of the root Vite config, vi.mock specifiers, literal dynamic imports, and
// new URL("...", import.meta.url). A package import it cannot pin to one file stands for the whole
// package, so a gap costs CI time instead of skipping a test.

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];
const JS_TO_TS = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  "ios",
  "android",
]);
/** The root Vite config's resolve.alias, which every Vitest project inherits. */
const ALIASES = [["~/", "apps/web/src/"]];

const SPECIFIER_PATTERNS = [
  // import x from "a"; import { x } from "a"; import "a". Type-only imports and re-exports
  // (import type, export type) are erased before a test runs, and typecheck covers them, so they
  // are not edges. import { type X, y } still is.
  /\bimport\s+(?!type\s)(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  // export * from "a"; export { x } from "a"
  /\bexport\s+(?!type\s)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g,
  // import("a") and a template literal without substitutions
  /\bimport\s*\(\s*(?:["']([^"'\n]+)["']|\x60([^\x60$\n]+)\x60)\s*[,)]/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*["']([^"'\n]+)["']/g,
  /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

/** Every specifier a source file names. Duplicates are harmless. */
function specifiersOf(source) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

function isSource(file) {
  return SOURCE_EXTENSIONS.includes(path.posix.extname(file));
}

/** Repository-relative files under apps/* and packages/*, skipping build output, dot directories and native projects. */
function listWorkspaceFiles(root) {
  const files = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  walk("apps");
  walk("packages");
  return files;
}

/** Workspace packages by name: { dir, manifest }. */
function readPackages(root) {
  const packages = new Map();
  for (const parent of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(root, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof manifest.name === "string") {
        packages.set(manifest.name, { dir: parent + "/" + entry.name, manifest });
      }
    }
  }
  return packages;
}

/** The path an "exports" target names, preferring the import-like conditions. */
function exportTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = exportTarget(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    for (const condition of ["source", "import", "default", "node", "require", "types"]) {
      if (Object.hasOwn(target, condition)) {
        const resolved = exportTarget(target[condition]);
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

/** Package-relative path a subpath ("." or "./x") exports, or undefined when exports do not name it. */
function resolveExport(manifest, subpath) {
  const exportsField = manifest.exports;
  if (exportsField === undefined) {
    if (subpath !== ".") return subpath;
    return manifest.module ?? manifest.main ?? manifest.types ?? "./index";
  }
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? exportTarget(exportsField) : undefined;
  }
  const keys = Object.keys(exportsField);
  if (!keys.some((key) => key.startsWith("."))) {
    return subpath === "." ? exportTarget(exportsField) : undefined;
  }
  if (Object.hasOwn(exportsField, subpath)) return exportTarget(exportsField[subpath]);
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    ) {
      const target = exportTarget(exportsField[key]);
      if (target)
        return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
}

/**
 * Builds the graph: { files, sources, importers, packageDirs }. importers maps a file, or a
 * "package:<dir>" node that stands for a whole package when an import of it could not be pinned to
 * one file, to the set of source files that import it.
 */
function buildImportGraph(root, files = listWorkspaceFiles(root)) {
  const fileSet = new Set(files);
  const packages = readPackages(root);
  const names = [...packages.keys()].sort((a, b) => b.length - a.length);
  const sources = new Map();
  const importers = new Map();

  const firstExisting = (base) => {
    if (fileSet.has(base)) return base;
    const extension = path.posix.extname(base);
    for (const candidate of JS_TO_TS[extension] ?? []) {
      const swapped = base.slice(0, -extension.length) + candidate;
      if (fileSet.has(swapped)) return swapped;
    }
    for (const candidate of RESOLVE_EXTENSIONS)
      if (fileSet.has(base + candidate)) return base + candidate;
    for (const candidate of RESOLVE_EXTENSIONS) {
      if (fileSet.has(base + "/index" + candidate)) return base + "/index" + candidate;
    }
    return undefined;
  };

  const resolve = (specifier, from) => {
    const clean = specifier.split("?")[0];
    if (clean.startsWith("./") || clean.startsWith("../")) {
      return firstExisting(path.posix.normalize(path.posix.join(path.posix.dirname(from), clean)));
    }
    for (const [alias, target] of ALIASES) {
      if (clean.startsWith(alias)) return firstExisting(target + clean.slice(alias.length));
    }
    const name = names.find(
      (candidate) => clean === candidate || clean.startsWith(candidate + "/"),
    );
    if (name === undefined) return undefined;
    const { dir, manifest } = packages.get(name);
    const target = resolveExport(manifest, clean === name ? "." : "." + clean.slice(name.length));
    const file = target ? firstExisting(path.posix.normalize(dir + "/" + target)) : undefined;
    return file ?? "package:" + dir;
  };

  for (const file of files) {
    if (!isSource(file)) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    sources.set(file, source);
    for (const specifier of specifiersOf(source)) {
      const target = resolve(specifier, file);
      if (target === undefined || target === file) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return {
    files: fileSet,
    sources,
    importers,
    packageDirs: [...packages.values()].map((entry) => entry.dir),
  };
}

/** The workspace package directory that owns file, or undefined. */
function packageDirOf(graph, file) {
  return graph.packageDirs.find((dir) => file.startsWith(dir + "/"));
}

/**
 * Every node that imports one of the seeds, directly or transitively, seeds included. A seed inside
 * a package also reaches whatever imports that package as a whole. Maps each node to the seed that
 * reached it first.
 */
function dependents(graph, seeds) {
  const origin = new Map();
  const queue = [];
  const visit = (node, seed) => {
    if (origin.has(node)) return;
    origin.set(node, seed);
    queue.push(node);
  };
  for (const seed of seeds) {
    visit(seed, seed);
    const dir = packageDirOf(graph, seed);
    if (dir) visit("package:" + dir, seed);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const importer of graph.importers.get(node) ?? []) visit(importer, origin.get(node));
  }
  return origin;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

/**
 * Source files that name file inside a string or path: its file name, and for a data file also its
 * directory (replay fixtures are loaded by scenario directory). Catches files a test reads or spawns
 * by path, which no import names.
 */
function mentionsOf(graph, file) {
  const needles = [path.posix.basename(file)];
  if (!isSource(file)) needles.push(path.posix.basename(path.posix.dirname(file)));
  const patterns = needles.map(
    (needle) => new RegExp("[\"'\\x60/]" + escapeRegExp(needle) + "[\"'\\x60/]"),
  );
  const found = [];
  for (const [candidate, source] of graph.sources) {
    if (candidate !== file && patterns.some((pattern) => pattern.test(source)))
      found.push(candidate);
  }
  return found;
}

module.exports = {
  specifiersOf,
  isSource,
  listWorkspaceFiles,
  resolveExport,
  buildImportGraph,
  dependents,
  mentionsOf,
};
