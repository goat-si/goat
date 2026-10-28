import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
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

describe.each(["codex", "fx"])("built-in skills in the skill menu (%s)", (driver) => {
  const localProvider = { driver: ProviderDriverKind.make(driver) };
  const on = { enableCua: true, disabledBuiltInSkills: [] };
  const names = (skills: ReadonlyArray<{ name: string }>) => skills.map((skill) => skill.name);

  it("a local provider with computer use on lists computer-use and screen-code", () => {
    const listed = withBuiltInProviderSkills([], localProvider, on);
    expect(listed).toMatchObject([
      { name: "computer-use", scope: "builtin", enabled: true },
      { name: "screen-code", scope: "builtin", enabled: true },
    ]);
    expect(getProviderSkillsForSlashMenu(listed, true).map((skill) => skill.name)).toEqual([
      "computer-use",
      "screen-code",
    ]);
  });

  it("a local provider with computer use off still lists screen-code", () => {
    expect(
      names(withBuiltInProviderSkills([], localProvider, { ...on, enableCua: false })),
    ).toEqual(["screen-code"]);
  });

  it("a cloud provider lists neither screen skill", () => {
    expect(withBuiltInProviderSkills([], { driver: ProviderDriverKind.make("muse") }, on)).toEqual(
      [],
    );
  });

  it("keeps a skill switched off in Settings out of the menu", () => {
    const listed = withBuiltInProviderSkills([], localProvider, {
      ...on,
      disabledBuiltInSkills: ["computer-use"],
    });
    expect(names(getProviderSkillsForSlashMenu(listed, true))).toEqual(["screen-code"]);
  });

  it("lets a skill the person wrote with the same name win", () => {
    const own = {
      name: "computer-use",
      path: "/home/me/.agents/skills/computer-use",
      enabled: true,
    };
    const menu = getProviderSkillsForSlashMenu(
      withBuiltInProviderSkills([own], localProvider, on),
      true,
    );
    expect(names(menu)).toEqual(["computer-use", "screen-code"]);
    expect(menu[0]?.path).toBe(own.path);
  });
});

describe("provider workspace snapshot refresh atom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const cwd = "/workspace/project-a";
  const environmentId = EnvironmentId.make("env");
  const withSnapshot = (
    checkedAt: string,
    slashCommandsPending?: boolean,
  ): ReadonlyArray<ServerProvider> => [
    {
      ...provider,
      workspaceSnapshots: [
        {
          ...provider.workspaceSnapshots[0]!,
          checkedAt,
          ...(slashCommandsPending ? { slashCommandsPending } : {}),
        },
      ],
    },
  ];
  const noSnapshot: ReadonlyArray<ServerProvider> = [{ ...provider, workspaceSnapshots: [] }];

  type Response = () =>
    | ReadonlyArray<ServerProvider>
    | null
    | Promise<ReadonlyArray<ServerProvider> | null>;

  function setup(initialProviders: ReadonlyArray<ServerProvider>, initialResponses?: Response[]) {
    const providersAtom = Atom.make<ReadonlyArray<ServerProvider> | null>(initialProviders);
    const responses: Response[] = [...(initialResponses ?? [])];
    const run = vi.fn(async () => {
      const providers = await (responses.shift() ?? (() => null))();
      return providers === null
        ? AsyncResult.failure<{ providers: ReadonlyArray<ServerProvider> }, string>(
            Cause.fail("offline"),
          )
        : AsyncResult.success({ providers });
    });
    const family = createProviderWorkspaceSnapshotRefreshAtomFamily({
      providers: () => providersAtom,
      refreshProviders: { label: "refresh", run },
    });
    const registry = AtomRegistry.make();
    const atom = family({ environmentId, instanceId: provider.instanceId, cwd });
    const unmount = registry.mount(atom);
    return { registry, atom, family, providersAtom, responses, run, unmount };
  }

  it("scans a missing snapshot once and skips a repeat inside the TTL", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, family, responses, run, unmount } = setup(noSnapshot);
    // A second composer on the same target shares the scan.
    registry.mount(family({ environmentId, instanceId: provider.instanceId, cwd }))();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), {
      environmentId,
      input: { instanceId: provider.instanceId, cwd },
    });
    responses.push(() => withSnapshot("2026-01-01T00:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(0);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not rescan a current snapshot, and rescans once it ages past the TTL", () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:01:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse("2026-01-01T00:05:00.000Z"));
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cools down a failed scan, then retries on its own while the scan stays pending", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true));
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying after three failed scans until the TTL lapses", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
    registry.refresh(atom);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(Date.parse("2026-01-01T00:10:00.000Z"));
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(4);
    unmount();
  });

  it("does not retry on a timer when the failed scan left no pending snapshot", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(noSnapshot);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("rescans at once when the server drops the snapshot, lifting TTL and cooldown", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, providersAtom, run, unmount } = setup(noSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(providersAtom, withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(providersAtom, noSnapshot);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("does not scan again when a scan fails after the last subscriber left", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true), [
      async () => {
        await gate;
        return null;
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores provider updates that leave the snapshot status unchanged", () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:01:00.000Z") });
    const { registry, providersAtom, run, unmount } = setup(
      withSnapshot("2026-01-01T00:00:00.000Z"),
    );
    vi.setSystemTime(Date.parse("2026-01-01T00:06:00.000Z"));
    registry.set(providersAtom, withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).not.toHaveBeenCalled();
    unmount();
  });
});

describe("message-named built-in skills in the skill menu", () => {
  const settings = {
    enableCua: false,
    disabledBuiltInSkills: [],
    projectSettingsOverrides: {
      [ProjectId.make("opted-out")]: { builtInSkills: { "goat-discipline": { enabled: false } } },
    },
  };
  const serving = {
    builtInSkills: ["goat-discipline", "goat-docs"],
    projectId: ProjectId.make("ordinary"),
  };
  const menu = (driver: string, context: Parameters<typeof withBuiltInProviderSkills>[3]) =>
    getProviderSkillsForSlashMenu(
      withBuiltInProviderSkills([], { driver: ProviderDriverKind.make(driver) }, settings, context),
      true,
    ).map((skill) => skill.name);

  it("lists advertised skills for providers that carry GOAT instructions", () => {
    expect(menu("codex", serving)).toEqual(["screen-code", "goat-discipline", "goat-docs"]);
    expect(menu("claudeAgent", serving)).toEqual(["screen-code", "goat-discipline", "goat-docs"]);
    expect(menu("fx", serving)).toEqual(["screen-code", "goat-discipline", "goat-docs"]);
    expect(menu("muse", serving)).toEqual([]);
  });

  it("omits a skill absent from an explicit server list", () => {
    expect(menu("codex", { ...serving, builtInSkills: ["goat-discipline"] })).toEqual([
      "screen-code",
      "goat-discipline",
    ]);
  });

  it("keeps discipline on older servers without offering docs", () => {
    expect(menu("codex", { devDisciplineSkill: true })).toEqual(["screen-code", "goat-discipline"]);
    expect(menu("codex", undefined)).toEqual(["screen-code"]);
  });

  it("keeps it out of a project that switched it off and in every other project", () => {
    expect(menu("codex", { ...serving, projectId: ProjectId.make("opted-out") })).toEqual([
      "screen-code",
      "goat-docs",
    ]);
    expect(menu("codex", { ...serving, projectId: null })).toEqual([
      "screen-code",
      "goat-discipline",
      "goat-docs",
    ]);
    expect(menu("fx", { ...serving, projectId: ProjectId.make("opted-out") })).toEqual([
      "screen-code",
      "goat-docs",
    ]);
  });
});
