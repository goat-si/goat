import { describe, expect, it, vi } from "vite-plus/test";
import { sortPinnedThreadsByOrderKey } from "@goat/client-runtime/state/thread-sort";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  PrimaryConnectionTarget,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  createProjectsViewEnvironmentAtoms,
  isProjectsViewPinnedThread,
  isProjectsViewListedThread,
  projectsViewProjectKeyByScopedRef,
  resolveProjectsViewPreview,
  resolveProjectConnectionStatus,
  resolveProjectsViewProjectConnectionStatus,
  resolveProjectsViewThreadOrder,
} from "./LegacySidebar.logic";

const pinned = {
  pinnedAt: "2026-10-12T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
  lineage: {
    parentThreadId: null,
    rootThreadId: ThreadId.make("root"),
    relationshipToParent: null,
  },
};

describe("Projects view pins", () => {
  it("keeps standalone pins, including forks", () => {
    expect(isProjectsViewPinnedThread(pinned)).toBe(true);
    expect(
      isProjectsViewPinnedThread({
        ...pinned,
        lineage: {
          ...pinned.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "fork",
        },
      }),
    ).toBe(true);
  });
  it("excludes unpinned, archived, deleted and child agent threads", () => {
    expect(isProjectsViewPinnedThread({ ...pinned, pinnedAt: null })).toBe(false);
    expect(isProjectsViewPinnedThread({ ...pinned, archivedAt: pinned.pinnedAt })).toBe(false);
    expect(isProjectsViewPinnedThread({ ...pinned, deletedAt: pinned.pinnedAt })).toBe(false);
    expect(
      isProjectsViewPinnedThread({
        ...pinned,
        lineage: {
          ...pinned.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      }),
    ).toBe(false);
  });
  it("jumps to pins first and keeps project order without duplicates across hosts", () => {
    const orderedPins = sortPinnedThreadsByOrderKey([
      { id: "same", environmentId: "remote", createdAt: "2026-10-12T00:00:00Z", pinOrderKey: "b" },
      { id: "same", environmentId: "local", createdAt: "2026-10-11T00:00:00Z", pinOrderKey: "a" },
    ]).map((thread) => `${thread.environmentId}:${thread.id}`);
    expect(
      resolveProjectsViewThreadOrder(orderedPins, [
        "remote:other",
        "local:same",
        "remote:same",
        "local:last",
        "remote:other",
      ]),
    ).toEqual(["local:same", "remote:same", "remote:other", "local:last"]);
    expect(resolveProjectsViewThreadOrder([], ["local:first", "remote:last"])).toEqual([
      "local:first",
      "remote:last",
    ]);
    expect(resolveProjectsViewThreadOrder(orderedPins, [])).toEqual(orderedPins);
  });
});

describe("Projects view pinned section", () => {
  it("keeps a pin whose project is an older duplicate registration of the same folder", () => {
    const environmentId = EnvironmentId.make("home-mac");
    const registration = (id: string, updatedAt: string) => ({
      id: ProjectId.make(id),
      environmentId,
      title: "goat",
      workspaceRoot: "/work/goat",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [
        registration("older", "2026-10-01T00:00:00.000Z"),
        registration("newer", "2026-10-20T00:00:00.000Z"),
      ],
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: () => "Home",
    });
    const projectKeys = projectsViewProjectKeyByScopedRef(groups);
    expect(projectKeys.get(`${environmentId}:older`)).toBe(groups[0]?.projectKey);
    expect(projectKeys.get(`${environmentId}:newer`)).toBe(groups[0]?.projectKey);
  });
});

describe("Projects view rows", () => {
  const row = { ...pinned, pinnedAt: null };
  const subagent = {
    ...row,
    lineage: {
      ...row.lineage,
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
    },
  };
  it("lists live unpinned threads and forks once", () => {
    expect(isProjectsViewListedThread(row)).toBe(true);
    expect(
      isProjectsViewListedThread({
        ...subagent,
        lineage: { ...subagent.lineage, relationshipToParent: "fork" },
      }),
    ).toBe(true);
    expect(isProjectsViewListedThread(pinned)).toBe(false);
    expect(isProjectsViewListedThread({ ...row, archivedAt: pinned.pinnedAt })).toBe(false);
    expect(isProjectsViewListedThread({ ...row, archivedAt: pinned.pinnedAt }, true)).toBe(true);
    expect(
      isProjectsViewListedThread(
        { ...row, archivedAt: pinned.pinnedAt, deletedAt: pinned.pinnedAt },
        true,
      ),
    ).toBe(false);
  });
  it("never lists a subagent, pinned or not", () => {
    expect(isProjectsViewListedThread(subagent)).toBe(false);
    expect(isProjectsViewListedThread({ ...subagent, pinnedAt: pinned.pinnedAt })).toBe(false);
  });
  it("keeps the open subagent's owner past the preview limit, in order", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const preview = (owner: string | null) =>
      resolveProjectsViewPreview(keys, 2, owner, (key) => key);
    expect(preview(null)).toEqual(["a", "b"]);
    expect(preview("b")).toEqual(["a", "b"]);
    expect(preview("d")).toEqual(["a", "b", "d"]);
    expect(preview("other-project")).toEqual(["a", "b"]);
    expect(resolveProjectsViewPreview(keys, 10, "d", (key) => key)).toEqual(keys);
  });
});

