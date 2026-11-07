import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeGlobalSkills } from "./GlobalSkills.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-skills-" });
  return { fs, path, root };
});

describe("global skills", () => {
  it.effect("discovers safe folders, respects disabled names, and removes only symlinks", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      const skills = path.join(root, "skills");
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(skills);
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(
        path.join(outside, "SKILL.md"),
        "---\nname: ../../evil\ndescription: Test\n---\nBody",
      );
      yield* fs.symlink(outside, path.join(skills, "valid"));
      yield* fs.makeDirectory(path.join(skills, "bad_name"));
      yield* fs.writeFileString(path.join(skills, "bad_name", "SKILL.md"), "no");
      yield* fs.makeDirectory(path.join(skills, "empty"));
      yield* fs.makeDirectory(path.join(skills, "not-file", "SKILL.md"), { recursive: true });
      const service = makeGlobalSkills({
        globalSkillsDir: skills,
        disabled: Effect.succeed(["goat:valid"]),
      });
      expect(yield* service.list()).toEqual([
        {
          name: "goat:valid",
          scope: "goat",
          path: path.join(skills, "valid"),
          displayName: "../../evil",
          description: "Test",
          enabled: false,
        },
      ]);
      expect((yield* Effect.flip(service.remove("goat:../outside")))._tag).toBe("GlobalSkillError");
      yield* service.remove("goat:valid");
      expect(yield* fs.readFileString(path.join(outside, "SKILL.md"))).toContain("Body");
      expect((yield* Effect.flip(service.remove("goat:valid")))._tag).toBe("GlobalSkillError");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("caps delivery and collects omitted skills in one notice", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
        yield* fs.makeDirectory(path.join(root, name));
        yield* fs.writeFileString(path.join(root, name, "SKILL.md"), "x".repeat(25_000));
      }
      const service = makeGlobalSkills({
        globalSkillsDir: root,
        disabled: Effect.succeed(["goat:b"]),
      });
      const text = yield* service.readForTurn([
        "goat:a",
        "goat:b",
        "goat:c",
        "goat:d",
        "goat:e",
        "goat:f",
        "goat:g",
        "goat:h",
        "goat:i",
        "goat:a",
      ]);
      expect(text).toContain('name="goat:a"');
      expect(text).not.toContain('name="goat:b"');
      expect(text.length).toBeLessThanOrEqual(48_000);
      expect(text.match(/Read these skills in full from/g)).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("names a single oversized skill in the read-in-full notice", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      yield* fs.makeDirectory(path.join(root, "long"));
      yield* fs.writeFileString(path.join(root, "long", "SKILL.md"), `${"x".repeat(25_000)}END`);
      yield* fs.makeDirectory(path.join(root, "short"));
      yield* fs.writeFileString(path.join(root, "short", "SKILL.md"), "short body");
      const service = makeGlobalSkills({ globalSkillsDir: root, disabled: Effect.succeed([]) });
      const text = yield* service.readForTurn(["goat:long", "goat:short"]);
      expect(text).toContain('name="goat:long"');
      expect(text).not.toContain("END");
      expect(text).toMatch(/Read these skills in full from .*: goat:long$/);
      expect(text).toContain("short body");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

it.effect("scans only the front of large files and caps distinct mentions at eight", () =>
  Effect.gen(function* () {
    const { fs, path, root } = yield* fixture;
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    for (const name of names) {
      yield* fs.makeDirectory(path.join(root, name));
      yield* fs.writeFileString(
        path.join(root, name, "SKILL.md"),
        "---\nname: Visible\n---\nsmall",
      );
    }
    yield* fs.truncate(path.join(root, "a", "SKILL.md"), 64 * 1024 * 1024);
    const service = makeGlobalSkills({ globalSkillsDir: root, disabled: Effect.succeed([]) });
    expect((yield* service.list()).find((skill) => skill.name === "goat:a")?.displayName).toBe(
      "Visible",
    );
    const text = yield* service.readForTurn(names.map((name) => `goat:${name}`));
    expect(text).toContain('name="goat:h"');
    expect(text).not.toContain("goat:i");
    expect(text.length).toBeLessThanOrEqual(48_000);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
