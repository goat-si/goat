import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_SKILL_PROVIDER_DRIVERS, BUILTIN_SKILLS } from "./builtinSkills.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("goat-discipline built-in skill contract", () => {
  it("lists the skill without a capability for the local providers that carry GOAT instructions", () => {
    expect(BUILTIN_SKILLS.find((skill) => skill.name === "goat-discipline")).toMatchObject({
      displayName: "Development discipline",
    });
    expect(BUILTIN_SKILLS.find((skill) => skill.name === "goat-discipline")?.capability).toBe(
      undefined,
    );
    expect([...BUILTIN_SKILL_PROVIDER_DRIVERS].toSorted()).toEqual([
      "acpRegistry",
      "antigravity",
      "claudeAgent",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  it("round-trips a project's skill overrides, names from newer builds included", () => {
    const stored = {
      projectSettingsOverrides: {
        "project-a": {
          builtInSkills: { "goat-discipline": { enabled: false }, "skill-from-a-newer-build": {} },
        },
      },
    };
    const decoded = decodeSettings(stored);
    expect(decoded.projectSettingsOverrides["project-a" as never]?.builtInSkills).toEqual(
      stored.projectSettingsOverrides["project-a"].builtInSkills,
    );
    expect(decodeSettings(encodeSettings(decoded))).toEqual(decoded);
    expect(decodeSettings({}).projectSettingsOverrides).toEqual({});
    expect(
      decodePatch({ projectSettingsOverrides: { "project-a": { builtInSkills: {} } } }),
    ).toEqual({ projectSettingsOverrides: { "project-a": { builtInSkills: {} } } });
  });

  it("decodes environments that do and do not advertise skill delivery", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
    expect(decode({ repositoryIdentity: true, devDisciplineSkill: true }).devDisciplineSkill).toBe(
      true,
    );
    expect(decode({ repositoryIdentity: true }).devDisciplineSkill).toBe(undefined);
  });
});
