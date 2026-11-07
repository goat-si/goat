import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { providerTextWithSkills } from "./GoatSkillText.ts";

it.effect("delivers an enabled GOAT skill to eligible drivers, read at send time", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-turn-skills-" });
    const dir = path.join(root, "one");
    yield* fs.makeDirectory(dir);
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), "first instructions");
    const send = (
      text: string,
      current: ServerSettings = DEFAULT_SERVER_SETTINGS,
      driver = "codex",
    ) =>
      providerTextWithSkills(Option.some({ getSettings: Effect.succeed(current) }), {
        message: { text },
        driver,
        globalSkillsDir: root,
        project: Effect.succeed(ProjectId.make("project")),
      });
    expect(yield* send("do $goat:one")).toContain('name="goat:one"');
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), "updated instructions");
    expect(yield* send("do $goat:one")).toContain("updated instructions");
    expect(
      yield* send("do $goat:one", {
        ...DEFAULT_SERVER_SETTINGS,
        disabledGlobalSkills: ["goat:one"],
      }),
    ).toBe("do $goat:one");
    expect(yield* send("do $goat:one", DEFAULT_SERVER_SETTINGS, "muse")).toBe("do $goat:one");
    expect(yield* send("/native $goat:one")).toBe("/native $goat:one");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
