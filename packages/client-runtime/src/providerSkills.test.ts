import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  withBuiltInProviderSkills,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });
});

describe("built-in skills in the skill menu", () => {
  const codex = { driver: ProviderDriverKind.make("codex") };
  const on = { enableCua: true, disabledBuiltInSkills: [] };
  const names = (skills: ReadonlyArray<{ name: string }>) => skills.map((skill) => skill.name);

  it("lists Computer Use for a local provider only while computer use is on", () => {
    const listed = withBuiltInProviderSkills([], codex, on);
    expect(listed).toMatchObject([{ name: "computer-use", scope: "builtin", enabled: true }]);
    expect(getProviderSkillsForSlashMenu(listed, true).map((skill) => skill.name)).toEqual([
      "computer-use",
    ]);
    expect(withBuiltInProviderSkills([], codex, { ...on, enableCua: false })).toEqual([]);
    expect(withBuiltInProviderSkills([], { driver: ProviderDriverKind.make("muse") }, on)).toEqual(
      [],
    );
  });

  it("keeps a skill switched off in Settings out of the menu", () => {
    const listed = withBuiltInProviderSkills([], codex, {
      ...on,
      disabledBuiltInSkills: ["computer-use"],
    });
    expect(getProviderSkillsForSlashMenu(listed, true)).toEqual([]);
  });

  it("lets a skill the person wrote with the same name win", () => {
    const own = {
      name: "computer-use",
      path: "/home/me/.agents/skills/computer-use",
      enabled: true,
    };
    const menu = getProviderSkillsForSlashMenu(withBuiltInProviderSkills([own], codex, on), true);
    expect(names(menu)).toEqual(["computer-use"]);
    expect(menu[0]?.path).toBe(own.path);
  });
});

describe("the goat-discipline built-in skill in the skill menu", () => {
  const settings = {
    enableCua: false,
    disabledBuiltInSkills: [],
    projectSettingsOverrides: {
      [ProjectId.make("opted-out")]: { builtInSkills: { "goat-discipline": { enabled: false } } },
    },
  };
  const serving = { devDisciplineSkill: true, projectId: ProjectId.make("ordinary") };
  const menu = (driver: string, context: Parameters<typeof withBuiltInProviderSkills>[3]) =>
    getProviderSkillsForSlashMenu(
      withBuiltInProviderSkills([], { driver: ProviderDriverKind.make(driver) }, settings, context),
      true,
    ).map((skill) => skill.name);

  it("lists it on an ordinary turn with computer use off, for providers that carry GOAT instructions", () => {
    expect(menu("codex", serving)).toEqual(["goat-discipline"]);
    expect(menu("claudeAgent", serving)).toEqual(["goat-discipline"]);
    expect(menu("muse", serving)).toEqual([]);
  });

  it("hides it on a server that does not deliver it", () => {
    expect(menu("codex", { ...serving, devDisciplineSkill: false })).toEqual([]);
    expect(menu("codex", undefined)).toEqual([]);
  });

  it("keeps it out of a project that switched it off and in every other project", () => {
    expect(menu("codex", { ...serving, projectId: ProjectId.make("opted-out") })).toEqual([]);
    expect(menu("codex", { ...serving, projectId: null })).toEqual(["goat-discipline"]);
  });
});
