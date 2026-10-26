import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTrayMenu } from "./desktopTray";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const project = ProjectId.make("project");
const codex = ProviderInstanceId.make("codex");

type Shell = Parameters<typeof deriveTrayMenu>[0][number];

function shell(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly status?: "running" | "idle" | null;
    readonly background?: boolean;
    readonly approval?: boolean;
    readonly guests?: number;
    readonly pinOrderKey?: string;
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly subagent?: boolean;
    readonly updatedAt?: string;
  } = {},
): Shell {
  const status = options.status === undefined ? null : options.status;
  return {
    environmentId: options.environmentId ?? local,
    id: ThreadId.make(id),
    projectId: project,
    title: id,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: codex,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-27T00:00:00.000Z",
          },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: options.guests ?? 0,
    pendingBackgroundTasks: options.background
      ? ([{ kind: "command" }] as unknown as Shell["pendingBackgroundTasks"])
      : [],
    archivedAt: options.archived ? "2026-10-27T00:00:00.000Z" : null,
    deletedAt: options.deleted ? "2026-10-27T00:00:00.000Z" : null,
    sideChatOf: null,
    lineage: options.subagent
      ? {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        }
      : { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    pinnedAt: options.pinOrderKey === undefined ? null : "2026-10-27T00:00:00.000Z",
    pinOrderKey: options.pinOrderKey ?? null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-27T00:00:00.000Z",
  };
}

const ids = (rows: ReadonlyArray<{ readonly threadId: string }>) => rows.map((row) => row.threadId);

describe("deriveTrayMenu", () => {
  it("lists each thread once, attention before running before pinned", () => {
    const menu = deriveTrayMenu(
      [
        shell("asks", { status: "running", approval: true, pinOrderKey: "a" }),
        shell("works", { status: "running", pinOrderKey: "b" }),
        shell("waits-on-background", { status: "idle", background: true }),
        shell("guest", { guests: 1 }),
        shell("pinned", { pinOrderKey: "c" }),
        shell("quiet"),
      ],
      [{ environmentId: local, id: project, title: "goat" }],
      new Set([local]),
    );
    expect(ids(menu.attention)).toEqual(["asks", "guest"]);
    expect(ids(menu.running)).toEqual(["works", "waits-on-background"]);
    expect(ids(menu.pinned)).toEqual(["pinned"]);
    expect(menu.pinned[0]?.project).toBe("goat");
  });

  it("does not report work from an environment whose shells are not live, but keeps its pins", () => {
    const menu = deriveTrayMenu(
      [
        shell("stale-run", { environmentId: remote, status: "running" }),
        shell("stale-ask", { environmentId: remote, approval: true, pinOrderKey: "a" }),
      ],
      [],
      new Set([local]),
    );
    expect(menu.attention).toEqual([]);
    expect(menu.running).toEqual([]);
    expect(ids(menu.pinned)).toEqual(["stale-ask"]);
  });

  it("leaves out archived, deleted and subagent threads", () => {
    const menu = deriveTrayMenu(
      [
        shell("archived", { status: "running", archived: true }),
        shell("deleted", { approval: true, deleted: true }),
        shell("child", { status: "running", subagent: true }),
      ],
      [],
      new Set([local]),
    );
    expect(menu).toEqual({ attention: [], running: [], pinned: [] });
  });

  it("orders pins like the sidebar and caps every section", () => {
    const pins = Array.from({ length: 25 }, (_, index) =>
      shell(`pin-${index}`, { pinOrderKey: String.fromCharCode(122 - index) }),
    );
    const menu = deriveTrayMenu(pins, [], new Set([local]));
    expect(menu.pinned).toHaveLength(20);
    expect(menu.pinned[0]?.threadId).toBe("pin-24");
  });
});
