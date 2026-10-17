"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  specifiersOf,
  resolveExport,
  buildImportGraph,
  dependents,
  mentionsOf,
} = require("./goat-ci-imports.cjs");

describe("specifiersOf", () => {
  it("reads every runtime import form", () => {
    const source = [
      'import a from "./a.ts";',
      "import {",
      "  b,",
      "  c,",
      '} from "@goat/shared/b";',
      'import * as ns from "../ns.ts";',
      'import "./side-effect.ts";',
      'import { type T, value } from "./mixed.ts";',
      'export * from "./star.ts";',
      'export { x } from "./named.ts";',
      'const lazy = await import("./lazy.ts");',
      "const literal = await import(\x60./template.ts\x60);",
      'const cjs = require("./cjs.cjs");',
      'vi.mock("./mocked.ts", () => ({}));',
      'const actual = await vi.importActual("./actual.ts");',
      'const helper = new URL("../../helper.ts", import.meta.url);',
    ].join("\n");
    assert.deepEqual(
      new Set(specifiersOf(source)),
      new Set([
        "./a.ts",
        "@goat/shared/b",
        "../ns.ts",
        "./side-effect.ts",
        "./mixed.ts",
        "./star.ts",
        "./named.ts",
        "./lazy.ts",
        "./template.ts",
        "./cjs.cjs",
        "./mocked.ts",
        "./actual.ts",
        "../../helper.ts",
      ]),
    );
  });

  it("skips type-only imports and re-exports, which never run", () => {
    const source = [
      'import type { A } from "./a.ts";',
      'export type { B } from "./b.ts";',
      'import typeHelpers from "./typeHelpers.ts";',
    ].join("\n");
    assert.deepEqual(specifiersOf(source), ["./typeHelpers.ts"]);
  });

  it("skips dynamic imports it cannot read", () => {
    assert.deepEqual(
      specifiersOf("await import(modulePath);\nawait import(\x60./\x24{name}.ts\x60);"),
      [],
    );
  });
});

describe("resolveExport", () => {
  const manifest = {
    exports: {
      ".": { types: "./src/index.ts", import: "./src/index.ts" },
      "./settings": { types: "./src/settings.ts", default: "./src/settings.ts" },
      "./server/*": { import: "./src/server/*.ts" },
    },
  };

  it("reads named subpaths and patterns", () => {
    assert.equal(resolveExport(manifest, "."), "./src/index.ts");
    assert.equal(resolveExport(manifest, "./settings"), "./src/settings.ts");
    assert.equal(resolveExport(manifest, "./server/cloud"), "./src/server/cloud.ts");
  });

  it("returns nothing for a subpath the package does not export", () => {
    assert.equal(resolveExport(manifest, "./missing"), undefined);
  });

  it("handles string exports and packages without exports", () => {
    assert.equal(resolveExport({ exports: "./src/main.ts" }, "."), "./src/main.ts");
    assert.equal(resolveExport({ main: "./lib/index.js" }, "."), "./lib/index.js");
    assert.equal(resolveExport({}, "./deep/file"), "./deep/file");
  });
});

