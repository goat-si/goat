"use strict";

/** A hand-made graph: files maps each file to its source text, edges lists [importer, imported]. */
function fakeGraph(files, edges = []) {
  const importers = new Map();
  for (const [from, to] of edges) {
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(from);
  }
  const sources = new Map(Object.entries(files).filter(([file]) => /\.[cm]?[jt]sx?$/.test(file)));
  return { files: new Set(Object.keys(files)), sources, importers, packageDirs: ["apps/server"] };
}

module.exports = { fakeGraph };
