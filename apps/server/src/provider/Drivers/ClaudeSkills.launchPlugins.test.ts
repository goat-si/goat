import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("Claude launch plugins", (it) => {
  it.effect("discovers inline plugins from --plugin-dir launch args", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const named = path.join(workspace, "named");
      yield* fs.makeDirectory(path.join(named, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(named, ".claude-plugin", "plugin.json"),
        '{"name":"acme"}',
      );
      yield* writeSkill(path.join(named, "skills"), "qa", "---\ndescription: QA a ticket\n---\n");
      yield* writeSkill(path.join(workspace, "local", "skills"), "lint", "# Lint");
      const bundle = path.join(workspace, "bundle");
      yield* fs.makeDirectory(path.join(bundle, "tools", ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(bundle, "tools", ".claude-plugin", "plugin.json"),
        '{"name":"tools"}',
      );
      yield* writeSkill(path.join(bundle, "tools", "skills"), "fmt", "# Fmt");
      yield* writeSkill(path.join(workspace, "muted", "skills"), "hidden", "# Hidden");
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "muted@inline": false } }),
      );

      const launchArgs = `--plugin-dir ${named} --plugin-dir=local --model sonnet --plugin-dir ${bundle} --plugin-dir muted`;
      const skills = yield* discoverClaudeSkills({ homePath: configDir, launchArgs }, workspace);
      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "acme:qa", scope: "user", description: "QA a ticket" },
          { name: "local:lint", scope: "user", description: undefined },
          { name: "tools:fmt", scope: "user", description: undefined },
        ],
      );
      // Without a cwd, a relative --plugin-dir has nothing to resolve against.
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir, launchArgs })).map(
          (skill) => skill.name,
        ),
        ["acme:qa", "tools:fmt"],
      );
    }),
  );
});
