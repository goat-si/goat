import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

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
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    source: {},
  };
}

function fleetFor(connections: ReadonlyMap<EnvironmentId, EnvironmentConnectionPresentation>) {
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
  const runs = empty({ runs: [] });
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
    now: () => 0,
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
});
