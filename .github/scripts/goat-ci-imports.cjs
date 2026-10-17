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

/** Extensions of files a source can name by path: sources, data, fixtures and scripts. */
const PATH_EXTENSIONS = new Set([
  ...RESOLVE_EXTENSIONS,
  ".jsonl",
  ".ndjson",
  ".sh",
  ".sql",
  ".txt",
  ".yaml",
  ".yml",
  ".md",
  ".wasm",
]);
/** A string literal, or a template literal's text, that ends in a file name with an extension. */
const PATH_STRING = /["'\x60]([^"'\x60\n]*?([\w@+-][\w.@+-]*\.[A-Za-z0-9]+))["'\x60]/g;
/** A dynamic import or require whose argument is not a literal: the file loads modules by name. */
const NON_LITERAL_LOAD = /\b(?:import|require)\s*\(\s*(?!["']|\x60[^\x60$]*\x60)[^)\s]/;
/** A quoted module name or extensionless module path, which a loader may turn into a file path. */
const QUOTED_MODULE = /["'\x60]((?:\.{1,2}\/)*[A-Za-z][\w-]*(?:\/[\w.-]+)*)["'\x60]/g;
/** A name that matches more files than this is too generic to be a reference. */
const MAX_NAME_MATCHES = 3;
/** Build and test configs: reached like any file, but nothing depends on a file through one. */
const CONFIG_FILE = /(?:^|\/)vite\.config\.[cm]?[jt]s$/;

/** Source text without comments, so a file name in prose is not a reference. URLs keep their //. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\x60\\])\/\/.*$/gm, "$1");
}

/**
 * Files a source names in strings: a path ending in a file name (a fixture it reads, a script it
 * spawns), resolved against the source's directory, else by its trailing path segments, else by a
 * file name no other file shares; and, when the source loads modules through a non-literal import
 * or require, every quoted word that names a module without its extension (a fixture's
 * app("rpcInitialItems")).
 */
function namedFilesOf(source, from, { byBase, byStem, fileSet, packageDirFor }) {
  const found = new Set();
  const code = withoutComments(source);
  const addAll = (matches) => {
    if (matches.length > 0 && matches.length <= MAX_NAME_MATCHES)
      for (const file of matches) found.add(file);
  };
  // A name several files share most likely means the one in the naming file's own package.
  const ownPackage = packageDirFor(from);
  const preferOwnPackage = (matches) =>
    matches.length <= MAX_NAME_MATCHES || ownPackage === undefined
      ? matches
      : matches.filter((file) => file.startsWith(ownPackage + "/"));
  for (const match of code.matchAll(PATH_STRING)) {
    const [, text, base] = match;
    if (!PATH_EXTENSIONS.has(path.posix.extname(base))) continue;
    if (text.startsWith("./") || text.startsWith("../")) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), text));
      if (fileSet.has(relative)) {
        found.add(relative);
        continue;
      }
    }
    // Whatever follows the last template substitution and any leading ./ or ../ segments.
    const tail = text
      .replace(/^[\s\S]*\}/, "")
      .replace(/^\/+/, "")
      .replace(/^(?:\.{1,2}\/)+/, "");
    const candidates = byBase.get(base) ?? [];
    if (tail.includes("/"))
      addAll(
        preferOwnPackage(candidates.filter((file) => file === tail || file.endsWith("/" + tail))),
      );
    else if (candidates.length === 1) addAll(candidates);
    else {
      const local = candidates.filter((file) => ownPackage && file.startsWith(ownPackage + "/"));
      if (local.length === 1) addAll(local);
    }
  }
  if (NON_LITERAL_LOAD.test(code)) {
    for (const match of code.matchAll(QUOTED_MODULE)) {
      const name = match[1].replace(/^(?:\.{1,2}\/)+/, "");
      if (name.length < 2 || name === "index") continue;
      const candidates = (byStem.get(path.posix.basename(name)) ?? []).filter((file) => {
        const withoutExtension = file.slice(0, file.length - path.posix.extname(file).length);
        return withoutExtension === name || withoutExtension.endsWith("/" + name);
      });
      addAll(preferOwnPackage(candidates));
    }
  }
  found.delete(from);
  return found;
}

function isSource(file) {
  return SOURCE_EXTENSIONS.includes(path.posix.extname(file));
}

/**
 * Repository-relative files under apps/, packages/ and scripts/ plus the source files at the root
 * (the root Vite config names the setup file every test loads; scripts/lib feeds the app configs),
 * skipping build output, dot directories and native projects.
 */
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
  walk("scripts");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && isSource(entry.name)) files.push(entry.name);
  }
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
 * Builds the graph: { files, sources, importers, namers, packageDirs }. importers maps a file, or a
 * "package:<dir>" node that stands for a whole package when an import of it could not be pinned to
 * one file, to the set of source files that import it. namers maps a file to the source files that
 * name it in a string (see namedFilesOf); a config that names a build entry does not depend on it
 * the way an importer does, so callers can follow imports alone.
 */
function buildImportGraph(root, files = listWorkspaceFiles(root)) {
  const fileSet = new Set(files);
  const packages = readPackages(root);
  const names = [...packages.keys()].sort((a, b) => b.length - a.length);
  const packageDirs = [...packages.values()].map((entry) => entry.dir);
  const packageDirFor = (file) => packageDirs.find((dir) => file.startsWith(dir + "/"));
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

  const namers = new Map();
  const link = (edges, from, to) => {
    if (!edges.has(to)) edges.set(to, new Set());
    edges.get(to).add(from);
  };
  const byBase = new Map();
  const byStem = new Map();
  for (const file of files) {
    const base = path.posix.basename(file);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(file);
    if (isSource(file)) {
      const stem = base.slice(0, base.length - path.posix.extname(base).length);
      if (!byStem.has(stem)) byStem.set(stem, []);
      byStem.get(stem).push(file);
    }
  }
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
      if (target !== undefined && target !== file) link(importers, file, target);
    }
    for (const named of namedFilesOf(source, file, { byBase, byStem, fileSet, packageDirFor })) {
      if (!importers.get(named)?.has(file)) link(namers, file, named);
    }
  }
  return {
    files: fileSet,
    sources,
    importers,
    namers,
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
function dependents(graph, seeds, { importsOnly = false } = {}) {
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
    if (CONFIG_FILE.test(node)) continue;
    for (const importer of graph.importers.get(node) ?? []) visit(importer, origin.get(node));
    if (!importsOnly)
      for (const namer of graph.namers?.get(node) ?? []) visit(namer, origin.get(node));
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
