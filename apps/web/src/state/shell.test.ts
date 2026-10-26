import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import type { EnvironmentCatalogState } from "@goat/client-runtime/state/connections";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "@goat/client-runtime/state/shell";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createAllEnvironmentProjectSnapshotsReadyAtom,
  createPendingEnvironmentShellIdsAtom,
} from "./shell";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function shellState(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return {
    ...EMPTY_SHELL_STATE,
    status,
    snapshot:
      status === "empty"
        ? Option.none()
        : Option.some({
            schemaVersion: 1,
            snapshotSequence: 1,
            projects: [],
            threads: [],
            archivedThreads: [],
          }),
    error: Option.none(),
  };
}

function catalogState(environmentIds: readonly EnvironmentId[]): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map(
      environmentIds.map((environmentId) => [
        environmentId,
        {
          target:
            environmentId === LOCAL
              ? new PrimaryConnectionTarget({
                  environmentId,
                  label: environmentId,
                  httpBaseUrl: `https://${environmentId}.example.test`,
                  wsBaseUrl: `wss://${environmentId}.example.test`,
                })
              : new BearerConnectionTarget({
                  environmentId,
                  connectionId: environmentId,
                  label: environmentId,
                }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  };
}

function makeHarness(requiresPrimaryEnvironment = true) {
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const shells = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(shellState("empty")),
  );
  const ready = createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: catalog,
    shellStateValueAtom: shells,
    requiresPrimaryEnvironment,
  });
  const registry = AtomRegistry.make();
  return { catalog, shells, ready, registry };
}

describe("project snapshot readiness", () => {
  it("does not clear a saved scope while the ready catalog is still empty", () => {
    const { catalog, ready, registry } = makeHarness();
    expect(registry.get(ready)).toBe(false);
    registry.set(catalog, catalogState([]));
    expect(registry.get(ready)).toBe(false);
    registry.dispose();
  });

  it("waits for primary discovery even if a persisted remote is already live", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([REMOTE]));
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(false);

    registry.set(catalog, catalogState([LOCAL, REMOTE]));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("allows a hosted client to load projects without a primary environment", () => {
    const { catalog, shells, ready, registry } = makeHarness(false);
    registry.set(catalog, catalogState([REMOTE]));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("waits for live snapshots through offline startup and reconnect", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([LOCAL, REMOTE]));
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(false);

    registry.set(shells(REMOTE), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("synchronizing"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(true);

    registry.set(shells(REMOTE), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(REMOTE), shellState("live"));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("stops waiting for an environment only when it leaves the catalog", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([LOCAL, REMOTE]));
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(false);
    registry.set(catalog, catalogState([LOCAL]));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });
});

describe("pending environment shells", () => {
  it("keeps the pending list and bootstrap boolean aligned", () => {
    const catalog = Atom.make<AsyncResult.AsyncResult<EnvironmentCatalogState>>(
      AsyncResult.initial(),
    );
    const shells = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make<EnvironmentShellState>(shellState("empty")),
    );
    const connections = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(AsyncResult.initial()),
    );
    const pending = createPendingEnvironmentShellIdsAtom({
      catalogAtom: catalog,
      shellStateValueAtom: shells,
      connectionStateAtom: connections,
    });
    const bootstrapped = Atom.map(pending, (ids) => ids !== null && ids.length === 0);
    const registry = AtomRegistry.make();

    expect(registry.get(pending)).toBeNull();
    expect(registry.get(bootstrapped)).toBe(false);

    registry.set(catalog, AsyncResult.success(catalogState([LOCAL, REMOTE])));
    registry.set(shells(LOCAL), shellState("live"));
    registry.set(
      connections(REMOTE),
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connecting", desired: true }),
    );
    expect(registry.get(pending)).toEqual([REMOTE]);
    expect(registry.get(bootstrapped)).toBe(false);

    registry.set(
      connections(REMOTE),
      AsyncResult.success({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "backoff",
        desired: true,
        attempt: 3,
      }),
    );
    expect(registry.get(pending)).toEqual([]);
    expect(registry.get(bootstrapped)).toBe(true);

    registry.set(
      connections(REMOTE),
      AsyncResult.success({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "backoff",
        desired: true,
        attempt: 2,
      }),
    );
    expect(registry.get(pending)).toEqual([REMOTE]);
    expect(registry.get(bootstrapped)).toBe(false);
    registry.dispose();
  });
});
