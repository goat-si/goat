import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GOAT_PROJECT_FILE_NAME, ServerSettings } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as GoatProjectFileLoader from "./GoatProjectFileLoader.ts";
import { runSetup, setupScript, projectId } from "./testkit/ProjectScriptRunnerHarness.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(GoatProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "goat-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  contents: string,
  fileName = GOAT_PROJECT_FILE_NAME,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("GoatProjectFileLoader", (it) => {
  it.effect("#904 runs the prepared checkout's setup when no actions were configured", () =>
    Effect.gen(function* () {
      const root = yield* makeTempDir;
      const checkout = yield* makeTempDir;
      yield* writeProjectFile(
        root,
        JSON.stringify({
          scripts: [{ name: "Root", command: "root-setup", runOnWorktreeCreate: true }],
        }),
      );
      yield* writeProjectFile(
        checkout,
        JSON.stringify({
          scripts: [
            { name: "Branch", command: "branch-setup", runOnWorktreeCreate: true, async: false },
          ],
        }),
      );
      const { result, writes, opened } = yield* runSetup({
        root,
        checkout,
      });
      expect(result).toMatchObject({
        status: "started",
        scriptName: "Branch",
        scriptCommand: "branch-setup",
        async: false,
        cwd: checkout,
      });
      expect(writes).toEqual([" branch-setup\r"]);
      expect(opened).toEqual([checkout]);
    }),
  );

  it.effect.each([
    {
      name: "unchecked stored actions",
      settings: {},
      scripts: [{ ...setupScript, runOnWorktreeCreate: false }],
    },
    {
      name: "empty project override",
      settings: { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } } },
    },
    {
      name: "unchecked project override",
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultProjectScripts: [{ ...setupScript, runOnWorktreeCreate: false }] },
        },
      },
    },
    { name: "legacy reset", settings: { projectScriptOverrides: { [projectId]: null } } },
    {
      name: "unchecked defaults",
      settings: { defaultProjectScripts: [{ ...setupScript, runOnWorktreeCreate: false }] },
    },
    {
      name: "unchecked folded defaults",
      settings: {
        projectSettingsFolded: true,
        defaultProjectScripts: [{ ...setupScript, runOnWorktreeCreate: false }],
      },
    },
  ])("#997 preserves $name instead of re-enabling file setup", (choice) =>
    Effect.gen(function* () {
      const root = yield* makeTempDir;
      yield* writeProjectFile(
        root,
        JSON.stringify({
          scripts: [{ name: "File", command: "file-setup", runOnWorktreeCreate: true }],
        }),
      );
      const { result, writes, opened } = yield* runSetup({ root, checkout: root, ...choice });
      expect(result).toEqual({ status: "no-script" });
      expect(writes).toEqual([]);
      expect(opened).toEqual([]);
    }),
  );

  it.effect.each([
    {
      name: "folded empty defaults",
      settings: { projectSettingsFolded: true, defaultProjectScripts: [] },
      scripts: [],
    },
    {
      name: "folded install with no defaults key",
      settings: Schema.decodeSync(ServerSettings)({
        projectSettingsFolded: true,
        projectSettingsOverrides: {},
        projectScriptOverrides: {},
      }),
      scripts: [],
    },
    {
      name: "folded reset with stale DB and legacy actions",
      settings: {
        projectSettingsFolded: true,
        defaultProjectScripts: [],
        projectScriptOverrides: { [projectId]: [setupScript] },
      },
      scripts: [setupScript],
    },
  ])("#904 runs file setup for $name", (choice) =>
    Effect.gen(function* () {
      const root = yield* makeTempDir;
      yield* writeProjectFile(
        root,
        JSON.stringify({
          scripts: [{ name: "File", command: "file-setup", runOnWorktreeCreate: true }],
        }),
      );
      const { result, writes, opened } = yield* runSetup({ root, checkout: root, ...choice });
      expect(result).toMatchObject({ status: "started", scriptCommand: "file-setup" });
      expect(writes).toEqual([" file-setup\r"]);
      expect(opened).toEqual([root]);
    }),
  );

  it.effect.each([
    { name: "stored", scripts: [setupScript], settings: {}, command: "stored-setup" },
    {
      name: "environment",
      scripts: [],
      settings: { defaultProjectScripts: [setupScript] },
      command: "stored-setup",
    },
    {
      name: "project override",
      scripts: [setupScript],
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultProjectScripts: [{ ...setupScript, command: "override-setup" }] },
        },
      },
      command: "override-setup",
    },
    {
      name: "legacy inheritance",
      scripts: [setupScript],
      settings: {
        defaultProjectScripts: [{ ...setupScript, command: "default-setup" }],
        projectScriptOverrides: { [projectId]: null },
      },
      command: "default-setup",
    },
    {
      name: "folded settings",
      scripts: [setupScript],
      settings: {
        projectSettingsFolded: true,
        defaultProjectScripts: [{ ...setupScript, command: "folded-setup" }],
      },
      command: "folded-setup",
    },
  ])("keeps $name precedence when goat.json declares setup", ({ scripts, settings, command }) =>
    Effect.gen(function* () {
      const root = yield* makeTempDir;
      yield* writeProjectFile(
        root,
        JSON.stringify({
          scripts: [{ name: "File", command: "file-setup", runOnWorktreeCreate: true }],
        }),
      );
      const { result, writes } = yield* runSetup({ root, checkout: root, scripts, settings });
      expect(result).toMatchObject({ status: "started", scriptCommand: command, async: true });
      expect(writes).toEqual([` ${command}\r`]);
    }),
  );

  it.effect.each([
    {
      name: "missing branch file",
      contents: null,
      fileName: GOAT_PROJECT_FILE_NAME,
      command: "root-setup",
    },
    {
      name: "legacy branch file",
      contents:
        '{ "scripts": [{ "name": "Legacy", "command": "legacy-setup", "runOnWorktreeCreate": true }] }',
      fileName: LEGACY_PROJECT_FILE_NAME,
      command: "legacy-setup",
    },
    {
      name: "invalid branch file",
      contents: "{ invalid",
      fileName: GOAT_PROJECT_FILE_NAME,
      command: null,
    },
    {
      name: "branch without setup",
      contents: '{ "scripts": [] }',
      fileName: GOAT_PROJECT_FILE_NAME,
      command: null,
    },
  ])("resolves setup from the $name", ({ contents, fileName, command }) =>
    Effect.gen(function* () {
      const root = yield* makeTempDir;
      const checkout = yield* makeTempDir;
      yield* writeProjectFile(
        root,
        JSON.stringify({
          scripts: [{ name: "Root", command: "root-setup", runOnWorktreeCreate: true }],
        }),
      );
      if (contents !== null) yield* writeProjectFile(checkout, contents, fileName);
      const { result, writes } = yield* runSetup({ root, checkout });
      expect(result.status).toBe(command === null ? "no-script" : "started");
      expect(writes).toEqual(command === null ? [] : [` ${command}\r`]);
    }),
  );

  describe("load", () => {
    it.effect("returns none when both project files are missing", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("prefers goat.json over a legacy file", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "iconPath": "new.svg" }');
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        expect(Option.getOrNull(yield* loader.load(cwd))?.iconPath).toBe("new.svg");
      }),
    );

    it.effect("falls back to the legacy project file", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        expect(Option.getOrNull(yield* loader.load(cwd))?.iconPath).toBe("old.svg");
      }),
    );

    it.effect("reports invalid goat.json without falling back", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        const warnings: Array<unknown> = [];
        yield* writeProjectFile(cwd, "{ not json");
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        const logger = Logger.make(({ message }) => {
          warnings.push(message);
        });
        const loaded = yield* loader
          .load(cwd)
          .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        expect(Option.isNone(loaded)).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings.flat()).toEqual([
          expect.objectContaining({
            operation: "decode",
            filePath: expect.stringMatching(/goat\.json$/),
          }),
        ]);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
