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

it.layer(NodeServices.layer)("discoverClaudeSkills synced plugins", (it) => {
  it.effect("discovers skills from the current account's claude.ai synced plugins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const synced = path.join(configDir, "plugins", "synced");
      const organization = "11111111-2222-4333-8444-555555555555";
      const writeBucket = Effect.fn(function* (account: string, skillSuffix = "") {
        const bucket = path.join(synced, `${organization}_${account}`);
        const plugins = [
          {
            pluginId: "plugin_01pstack",
            name: "pstack",
            directory: "pstack",
            skill: "poteto-mode",
          },
          {
            pluginId: "plugin_01design",
            name: "0f6a7c9e-1111-4222-8333-444444444444",
            generation: 2,
            directory: "0f6a7c9e-1111-4222-8333-444444444444~g2",
            prefix: "design",
            skill: "design-critique",
          },
        ];
        for (const plugin of plugins) {
          const pluginDir = path.join(bucket, plugin.directory);
          yield* writeSkill(path.join(pluginDir, "skills"), plugin.skill + skillSuffix, "# Synced");
          yield* fs.makeDirectory(path.join(pluginDir, ".claude-plugin"));
          yield* fs.writeFileString(
            path.join(pluginDir, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: plugin.prefix ?? plugin.name }),
          );
        }
        yield* fs.writeFileString(
          path.join(bucket, "manifest.json"),
          JSON.stringify({
            lastUpdated: 1761990000000,
            plugins: plugins.map(({ pluginId, name, generation }) => ({
              pluginId,
              name,
              ...(generation ? { generation } : {}),
            })),
          }),
        );
        yield* fs.writeFileString(path.join(synced, `.bucket-${organization}_${account}`), "");
        return bucket;
      });
      const bucket = yield* writeBucket("66666666-7777-4888-9999-aaaaaaaaaaaa");
      yield* writeBucket("77777777-8888-4999-aaaa-bbbbbbbbbbbb", "-other-account");
      yield* fs.writeFileString(
        path.join(configDir, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            organizationUuid: organization,
            accountUuid: "66666666-7777-4888-9999-aaaaaaaaaaaa",
          },
        }),
      );

      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {})).map((skill) => [
          skill.name,
          skill.path,
        ]),
        [
          [
            "design:design-critique",
            path.join(
              bucket,
              "0f6a7c9e-1111-4222-8333-444444444444~g2",
              "skills",
              "design-critique",
              "SKILL.md",
            ),
          ],
          ["pstack:poteto-mode", path.join(bucket, "pstack", "skills", "poteto-mode", "SKILL.md")],
        ],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(configDir, "relocated-cache"),
        })).map((skill) => skill.name),
        ["design:design-critique", "pstack:poteto-mode"],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_OAUTH_TOKEN: "token",
          CLAUDE_CODE_ACCOUNT_UUID: "77777777-8888-4999-aaaa-bbbbbbbbbbbb",
        })).map((skill) => skill.name),
        ["design:design-critique-other-account", "pstack:poteto-mode-other-account"],
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"pstack@synced":false}}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {})).map(
          (skill) => skill.name,
        ),
        ["design:design-critique"],
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, undefined, {}), []);
    }),
  );

  it.effect("gives a synced namespace to an installed plugin, then the first synced row", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const bucketName = "11111111-2222-4333-8444-555555555555_unbound";
      const synced = path.join(configDir, "plugins", "synced");
      const bucket = path.join(synced, bucketName);
      for (const [directory, prefix, skill] of [
        ["pstack", "pstack", "poteto-mode"],
        ["pstack-copy", "pstack", "copied"],
        ["tools", "tools", "synced-tool"],
        ["a_b", undefined, "renamed"],
        ["pstack-shouted", "PSTACK", "shouted"],
      ] as const) {
        yield* writeSkill(path.join(bucket, directory, "skills"), skill, "# Synced");
        if (prefix === undefined) continue;
        yield* fs.makeDirectory(path.join(bucket, directory, ".claude-plugin"));
        yield* fs.writeFileString(
          path.join(bucket, directory, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: prefix }),
        );
      }
      yield* fs.writeFileString(
        path.join(bucket, "manifest.json"),
        JSON.stringify({
          plugins: ["pstack", "pstack-copy", "tools", "a:b. ", "pstack-shouted", "no-id"].map(
            (name, index) => (name === "no-id" ? { name } : { pluginId: `plugin_0${index}`, name }),
          ),
        }),
      );
      yield* fs.writeFileString(path.join(synced, `.bucket-${bucketName}`), "");
      const installed = path.join(configDir, "plugins", "cache", "shop", "tools");
      yield* writeSkill(path.join(installed, "skills"), "installed-tool", "# Installed");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "tools@shop": [{ scope: "user", installPath: installed }],
            "pstack@shop": [{ scope: "user", installPath: path.join(configDir, "missing") }],
          },
        }),
      );
      const names = (enabled: boolean) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            path.join(configDir, "settings.json"),
            JSON.stringify({ enabledPlugins: { "tools@shop": enabled, "pstack@shop": true } }),
          );
          const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
            CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
            CLAUDE_CODE_ACCOUNT_UUID: "not-a-uuid",
          });
          return skills.map((skill) => skill.name);
        });

      assert.deepEqual(yield* names(true), [
        "a_b:renamed",
        "pstack:poteto-mode",
        "tools:installed-tool",
      ]);
      assert.deepEqual(yield* names(false), [
        "a_b:renamed",
        "pstack:poteto-mode",
        "tools:synced-tool",
      ]);
      yield* writeSkill(path.join(bucket, "no-id", "skills"), "unlisted", "# Synced");
      assert.notInclude(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
        })).map((skill) => skill.name),
        "no-id:unlisted",
      );
    }),
  );

  it.effect("hides synced plugins from local settings but not shared project settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const bucketName =
        "11111111-2222-4333-8444-555555555555_66666666-7777-4888-9999-aaaaaaaaaaaa";
      const synced = path.join(configDir, "plugins", "synced");
      yield* writeSkill(path.join(synced, bucketName, "pstack", "skills"), "poteto-mode", "# S");
      yield* fs.writeFileString(
        path.join(synced, bucketName, "manifest.json"),
        '{"plugins":[{"pluginId":"plugin_01pstack","name":"pstack"}]}',
      );
      yield* fs.writeFileString(path.join(synced, `.bucket-${bucketName}`), "");
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      const environment = {
        CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
        CLAUDE_CODE_ACCOUNT_UUID: "66666666-7777-4888-9999-AAAAAAAAAAAA",
      };
      const names = Effect.map(
        discoverClaudeSkills({ homePath: configDir }, workspace, environment),
        (skills) => skills.map((skill) => skill.name),
      );
      assert.deepEqual(yield* names, ["pstack:poteto-mode"]);
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      assert.deepEqual(yield* names, []);
    }),
  );
});
