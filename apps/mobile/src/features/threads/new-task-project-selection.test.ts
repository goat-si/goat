import { EnvironmentId, ProjectId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/sample-tools/goat",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/sample-tools/goat",
    });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/sample-tools/goat" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/sample-tools/goat",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("new task project choice", () => {
  const picker = { pickerClosed: false, connectedEnvironmentIds: new Set<EnvironmentId>() };
  it("shows the picker for a fresh task even with one project", () => {
    const project = makeProject("first");
    expect(resolveDraftProjectSelection(null, [project], [makeScope([project])], picker)).toEqual({
      kind: "pick",
    });
  });

  it("keeps shared content and selects a connected copy of its only logical project", () => {
    const offline = makeProject("clone-offline", "offline");
    const online = makeProject("clone-online", "online");
    const projects = [offline, online];
    const result = resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
      incomingShareId: "share",
      pickerClosed: true,
      connectedEnvironmentIds: new Set([online.environmentId]),
    });
    expect(result).toEqual({ kind: "select", project: online });
  });

  it("dismisses an untouched draft when its first picker is cancelled", () => {
    const project = makeProject("first");
    expect(
      resolveDraftProjectSelection(null, [project], [makeScope([project])], {
        ...picker,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "dismiss" });
    expect(
      resolveDraftProjectSelection("environment:first", [project], [makeScope([project])], {
        ...picker,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("validates remembered projects and prefers the current thread's project", () => {
    const projects = [makeProject("first"), makeProject("current", "other")];
    const options = {
      projects,
      requestId: "request",
      useLastProject: true,
      currentProject: undefined,
      lastProject: { environmentId: "environment", projectId: "first" },
    };
    expect(newTaskDestination(options)).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "first" },
    });
    expect(
      newTaskDestination({
        ...options,
        currentProject: { environmentId: "other", projectId: "current" },
      }),
    ).toEqual({ draft: { requestId: "request", environmentId: "other", projectId: "current" } });
    expect(
      newTaskDestination({
        ...options,
        lastProject: { environmentId: "removed", projectId: "first" },
      }),
    ).toEqual({ draft: { requestId: "request" } });
    expect(newTaskDestination({ ...options, lastProject: undefined })).toEqual({
      draft: { requestId: "request" },
    });
  });

  it("honors Use last project together with B27's connected-project selection", () => {
    const offline = makeProject("offline-copy", "offline");
    const online = makeProject("online-copy", "online");
    const projects = [offline, online];
    const scope = makeScope(projects);
    const options = {
      projects,
      projectScopes: [scope],
      connectedEnvironmentIds: new Set([online.environmentId]),
      requestId: "request",
      useLastProject: true,
      currentProject: undefined,
      lastProject: { environmentId: "offline", projectId: "offline-copy" },
    };
    expect(newTaskDestination(options)).toEqual({
      draft: { requestId: "request", environmentId: "online", projectId: "online-copy" },
    });
    expect(newTaskDestination({ ...options, useLastProject: false })).toEqual({
      draft: { requestId: "request" },
    });
    expect(
      getProjectScopeSelectionTarget(scope, offline.environmentId, options.connectedEnvironmentIds),
    ).toBe(online);
    expect(newTaskDestination({ ...options, useLastProject: undefined })).toEqual(
      newTaskDestination(options),
    );
  });
});