describe("Projects view shared range selection", () => {
  it.each([
    { anchor: "local:pin", target: "local:last" },
    { anchor: "local:last", target: "local:pin" },
  ])("selects across sections from $anchor to $target", ({ anchor, target }) => {
    const order = resolveProjectsViewThreadOrder(
      ["local:pin", "remote:pin"],
      ["local:first", "local:pin", "local:last"],
    );
    const selection = useThreadSelectionStore.getState();
    selection.clearSelection();
    try {
      selection.setAnchor(anchor);
      selection.rangeSelectTo(target, order);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        "local:pin",
        "remote:pin",
        "local:first",
        "local:last",
      ]);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(anchor);
    } finally {
      selection.clearSelection();
    }
  });
});

describe("Projects view environment subscriptions", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  function entry(id: EnvironmentId, label: string) {
    return {
      target: new PrimaryConnectionTarget({
        environmentId: id,
        label,
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      }),
    };
  }
  function connection(
    phase: EnvironmentConnectionPresentation["phase"],
    error: string | null = null,
  ): EnvironmentConnectionPresentation {
    return { phase, error, traceId: null };
  }
  it("ignores presentation/config refreshes and keeps local row props stable on remote phase changes", () => {
    const catalogAtom = Atom.make({
      entries: new Map([
        [local, entry(local, "Desktop")],
        [remote, entry(remote, "Remote")],
      ]),
    });
    const presentationsAtom = Atom.make(
      new Map([
        [local, { connection: connection("connected"), configRevision: 0 }],
        [remote, { connection: connection("connecting"), configRevision: 0 }],
      ]),
    );
    const atoms = createProjectsViewEnvironmentAtoms({ catalogAtom, presentationsAtom });
    const registry = AtomRegistry.make();
    const metadata = registry.get(atoms.metadataAtom);
    const phases = registry.get(atoms.connectionPhasesAtom);
    const metadataChanged = vi.fn();
    const phaseChanged = vi.fn();
    const stops = [
      registry.subscribe(atoms.metadataAtom, metadataChanged),
      registry.subscribe(atoms.connectionPhasesAtom, phaseChanged),
    ];
    try {
      const localProject = { memberProjects: [{ environmentId: local }] };
      const remoteProject = { memberProjects: [{ environmentId: remote }] };
      registry.set(
        presentationsAtom,
        new Map([
          [local, { connection: connection("connected"), configRevision: 1 }],
          [
            remote,
            { connection: connection("connecting", "new transport detail"), configRevision: 1 },
          ],
        ]),
      );
      expect(registry.get(atoms.connectionPhasesAtom)).toBe(phases);
      expect(registry.get(atoms.metadataAtom)).toBe(metadata);
      expect(phaseChanged).not.toHaveBeenCalled();
      expect(metadataChanged).not.toHaveBeenCalled();
      registry.set(
        presentationsAtom,
        new Map([
          [local, { connection: connection("connected"), configRevision: 1 }],
          [remote, { connection: connection("connected"), configRevision: 1 }],
        ]),
      );
      const connected = registry.get(atoms.connectionPhasesAtom);
      expect(phaseChanged).toHaveBeenCalledTimes(1);
      expect(metadataChanged).not.toHaveBeenCalled();
      expect(registry.get(atoms.metadataAtom)).toBe(metadata);
      expect(resolveProjectsViewProjectConnectionStatus(localProject, local, phases)).toBeNull();
      expect(resolveProjectsViewProjectConnectionStatus(localProject, local, connected)).toBeNull();
      expect(resolveProjectsViewProjectConnectionStatus(remoteProject, local, phases)).toBe(
        "connecting",
      );
      expect(resolveProjectsViewProjectConnectionStatus(remoteProject, local, connected)).toBe(
        "connected",
      );
      expect(resolveProjectsViewProjectConnectionStatus(localProject, null, connected)).toBe(
        "connected",
      );
      registry.set(catalogAtom, {
        entries: new Map([
          [local, entry(local, "Desktop")],
          [remote, entry(remote, "Remote")],
        ]),
      });
      expect(registry.get(atoms.metadataAtom)).toBe(metadata);
      expect(metadataChanged).not.toHaveBeenCalled();
      registry.set(catalogAtom, {
        entries: new Map([
          [local, entry(local, "Desktop")],
          [remote, entry(remote, "Renamed")],
        ]),
      });
      expect(registry.get(atoms.metadataAtom).get(remote)?.label).toBe("Renamed");
      expect(metadataChanged).toHaveBeenCalledTimes(1);
    } finally {
      stops.forEach((stop) => stop());
      registry.dispose();
    }
  });
});

describe("remote project connection dot", () => {
  it("is green only when all remote members are connected", () => {
    expect(resolveProjectConnectionStatus(["connected", "connected"])).toBe("connected");
  });
  it.each(["connecting", "reconnecting"] as const)("is gray while %s", (phase) => {
    expect(resolveProjectConnectionStatus(["connected", phase])).toBe("connecting");
  });
  it.each(["offline", "error", "available", "unsupported"] as const)(
    "is red when a remote member is %s",
    (phase) => {
      expect(resolveProjectConnectionStatus(["connected", phase, "connecting"])).toBe(
        "disconnected",
      );
    },
  );
  it("is red when the connection is not known", () => {
    expect(resolveProjectConnectionStatus([])).toBe("disconnected");
  });
});
