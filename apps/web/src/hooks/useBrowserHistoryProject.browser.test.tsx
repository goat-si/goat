import { scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

vi.mock("~/state/session", () => ({ readPreparedConnection: () => null }));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  readProject: () => null,
  readProjects: () => [],
  useProjects: () => [],
  useQuietThreadShell: () => null,
}));
vi.mock("./useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@goat/contracts/settings");
  return {
    getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
    useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
    isClientSettingsHydrated: () => true,
    ensureClientSettingsHydrated: () => Promise.resolve(),
  };
});
vi.mock("~/state/environments", () => ({
  readPrimaryEnvironmentId: () => null,
  usePrimaryEnvironmentId: () => null,
}));

import {
  type BrowserHistoryEntry,
  recordVisitForThread,
  resetBrowserHistoryForTests,
  useBrowserHistoryStore,
  useThreadRecentHistory,
} from "../browserHistoryStore";
import type { Project } from "../types";
import { useBrowserHistoryProject } from "./useBrowserHistoryProject";

const environmentId = EnvironmentId.make("env-primary");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const repositoryIdentity = {
  canonicalKey: "github.com/example/browser-history",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/browser-history.git",
  },
};
const project: Project = {
  id: ProjectId.make("project-1"),
  environmentId,
  title: "browser-history",
  workspaceRoot: "/tmp/browser-history",
  repositoryIdentity,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};
const input: Parameters<typeof useBrowserHistoryProject>[0] = {
  threadRef,
  project,
  projects: [project],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: environmentId,
  clientSettingsHydrated: true,
};

function Probe(props: typeof input) {
  useBrowserHistoryProject(props);
  const entries = useThreadRecentHistory(props.threadRef ?? threadRef, 10);
  return <output>{JSON.stringify(entries)}</output>;
}

function expectHistory(screen: Screen, entries: ReadonlyArray<BrowserHistoryEntry>) {
  return expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify(entries));
}

function setup(): Disposable {
  resetBrowserHistoryForTests();
  return { [Symbol.dispose]: resetBrowserHistoryForTests };
}

describe("useBrowserHistoryProject", () => {
  it.each(["server-thread", "draft-thread"])(
    "makes queued and subsequent visits visible and persistent for a %s",
    async (threadId) => {
      using _state = setup();
      const ref = { environmentId, threadId: ThreadId.make(threadId) };
      recordVisitForThread(ref, "https://example.com/queued", 1);
      await using screen = await render(<Probe {...input} threadRef={ref} />);
      await expectHistory(screen, [{ url: "https://example.com/queued", lastVisitedAt: 1 }]);
      expect(useBrowserHistoryStore.getState().pendingVisitsByThreadKey).toEqual({});

      await act(() => recordVisitForThread(ref, "https://example.com/next", 2));
      const recent = [
        { url: "https://example.com/next", lastVisitedAt: 2 },
        { url: "https://example.com/queued", lastVisitedAt: 1 },
      ];
      await expectHistory(screen, recent);
      const storage = useBrowserHistoryStore.persist.getOptions().storage;
      expect((await storage?.getItem("goat:browser-history:v1"))?.state).toMatchObject({
        byProjectKey: { [repositoryIdentity.canonicalKey]: recent },
        projectKeyByThreadKey: { [scopedThreadKey(ref)]: repositoryIdentity.canonicalKey },
      });
    },
  );

  it("waits for client settings hydration before assigning or flushing history", async () => {
    using _state = setup();
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await using screen = await render(<Probe {...input} clientSettingsHydrated={false} />);
    await expectHistory(screen, []);
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});
    expect(
      useBrowserHistoryStore.getState().pendingVisitsByThreadKey[scopedThreadKey(threadRef)],
    ).toHaveLength(1);

    await screen.rerender(<Probe {...input} />);
    await expectHistory(screen, [{ url: "https://example.com/", lastVisitedAt: 1 }]);
  });

  it("uses the sidebar identity borrowed from a duplicate physical project's sibling", async () => {
    using _state = setup();
    const staleProject = {
      ...project,
      id: ProjectId.make("stale-project"),
      repositoryIdentity: null,
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await using screen = await render(
      <Probe {...input} project={staleProject} projects={[staleProject, project]} />,
    );
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({
      [repositoryIdentity.canonicalKey]: [{ url: "https://example.com/", lastVisitedAt: 1 }],
    });
    await expectHistory(screen, [{ url: "https://example.com/", lastVisitedAt: 1 }]);
  });

  it("derives the project key when a draft's project is not in the project list yet", async () => {
    using _state = setup();
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await using screen = await render(<Probe {...input} projects={[]} />);
    await expectHistory(screen, [{ url: "https://example.com/", lastVisitedAt: 1 }]);
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(threadRef)],
    ).toBe(repositoryIdentity.canonicalKey);
  });

  it("leaves a projectless thread queued and binds once its project resolves", async () => {
    using _state = setup();
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await using screen = await render(<Probe {...input} project={null} />);
    await expectHistory(screen, []);
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});

    await screen.rerender(<Probe {...input} />);
    await expectHistory(screen, [{ url: "https://example.com/", lastVisitedAt: 1 }]);
  });

  it("does not bind without an active thread", async () => {
    using _state = setup();
    await using screen = await render(<Probe {...input} threadRef={null} />);
    await expectHistory(screen, []);
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});
  });

  it("rebinds when grouping settings change and isolates the same thread id on another host", async () => {
    using _state = setup();
    recordVisitForThread(threadRef, "https://example.com/local", 1);
    await using screen = await render(<Probe {...input} />);
    const separateSettings = { ...input.settings, sidebarProjectGroupingMode: "separate" as const };
    await screen.rerender(<Probe {...input} settings={separateSettings} />);
    await act(() => recordVisitForThread(threadRef, "https://example.com/separate", 2));
    await expectHistory(screen, [{ url: "https://example.com/separate", lastVisitedAt: 2 }]);
    const remoteRef = { ...threadRef, environmentId: EnvironmentId.make("env-remote") };
    const remoteProject = { ...project, environmentId: remoteRef.environmentId };
    recordVisitForThread(remoteRef, "https://example.com/remote", 3);
    await screen.rerender(
      <Probe
        {...input}
        threadRef={remoteRef}
        project={remoteProject}
        projects={[project, remoteProject]}
        settings={separateSettings}
        primaryEnvironmentId={null}
      />,
    );
    await expectHistory(screen, [{ url: "https://example.com/remote", lastVisitedAt: 3 }]);
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(threadRef)],
    ).toBe("env-primary:/tmp/browser-history");
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(remoteRef)],
    ).toBe("env-remote:/tmp/browser-history");
  });
});
