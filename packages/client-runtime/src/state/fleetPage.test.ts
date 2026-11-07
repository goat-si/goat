import { EnvironmentId, ProviderInstanceId, ThreadId, type CloudRunSummary } from "@goat/contracts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type {
  EnvironmentConnectionPresentation,
  EnvironmentPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import type { FleetShell } from "./fleet.ts";
import { createFleetPageAtoms } from "./fleetPage.ts";
import { createEnvironmentSummaryAtoms } from "./presentation.ts";

const hub = EnvironmentId.make("hub");
const node = EnvironmentId.make("node");
const codex = ProviderInstanceId.make("codex");

function running(environmentId: EnvironmentId, id: string): FleetShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    title: id,
    providerInstanceId: codex,
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: codex,
      providerName: null,
      lastError: null,
      updatedAt: "2026-10-30T00:00:00.000Z",
    },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    sideChatOf: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    pendingSubagentRequest: null,
    nativeSubagents: [],
    latestUserMessageAt: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    source: { pendingRuntimeRequest: null },
  };
}

function fleetFor(
  connections: ReadonlyMap<EnvironmentId, EnvironmentConnectionPresentation>,
  options: { readonly runs?: ReadonlyArray<CloudRunSummary>; readonly now?: () => number } = {},
) {
  const entries = new Map(
    [...connections.keys()].map((environmentId) => [
      environmentId,
      {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ]),
  );
  const catalogValueAtom = Atom.make<EnvironmentCatalogState>({ isReady: true, entries });
  const presentationAtom = Atom.family((id: EnvironmentId) =>
    Atom.make<EnvironmentPresentation | null>({
      entry: entries.get(id)!,
      connection: connections.get(id)!,
      serverConfig: null,
    }),
  );
  const summaries = createEnvironmentSummaryAtoms({ catalogValueAtom, presentationAtom });
  const empty = <A>(value: A) =>
    Atom.family((_key: unknown) => Atom.make(AsyncResult.success(value)));
  const launches = empty({ launches: [] });
  const machines = empty({ machines: [] });
  const runs = empty({ runs: options.runs ?? [] });
  return createFleetPageAtoms({
    catalogValueAtom,
    connectedEnvironmentIdsAtom: summaries.connectedEnvironmentIdsAtom,
    machineByIdAtom: summaries.machineByIdAtom,
    presentationAtom,
    serverConfigsAtom: Atom.make(new Map()),
    primaryEnvironmentIdAtom: Atom.make(null),
    threadShellsAtom: Atom.make([running(hub, "on-hub"), running(node, "cached-on-node")]),
    remoteLaunches: (target) => launches(target.environmentId),
    cloudMachines: (target) => machines(target.environmentId),
    cloudAgentRuns: (target) => runs(target.environmentId),
    labelPrefix: "test-",
    now: options.now ?? (() => 0),
  });
}

describe("createFleetPageAtoms", () => {
  it("counts threads only on machines that answer and says why a hub device does not", () => {
    const fleet = fleetFor(
      new Map<EnvironmentId, EnvironmentConnectionPresentation>([
        [hub, { phase: "connected", error: null, traceId: null }],
        [
          node,
          { phase: "reconnecting", error: "Host is asleep", traceId: null, unreachable: true },
        ],
      ]),
    );
    const registry = AtomRegistry.make();
    const { snapshot, connections } = registry.get(fleet.fleetPageAtom);

    expect(snapshot.totals).toEqual({ running: 1, attention: 0, reported: 0, machines: 1 });
    expect(snapshot.threads.map((thread) => thread.title)).toEqual(["on-hub"]);
    const away = snapshot.machines.find((machine) => machine.environmentId === node)!;
    expect(away.answering).toBe(false);
    expect(connections.get(away.id)).toMatchObject({ state: "unreachable", label: "Unreachable" });
  });

  it("counts a device's threads once it connects", () => {
    const fleet = fleetFor(
      new Map<EnvironmentId, EnvironmentConnectionPresentation>([
        [hub, { phase: "connected", error: null, traceId: null }],
        [node, { phase: "connected", error: null, traceId: null }],
      ]),
    );
    const { snapshot } = AtomRegistry.make().get(fleet.fleetPageAtom);
    expect(snapshot.totals).toEqual({ running: 2, attention: 0, reported: 0, machines: 2 });
  });

  it("shows a cloud run while it runs and for 15 minutes after it last changed, then drops its provider", () => {
    const start = Date.parse("2026-10-30T12:00:00.000Z");
    vi.useFakeTimers({ now: start });
    try {
      const at = (minutesAgo: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(start - minutesAgo * 60_000));
      const run = (id: string, overrides: Partial<CloudRunSummary>): CloudRunSummary => ({
        threadId: ThreadId.make(id),
        provider: "cursorCloud",
        instanceId: ProviderInstanceId.make("cursorCloud"),
        title: id,
        status: "succeeded",
        tracking: "polled",
        repository: "https://github.com/goat-si/goat",
        registered: false,
        updatedAt: at(0),
        ...overrides,
      });
      const fleet = fleetFor(
        new Map<EnvironmentId, EnvironmentConnectionPresentation>([
          [hub, { phase: "connected", error: null, traceId: null }],
        ]),
        {
          runs: [
            run("live", { status: "running", updatedAt: at(120) }),
            run("cursor-done", { updatedAt: at(5) }),
            run("devin-done", { provider: "devinCloud", updatedAt: at(8) }),
            run("claude-link", {
              provider: "claudeCloud",
              tracking: "link-only",
              updatedAt: at(60),
            }),
          ],
          now: () => vi.getMockedSystemTime()?.getTime() ?? start,
        },
      );
      // Runs node removal at once, so unsubscribing disposes the atom inside the test.
      const registry = AtomRegistry.make({
        scheduleTask: (task) => {
          task();
          return () => {};
        },
      });
      const unsubscribe = registry.subscribe(fleet.fleetCloudAgentsAtom, () => {});
      const shown = () =>
        registry
          .get(fleet.fleetCloudAgentsAtom)
          .map((group) => [group.label, group.runs.map((entry) => entry.title)]);
      expect(shown()).toEqual([
        ["Cursor Cloud", ["live", "cursor-done"]],
        ["Devin Cloud", ["devin-done"]],
      ]);

      vi.advanceTimersByTime(7 * 60_000);
      expect(shown()).toEqual([["Cursor Cloud", ["live", "cursor-done"]]]);
      vi.advanceTimersByTime(3 * 60_000);
      expect(shown()).toEqual([["Cursor Cloud", ["live"]]]);

      unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
