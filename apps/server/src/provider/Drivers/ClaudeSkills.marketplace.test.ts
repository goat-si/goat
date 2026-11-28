import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const writeSkill = (skillsDir: string, name: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(skillsDir, name);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), content);
  });

it.layer(NodeServices.layer)("discoverClaudeSkills marketplace entries", (it) => {
  it.effect("loads only the skills a non-strict marketplace entry declares", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const marketplace = path.join(tempDir, "marketplace");
      const marketplaceJson = JSON.stringify({
        name: "shared-root",
        plugins: [
          { name: "collection-a", source: "./", strict: false, skills: ["./skills/skill-one"] },
          { name: "collection-b", source: "./", strict: false, skills: ["./skills/skill-two"] },
        ],
      });
      // `claude plugin install` copies the whole repository into each plugin's cache folder.
      const installs = ["collection-a", "collection-b"].map((name) =>
        path.join(configDir, "plugins", "cache", "shared-root", name, "abc123"),
      );
      for (const root of [marketplace, ...installs]) {
        yield* writeSkill(path.join(root, "skills"), "skill-one", "# One");
        yield* writeSkill(path.join(root, "skills"), "skill-two", "# Two");
        yield* fs.makeDirectory(path.join(root, ".claude-plugin"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, ".claude-plugin", "marketplace.json"),
          marketplaceJson,
        );
      }
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "known_marketplaces.json"),
        JSON.stringify({
          "shared-root": {
            source: { source: "directory", path: marketplace },
            installLocation: marketplace,
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "collection-a@shared-root": [{ scope: "user", installPath: installs[0] }],
            "collection-b@shared-root": [{ scope: "user", installPath: installs[1] }],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"collection-a@shared-root":true,"collection-b@shared-root":true}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["collection-a:skill-one", "collection-b:skill-two"],
      );
    }).pipe(Effect.scoped),
  );
});
