import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  GoatclawSettings,
  PermissionProfile,
  BUILTIN_PERMISSION_PROFILES,
} from "./permissionProfiles.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeProfile = Schema.decodeUnknownSync(PermissionProfile);
const decodePolicy = Schema.decodeSync(GoatclawSettings);

describe("permission profile contracts", () => {
  it("keeps goatclaw opt-in and supplies five named profiles on upgrade", () => {
    const { goatclaw } = decodeSettings({});
    expect(goatclaw.enabled).toBe(false);
    expect(goatclaw.defaultProfile).toBe("worker");
    expect(Object.keys(goatclaw.profiles)).toEqual([
      "observer",
      "worker",
      "manager",
      "merge-manager",
      "owner",
    ]);
    for (const [id, profile] of Object.entries(goatclaw.profiles)) {
      expect(profile.id).toBe(id);
      expect(profile.capabilities.includes("cloud.launch")).toBe(id === "owner");
      expect(profile.capabilities.includes("boat.start")).toBe(id === "owner");
    }
  });

  it("round-trips custom host and budget ceilings and permits an empty host allowlist", () => {
    const profile = {
      ...BUILTIN_PERMISSION_PROFILES.worker!,
      id: "local",
      hosts: [],
      maxTurns: 5,
      maxWallClockMs: 1000,
    };
    const codec = Schema.fromJsonString(PermissionProfile);
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(profile))).toEqual(profile);
    expect(
      decodePatch({
        goatclaw: { enabled: true, defaultProfile: "local", profiles: { local: profile } },
      }),
    ).toMatchObject({ goatclaw: { profiles: { local: profile } } });
  });

  it("rejects unknown capabilities, invalid limits and dangling profile ids", () => {
    for (const patch of [
      { capabilities: ["shell.run"] },
      { maxLanes: -1 },
      { maxLanes: 1.5 },
      { maxTurns: 0 },
      { maxWallClockMs: -1 },
    ])
      expect(() =>
        decodeProfile({
          ...BUILTIN_PERMISSION_PROFILES.worker,
          ...patch,
        }),
      ).toThrow();
    expect(() => decodePolicy({ defaultProfile: "missing" })).toThrow();
    expect(() =>
      decodePolicy({
        defaultProfile: "worker",
        profiles: { worker: BUILTIN_PERMISSION_PROFILES.owner! },
      }),
    ).toThrow();
  });
});
