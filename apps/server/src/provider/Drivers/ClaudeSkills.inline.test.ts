import * as HostProcess from "@goat/shared/HostProcess";
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

it.layer(NodeServices.layer)("Claude inline plugin skills", (it) => {
  it.effect("skips oversized inline manifests and skill files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const huge = "x".repeat(1_000_000);
      const plugin = path.join(root, "plugin");
      const oversized = path.join(root, "oversized-manifest");
      const manifestDirectory = path.join(oversized, ".claude-plugin");
      yield* fs.makeDirectory(manifestDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(manifestDirectory, "plugin.json"),
        JSON.stringify({ name: "oversized", description: huge }),
      );
      yield* writeSkill(path.join(oversized, "skills"), "unexpected", "# Unexpected");
      yield* writeSkill(path.join(plugin, "skills"), "large", huge);
      yield* writeSkill(path.join(plugin, "skills"), "small", "# Small");
      const skills = yield* discoverClaudeSkills({ homePath: path.join(root, "home") }, root, {
        CLAUDE_CODE_PLUGIN_DIRS: [oversized, plugin].join(";"),
      });
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["plugin:small"],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect("bounds inline directory probes and the number of advertised skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const bundle = path.join(root, "bundle");
      const plugin = path.join(root, "plugin");
      for (let i = 0; i < 300; i++) {
        yield* fs.makeDirectory(path.join(bundle, `entry-${i}`), { recursive: true });
        yield* writeSkill(path.join(plugin, "skills"), `skill-${i}`, "# Skill");
      }
      let bundleProbes = 0;
      const skills = yield* discoverClaudeSkills({ homePath: path.join(root, "home") }, root, {
        CLAUDE_CODE_PLUGIN_DIRS: [bundle, plugin].join(";"),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (file) => {
            if (file.startsWith(bundle + path.sep) && file.endsWith("plugin.json")) bundleProbes++;
            return fs.exists(file);
          },
        }),
      );
      assert.isAtMost(bundleProbes, 129);
      assert.lengthOf(skills, 256);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect("discovers inline plugins from CLAUDE_CODE_PLUGIN_DIRS over installed namesakes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const named = path.join(workspace, "named");
      const unnamed = path.join(workspace, "unnamed");
      const inherited = path.join(workspace, "inherited");
      const muted = path.join(workspace, "muted");
      const installed = path.join(workspace, "installed-acme");
      yield* fs.makeDirectory(path.join(named, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(named, ".claude-plugin", "plugin.json"),
        '{"name":"acme"}',
      );
      yield* writeSkill(path.join(named, "skills"), "qa", "---\ndescription: QA a ticket\n---\n");
      yield* writeSkill(path.join(installed, "skills"), "old", "# Old");
      yield* writeSkill(path.join(unnamed, "skills"), "lint", "# Lint");
      yield* writeSkill(path.join(muted, "skills"), "hidden", "# Hidden");
      const quiet = path.join(workspace, "quiet");
      yield* fs.makeDirectory(path.join(quiet, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(quiet, ".claude-plugin", "plugin.json"),
        '{"name":"quiet","defaultEnabled":false}',
      );
      yield* writeSkill(path.join(quiet, "skills"), "hush", "# Hush");
      const bundle = path.join(workspace, "bundle");
      yield* fs.makeDirectory(path.join(bundle, "tools", ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(bundle, "tools", ".claude-plugin", "plugin.json"),
        '{"name":"tools"}',
      );
      yield* writeSkill(path.join(bundle, "tools", "skills"), "fmt", "# Fmt");
      yield* writeSkill(path.join(bundle, "loose", "skills"), "ignored", "# Ignored");
      yield* writeSkill(path.join(inherited, "skills"), "stale", "# Stale");
      yield* writeSkill(path.join(workspace, "relative", "skills"), "skipped", "# Skipped");
      yield* fs.makeDirectory(path.join(configDir, "plugins"), { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "acme@shop": [{ scope: "user", installPath: installed }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: { "acme@shop": true, "muted@inline": false },
          env: {
            CLAUDE_CODE_PLUGIN_DIRS: [named, "relative", ` ${unnamed} `, muted, quiet, bundle].join(
              ";",
            ),
          },
        }),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace, {
        CLAUDE_CODE_PLUGIN_DIRS: inherited,
      });
      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "acme:qa", scope: "user", description: "QA a ticket" },
          { name: "tools:fmt", scope: "user", description: undefined },
          { name: "unnamed:lint", scope: "user", description: undefined },
        ],
      );

      // Managed enabledPlugins entries lock their plugin name against inline copies.
      const programFiles = path.join(workspace, "program-files");
      yield* fs.makeDirectory(path.join(programFiles, "ClaudeCode"), { recursive: true });
      yield* fs.writeFileString(
        path.join(programFiles, "ClaudeCode", "managed-settings.json"),
        '{"enabledPlugins":{"acme@shop":true}}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: path.join(workspace, "empty") }, workspace, {
          CLAUDE_CODE_PLUGIN_DIRS: [named, unnamed].join(";"),
          PROGRAMDATA: programFiles,
        })).map((skill) => skill.name),
        ["unnamed:lint"],
      );

      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: path.join(workspace, "empty") }, workspace, {
          CLAUDE_CODE_PLUGIN_DIRS: inherited,
        })).map((skill) => skill.name),
        ["inherited:stale"],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});

it.layer(NodeServices.layer)("Claude discovery settings limits", (it) => {
  it.effect("ignores oversized settings for both skill overrides and environment routing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "home");
      const inherited = path.join(root, "inherited");
      const configured = path.join(root, "configured");
      yield* writeSkill(path.join(home, "skills"), "personal", "# Personal");
      yield* writeSkill(path.join(inherited, "skills"), "chosen", "# Chosen");
      yield* writeSkill(path.join(configured, "skills"), "wrong", "# Wrong");
      yield* fs.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({
          skillOverrides: { personal: "off" },
          env: { CLAUDE_CODE_PLUGIN_DIRS: configured },
          padding: "x".repeat(2 * 1024 * 1024),
        }),
      );
      const skills = yield* discoverClaudeSkills({ homePath: home }, root, {
        CLAUDE_CODE_PLUGIN_DIRS: inherited,
      });
      assert.deepEqual(
        skills.map(({ name, enabled }) => [name, enabled]),
        [
          ["inherited:chosen", true],
          ["personal", true],
        ],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});