describe("buildImportGraph", () => {
  let root;
  let graph;
  const write = (file, text = "") => {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-imports-"));
    write(
      "packages/lib/package.json",
      JSON.stringify({
        name: "@goat/lib",
        exports: { ".": { import: "./src/index.ts" }, "./util/*": { import: "./src/util/*.ts" } },
      }),
    );
    write("packages/lib/src/index.ts", 'export * from "./core.ts";');
    write("packages/lib/src/core.ts");
    write("packages/lib/src/util/strings.ts");
    write(
      "packages/opaque/package.json",
      JSON.stringify({ name: "@goat/opaque", exports: { ".": "./src/index.ts" } }),
    );
    write("packages/opaque/src/index.ts");
    write("packages/opaque/src/hidden.ts");
    write("apps/server/package.json", JSON.stringify({ name: "goat" }));
    write("apps/server/src/feature/index.ts", 'import { core } from "@goat/lib";');
    write("apps/server/src/feature.test.ts", 'import { feature } from "./feature";');
    write("apps/server/src/util.test.ts", 'import { s } from "@goat/lib/util/strings";');
    write("apps/server/src/esm.ts");
    write("apps/server/src/esm.test.ts", 'import "./esm.js";');
    write("apps/server/src/opaque.test.ts", 'import { deep } from "@goat/opaque/not-exported";');
    write("apps/server/src/spawn.test.ts", 'spawn("node", [path.join(dir, "cli/helper.ts")]);');
    write("apps/server/src/cli/helper.ts");
    write("apps/server/src/loaded.ts");
    write("apps/server/src/ws.ts");
    write("apps/server/src/nested/deep.ts");
    write(
      "apps/server/src/loader.fixture.mjs",
      'const app = (name) => import(root + "/src/" + name + ".ts");\nawait app("loaded");\nawait app("ws");\nawait app("nested/deep");',
    );
    write(
      "apps/server/src/loader.test.ts",
      'const fixture = new URL("./loader.fixture.mjs", import.meta.url);',
    );
    write("apps/server/src/prose.ts");
    write(
      "apps/server/src/prose.test.ts",
      '// The old "prose.ts" check moved.\n/* see "prose.ts" */\nexport const url = "https://example.com/prose.ts";',
    );
    write("apps/server/vite.config.ts", 'export default { build: { entry: "src/entry.ts" } };');
    write("apps/server/src/entry.ts", 'import "./esm.ts";');
    write("apps/server/src/config.test.ts", 'const config = "apps/server/vite.config.ts";');
    write("apps/web/src/lib/thing.ts");
    write("apps/web/src/thing.test.ts", 'import { thing } from "~/lib/thing";');
    write("apps/server/node_modules/ignored/index.ts", 'import "../../src/esm.ts";');
    graph = buildImportGraph(root);
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const reaches = (changed, test) => dependents(graph, [changed]).has(test);

  it("follows directory imports, re-exports and package exports", () => {
    assert.ok(reaches("packages/lib/src/core.ts", "apps/server/src/feature.test.ts"));
    assert.ok(reaches("packages/lib/src/util/strings.ts", "apps/server/src/util.test.ts"));
    assert.ok(!reaches("packages/lib/src/util/strings.ts", "apps/server/src/feature.test.ts"));
  });

  it("maps a .js specifier to its TypeScript source", () => {
    assert.ok(reaches("apps/server/src/esm.ts", "apps/server/src/esm.test.ts"));
  });

  it("treats an import it cannot pin to a file as an import of the whole package", () => {
    assert.ok(graph.importers.has("package:packages/opaque"));
    assert.ok(reaches("packages/opaque/src/hidden.ts", "apps/server/src/opaque.test.ts"));
  });

  it("resolves the root Vite alias", () => {
    assert.ok(reaches("apps/web/src/lib/thing.ts", "apps/web/src/thing.test.ts"));
  });

  it("skips installed dependencies", () => {
    assert.ok(![...graph.sources.keys()].some((file) => file.includes("node_modules")));
  });

  it("follows a file that a test names only by path, apart from imports", () => {
    assert.ok(reaches("apps/server/src/cli/helper.ts", "apps/server/src/spawn.test.ts"));
    assert.ok(
      !dependents(graph, ["apps/server/src/cli/helper.ts"], { importsOnly: true }).has(
        "apps/server/src/spawn.test.ts",
      ),
    );
    assert.deepEqual(mentionsOf(graph, "apps/server/src/cli/helper.ts"), [
      "apps/server/src/spawn.test.ts",
    ]);
  });

  it("follows a module that a loader imports by name", () => {
    assert.ok(reaches("apps/server/src/loaded.ts", "apps/server/src/loader.test.ts"));
    assert.ok(reaches("apps/server/src/ws.ts", "apps/server/src/loader.test.ts"));
    assert.ok(reaches("apps/server/src/nested/deep.ts", "apps/server/src/loader.test.ts"));
  });

  it("ignores file names in comments", () => {
    assert.ok(!reaches("apps/server/src/prose.ts", "apps/server/src/prose.test.ts"));
  });

  it("does not connect files through a config that names a build entry", () => {
    assert.ok(reaches("apps/server/src/esm.ts", "apps/server/vite.config.ts"));
    assert.ok(!reaches("apps/server/src/esm.ts", "apps/server/src/config.test.ts"));
  });
});
