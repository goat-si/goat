import { memoryImportTestLocks } from "../../test/memoryImportLocks";
import { MemoryHubDiagnosticsSettings } from "./MemoryHubDiagnosticsSettings";
import { MemoryRunAccessLabel } from "./MemoryRunAccessLabel";
import { memorySyncFixture } from "../../test/memorySyncFixture";
import { act, Children, isValidElement, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MemoryItem,
  MemoryRevision,
  MemoryResolution,
  MemoryResolutionPayload,
  type MemoryHistoryPage,
  MemoryRevertResult,
  MemoryUpsertInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
const encodeUpsert = Schema.encodeSync(MemoryUpsertInput);
const state = vi.hoisted(() => ({
  requests: [] as { label: string; input: unknown }[],
  allowed: true,
  write: true,
  version: 0,
  exposure: 0,
  listeners: new Set<() => void>(),
  queries: new Map<string, unknown>(),
  refresh: vi.fn(),
  calls: vi.fn(),
  environment: null as unknown,
  environments: [] as {
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: {
      environment: {
        capabilities: { memory: { protocolVersion: number; resolutionInputs?: boolean } };
      };
    };
  }[],
  result: null as unknown,
  navigate: vi.fn(),
  responses: new Map<string, unknown>(),
  executors: new Map<string, (input: unknown) => Promise<unknown>>(),
  projects: [] as { id: string; environmentId: string; title: string; repositoryIdentity?: null }[],
  threads: [] as { id: string; environmentId: string; title: string }[],
  threadReads: vi.fn(),
  agentAccess: true,
  memoryEnabled: true,
  memoryModel: null as { instanceId: string; model: string } | null,
  connection: {} as object | null,
  deviceConnections: new Map<string, object | null>(),
}));
function useFixtureVersion() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    () => state.version,
  );
}
function notifyFixture() {
  state.version += 1;
  for (const listener of state.listeners) listener();
}
function fixtureAtomValue(atom: { label: string }) {
  return atom.label === "syncChanges"
    ? state.exposure
    : ["forget", "upsert", "projectBindingGet"].includes(atom.label)
      ? state.write
      : state.allowed;
}
vi.mock("@effect/atom-react", async (original) => {
  const { useEffect } = await import("react");
  return {
    ...(await original<typeof import("@effect/atom-react")>()),
    useAtomValue: (atom: { label: string }) => {
      useFixtureVersion();
      return fixtureAtomValue(atom);
    },
    // Like the registry: the current value with immediate, then each change.
    useAtomSubscribe: (
      atom: { label: string },
      f: (value: unknown) => void,
      options?: { readonly immediate?: boolean },
    ) => {
      const immediate = options?.immediate === true;
      useEffect(() => {
        let last = fixtureAtomValue(atom);
        if (immediate) f(last);
        const listener = () => {
          const next = fixtureAtomValue(atom);
          if (next === last) return;
          last = next;
          f(next);
        };
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      }, [atom, f, immediate]);
    },
  };
});
vi.mock("../../state/memory", async () => {
  const { createMemoryImportWorkflow } =
    await import("@goat/client-runtime/memory-import-workflow");
  const { Atom } = await import("effect/reactivity");
  const drafts = Atom.family((_key: string) => {
    const stored = Atom.make<{ text: string; memoryIds: readonly string[] } | null>(null);
    return Atom.writable(
      (get) => get(stored)?.text ?? null,
      (ctx, value: { text: string; memoryIds: readonly string[] } | null) => ctx.set(stored, value),
    );
  });
  return {
    memoryEnvironment: {
      createImportWorkflow: (
        _registry: unknown,
        options: Parameters<typeof createMemoryImportWorkflow>[0],
      ) =>
        createMemoryImportWorkflow({
          ...options,
          canImport: () => state.allowed && state.write,
          request: async (environmentId, input) => {
            const execute = state.executors.get("importProvider");
            if (!execute) throw new Error("No import fixture");
            return (await execute({
              environmentId,
              input,
            })) as import("@goat/contracts").MemoryImportProviderResult;
          },
        }),
      exposureAtom: () => ({ label: "syncChanges" }),
      ...Object.fromEntries(
        [
          "importProvider",
          "resetReportAttempts",
          "projectBindingGet",
          "projectBindingUpdate",
          "syncStatus",
          "hubDiagnostics",
          "hubReconcile",
          "upsert",
          "forget",
          "revertResolution",
          "hubSettingsGet",
          "hubSettingsUpdate",
          "ownerSourceReadPolicyGet",
          "ownerSourceReadPolicyUpdate",
        ].map((label) => [label, { label, permissionAtom: () => ({ label }) }]),
      ),
      ...Object.fromEntries(
        ["list", "search", "read", "history", "readSource"].map((label) => [
          label,
          (request: { input?: { resolutionInputsFor?: string } }) => {
            state.requests.push({ label, input: request.input });
            return {
              label:
                label === "history" && request.input?.resolutionInputsFor
                  ? "resolutionInputs"
                  : label,
            };
          },
        ]),
      ),
      draftAtom: ({ draftId }: { draftId: string }) => drafts(draftId),
    },
  };
});
vi.mock("../../state/entities", () => ({
  useProjects: () => {
    useFixtureVersion();
    return state.projects;
  },
  useThreadShells: (enabled = true) => {
    state.threadReads(enabled);
    useFixtureVersion();
    return enabled ? state.threads : [];
  },
}));
// Covered by its own controls; this page test exercises the memory browser and sharing flows.
vi.mock("./MemoryGenerationSettings", () => ({ MemoryGenerationSettings: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: string, selector: (settings: unknown) => unknown) => {
    useFixtureVersion();
    return selector({
      enableAgentMemoryAccess: state.agentAccess,
      memoryEnabled: state.memoryEnabled,
      memoryModelSelection: state.memoryModel,
      providerInstances: {},
    });
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: {
      label: "updateSettings",
      permissionAtom: () => ({ label: "updateSettings" }),
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: ({ label }: { label: string }) => {
    useFixtureVersion();
    return {
      data:
        state.queries.get(label) ??
        (label === "resolutionInputs" ? state.queries.get("history") : undefined) ??
        Option.none(),
      error: null,
      refresh: state.refresh,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    if (!state.executors.has(command.label))
      state.executors.set(command.label, async (input: unknown) => {
        state.calls(input);
        return state.responses.get(command.label) ?? state.result;
      });
    return state.executors.get(command.label);
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => {
    useFixtureVersion();
    return state.environment;
  },
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  usePreparedConnection: (id: string) => {
    useFixtureVersion();
    return Option.fromNullishOr(
      state.deviceConnections.has(id) ? state.deviceConnections.get(id) : state.connection,
    );
  },
  readPreparedConnection: (id: string) =>
    state.deviceConnections.has(id) ? state.deviceConnections.get(id) : state.connection,
  readEnvironmentScope: () => state.allowed,
  useEnvironmentScope: () => {
    useFixtureVersion();
    return state.allowed;
  },
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: MemoryItem[];
    renderItem: (input: { item: MemoryItem }) => ReactNode;
  }) => (
    <div>
      {data.map((item) => (
        <div key={item.memoryId}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("./MemoryScopePicker", () => ({
  MemoryScopePicker: ({
    items,
    value,
    onChange,
    disabled,
  }: {
    items: { id: string; title: string }[];
    value: string | null;
    onChange: (id: string) => void;
    disabled: boolean;
  }) => (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose</option>
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.title}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (id: string) => void;
    disabled: boolean;
  }) => {
    const trigger = Children.toArray(children).find(
      (child) => isValidElement<{ "aria-label"?: string }>(child) && child.props["aria-label"],
    );
    return (
      <select
        aria-label={
          isValidElement<{ "aria-label"?: string }>(trigger)
            ? trigger.props["aria-label"]
            : "Fixture device picker"
        }
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onValueChange(e.currentTarget.value)}
      >
        <option value="">Choose a device</option>
        {children}
      </select>
    );
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    children,
    value,
    disabled,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div data-test-row>
      {title}
      {description}
      {status}
      {control}
      {children}
    </div>
  ),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children, id }: { children: ReactNode; id?: string }) => (
    <section id={id}>{children}</section>
  ),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { RegistryContext } from "@effect/atom-react";
import {
  MemorySettings,
  MemoryForgetControl,
  MemoryAdministration,
  MemoryRevertControl,
} from "./MemorySettings";
import { validateMemorySettingsSearch } from "./MemorySettings.logic";
import { settingsContentScopeKey } from "./settingsScopeNavigation";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: id(1),
  memoryId: id(2),
  status: "blocked",
  scope: { kind: "user" },
  failureCode: "secret_detected",
  pendingSync: false,
  localAvailability: {
    exposure: "held",
    reasons: ["secret_detected"],
    deferred: [],
    cleanupPending: false,
  },
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: memoryImportTestLocks() });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T00:00:00.000Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
  state.navigate.mockReset();
  state.threadReads.mockClear();
  state.projects = [];
  state.threads = [];
  state.agentAccess = true;
  state.memoryEnabled = true;
  state.memoryModel = null;
  state.allowed = true;
  state.write = true;
  state.exposure = 0;
  state.projects = [];
  state.requests = [];
  state.queries.clear();
  state.executors.clear();
  state.refresh.mockClear();
  state.calls.mockClear();
  state.environment = null;
  state.environments = [
    "remote-owner",
    "active-device",
    "pending-device",
    "device-a",
    "latest-device",
    "old-device",
  ].map((environmentId) => ({
    environmentId,
    label: environmentId.replace("-device", " device"),
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { memory: { protocolVersion: 1, resolutionInputs: true } } },
    },
  }));
  state.result = { _tag: "Failure" };
  state.responses.clear();
  state.connection = { httpBaseUrl: "https://hub.example" };
  state.deviceConnections.clear();
});

const decodeRevision = Schema.decodeUnknownSync(MemoryRevision);
const decodeRevert = Schema.decodeUnknownSync(MemoryRevertResult);
const revision = (n: number) =>
  decodeRevision({
    memorySpaceId: id(1),
    memoryId: id(2),
    revisionId: id(n),
    operationId: id(10 + n),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n),
    assertionKind: "fact",
    provenance: { environmentId: "remote-owner" },
    createdAtUtc: "2026-09-01T00:00:00.000Z",
  });
const payload = {
  text: "Synthetic original",
  evidence: [{ origin: "user" as const, messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
const activeItem = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: item.memorySpaceId,
  memoryId: item.memoryId,
  scope: { kind: "user" },
  pendingSync: false,
  status: "active",
  revision: revision(5),
  payload,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
});
const resolution = Schema.decodeUnknownSync(MemoryResolution)({
  resolutionId: id(6),
  memorySpaceId: id(1),
  memoryId: id(2),
  inputRevisionIds: [id(3), id(4)],
  inputPayloadRefs: [id(3), id(4)],
  judgmentRef: id(6),
  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
  effectiveProvider: "codex",
  effectiveModel: "synthetic",
  resolvingEnvironmentId: "remote-owner",
  fencingToken: 1,
  resultRevisionId: id(5),
  appliedAtUtc: "2026-09-01T00:00:00.000Z",
  revertDeadlineUtc: "2026-10-01T00:00:00.000Z",
});
const entry = {
  resolution,
  payload: MemoryResolutionPayload.make({
    resolutionId: resolution.resolutionId,
    judgment: "Synthetic judgment",
  }),
};
const retained = {
  revisions: [
    { revision: revision(3), payload },
    { revision: revision(4), payload: null },
  ],
  revertResults: [],
  nextCursor: null,
} satisfies Pick<MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor">;
const settled = vi.fn();
async function renderRevert(
  history:
    | typeof retained
    | Pick<MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor"> = retained,
  originals = history,
) {
  state.queries.set("history", Option.some(history));
  state.queries.set("resolutionInputs", Option.some(originals));
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.allowed as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryRevertControl
          environmentId={EnvironmentId.make("remote-owner")}
          item={activeItem}
          entry={entry}
          history={history}
          onSettled={settled}
        />
      </RegistryContext>,
    );
  });
}
async function chooseOriginal() {
  const original = container.querySelector<HTMLInputElement>('input[type="radio"]')!;
  await act(async () => original.click());
}
it("restores only the chosen retained original despite the local deadline, retries the same intent, and settles from the hub", async () => {
  settled.mockClear();
  await renderRevert();
  expect(container.textContent).toContain("The hub needs to confirm the revert window");
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(1);
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  await chooseOriginal();
  await click("Revert resolution");
  const first = state.calls.mock.calls[0]![0] as {
    environmentId: string;
    input: { operationId: string; restoredRevisionId: string; expectedHeads: string[] };
  };
  expect(first).toMatchObject({
    environmentId: "remote-owner",
    input: {
      memorySpaceId: id(1),
      memoryId: id(2),
      resolutionId: id(6),
      restoredRevisionId: id(3),
      expectedHeads: [id(5)],
    },
  });
  expect(container.textContent).toContain("Revert request failed");
  state.result = {
    _tag: "Success",
    value: {
      operationId: first.input.operationId,
      memoryId: id(2),
      resolutionId: id(6),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "revert_expired",
    },
  };
  await click("Revert resolution");
  expect(state.calls.mock.calls[1]![0]).toEqual(first);
  expect(container.textContent).toContain("Revert window expired");
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  expect(settled).toHaveBeenCalledTimes(1);
});
it.each(["pending", "accepted", "revision_changed", "forgotten"] as const)(
  "presents authoritative %s settlement",
  async (status) => {
    await renderRevert();
    await chooseOriginal();
    state.result = {
      _tag: "Success",
      value: decodeRevert({
        operationId: id(9),
        memoryId: id(2),
        resolutionId: id(6),
        revertDeadlineUtc: resolution.revertDeadlineUtc,
        status,
        ...(status === "accepted"
          ? {
              localAvailability: activeItem.localAvailability,
              receipt: {
                operationId: id(9),
                memoryId: id(2),
                outcome: "accepted",
                revisionId: id(8),
                pendingSync: false,
              },
            }
          : {}),
      }),
    };
    await click("Revert resolution");
    const labels = {
      pending: "Waiting for revert approval",
      accepted: "Revert approved",
      revision_changed: "Memory changed; cannot revert",
      forgotten: "Forgotten memory cannot be reverted",
    };
    expect(container.querySelector('[role="status"]')?.textContent).toBe(labels[status]);
    expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  },
);
it("cancels without sending, revalidates missing originals, and closes on revoke, with paged history allowed", async () => {
  await renderRevert();
  await chooseOriginal();
  await click("Cancel");
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  await chooseOriginal();
  await renderRevert({ ...retained, revisions: [] });
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  await renderRevert({ ...retained, nextCursor: "more" });
  expect(container.querySelector('[aria-label="Revert confirmation"]')).not.toBeNull();
  await renderRevert();
  await chooseOriginal();
  state.allowed = false;
  await renderRevert();
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  expect(state.calls).not.toHaveBeenCalled();
});
it("rejects a disconnected destination at admission and discards a late result after rebinding", async () => {
  await renderRevert();
  await chooseOriginal();
  const connection = state.connection;
  state.connection = null;
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  state.connection = connection;
  let complete!: (result: unknown) => void;
  state.executors.set("revertResolution", (input) => {
    state.calls(input);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  await renderRevert();
  settled.mockClear();
  await click("Revert resolution");
  state.connection = { httpBaseUrl: "https://hub.example" };
  await act(async () =>
    complete({
      _tag: "Success",
      value: decodeRevert({
        operationId: id(9),
        memoryId: id(2),
        resolutionId: id(6),
        revertDeadlineUtc: resolution.revertDeadlineUtc,
        status: "pending",
      }),
    }),
  );
  expect(settled).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
  state.executors.delete("revertResolution");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function renderForget() {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.write as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryForgetControl environmentId={EnvironmentId.make("remote-owner")} item={item} />
      </RegistryContext>,
    );
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("requires confirmation, retains operation identity after failure, and displays settlement separately", async () => {
  await renderForget();
  await click("Forget memory");
  expect(state.calls).not.toHaveBeenCalled();
  await click("Confirm forget");
  expect(container.textContent).toContain("Forget request failed");
  const first = state.calls.mock.calls[0]![0] as {
    environmentId: string;
    input: { operationId: string };
  };
  state.result = {
    _tag: "Success",
    value: {
      operationId: first.input.operationId,
      outcome: "deleted",
      pendingSync: true,
      forgetExpansion: { status: "pending" },
    },
  };
  await click("Confirm forget");
  expect(state.calls.mock.calls[1]![0]).toEqual(first);
  expect(first.environmentId).toBe("remote-owner");
  expect(container.textContent).toContain("Forgotten. Other devices remove it when they sync.");
  expect(container.textContent).not.toContain("Expansion:");
  expect(container.textContent).not.toContain("Sharing pending:");
  expect(container.textContent).not.toContain("The provider's original");
  expect(container.textContent).not.toContain("Forget confirmation");
});
it("cancels without mutation and removes an open intent when permission is revoked", async () => {
  await renderForget();
  await click("Forget memory");
  await click("Cancel");
  expect(state.calls).not.toHaveBeenCalled();
  await click("Forget memory");
  state.write = false;
  await renderForget();
  expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
  state.write = true;
  await renderForget();
  expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
});
it("does not mount memory consumers for an unsupported explicit foreign deep link", async () => {
  await act(async () => {
    notifyFixture();
    root.render(
      <MemorySettings
        target={validateMemorySettingsSearch({
          environmentId: "foreign-owner",
          memorySpaceId: id(1),
          memoryId: id(2),
        })}
      />,
    );
  });
  expect(container.textContent).toContain("Update or reconnect");
  expect(container.textContent).not.toContain("foreign-owner");
  expect(state.calls).not.toHaveBeenCalled();
});

it("keeps pending reenrollment when removing another owner permission and renders the committed policy", async () => {
  const pair = {
    memorySpaceId: id(1),
    ownerEnvironmentId: "remote-owner",
    requesterEnvironmentId: "pending-device",
  };
  const view = {
    version: 3,
    revocationPropagation: "pending",
    policy: {
      ownerPolicyEpoch: 3,
      allowedRequesterEnvironmentIds: ["active-device"],
      enrollments: [
        { ...pair, ownerPolicyEpoch: 3, removalEpoch: 2, state: "pending" },
        { ...pair, requesterEnvironmentId: "active-device", ownerPolicyEpoch: 3, state: "active" },
      ],
      removals: [{ ...pair, removalEpoch: 2, state: "pending" }],
    },
  };
  state.responses.set("hubSettingsGet", {
    _tag: "Success",
    value: { version: 2, members: [], settings: { mode: "hub", memorySpaceId: id(1) } },
  });
  state.responses.set("ownerSourceReadPolicyGet", { _tag: "Success", value: view });
  state.responses.set("ownerSourceReadPolicyUpdate", {
    _tag: "Success",
    value: {
      ...view,
      version: 4,
      policy: {
        ...view.policy,
        allowedRequesterEnvironmentIds: [],
        enrollments: [view.policy.enrollments[0]],
      },
    },
  });
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.allowed as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryAdministration environmentId={EnvironmentId.make("remote-owner")} />
      </RegistryContext>,
    );
  });
  expect(container.textContent).toContain("pending device");
  expect(container.textContent).toContain("active device");
  const remove = [...container.querySelectorAll("[data-test-row]")]
    .find((entry) => entry.textContent?.startsWith("active device"))!
    .querySelector("button")!;
  await act(async () => remove.click());
  const request = state.calls.mock.calls.at(-1)![0] as {
    environmentId: string;
    input: { allowedRequesterEnvironmentIds: string[]; expectedVersion: number };
  };
  expect(request.input.allowedRequesterEnvironmentIds).toEqual(["pending-device"]);
  expect(request.input.expectedVersion).toBe(3);
  expect(request.environmentId).toBe("remote-owner");
  expect(
    [...container.querySelectorAll("[data-test-row]")].some((row) =>
      row.textContent?.startsWith("active device"),
    ),
  ).toBe(false);
  expect(container.textContent).toContain("pending device");
  const calls = state.calls.mock.calls.length;
  await click("Turn sharing off");
  await click("Cancel");
  expect(state.calls.mock.calls.length).toBe(calls);
  state.responses.set("hubSettingsUpdate", {
    _tag: "Success",
    value: { view: { version: 3, settings: { mode: "disabled" } }, credential: null },
  });
  await click("Turn sharing off");
  await click("Stop sharing");
  expect(container.textContent).toContain("Sharing off");
  expect(container.textContent).toContain("Make this device the hub");
});

// A manually settled Deferred keeps response ordering deterministic without timers.
async function deferredResult() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const success = (value: unknown) => ({
  _tag: "Success",
  value:
    typeof value === "object" && value !== null && "state" in value && "memorySpaceId" in value
      ? { ...memorySyncFixture, ...value }
      : value,
});
const hubView = (version: number, space = id(1)) => ({
  version,
  members: [] as {
    environmentId: string;
    credentialVersion: number;
    status: string;
    joinedAt: number | null;
  }[],
  settings: { mode: "hub", memorySpaceId: space },
});
const ownerView = (version: number, requester: string) => ({
  version,
  revocationPropagation: "complete",
  policy: {
    ownerPolicyEpoch: version,
    allowedRequesterEnvironmentIds: [requester],
    enrollments: [],
    removals: [],
  },
});
async function supportedScreen(withDetails = true, followNavigation = false) {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    if (label)
      return (
        ["forget", "upsert", "projectBindingGet"].includes(label) ? state.write : state.allowed
      ) as never;
    return get(atom);
  });
  state.environment = {
    serverConfig: {
      environment: { capabilities: { memory: { protocolVersion: 1, resolutionInputs: true } } },
    },
  };
  state.queries.set("read", Option.some(activeItem));
  if (!state.responses.has("syncStatus"))
    state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(1) }));
  state.responses.set("hubSettingsGet", success(hubView(2)));
  state.responses.set("ownerSourceReadPolicyGet", success(ownerView(2, "device-a")));
  let target = validateMemorySettingsSearch({
    environmentId: "remote-owner",
    ...(withDetails ? { memorySpaceId: id(1), memoryId: id(2) } : {}),
  });
  let routeSearch = withDetails ? target : validateMemorySettingsSearch({});
  const renderContent = () =>
    root.render(
      <RegistryContext value={registry}>
        <div
          key={settingsContentScopeKey(
            "/settings/memory",
            routeSearch,
            EnvironmentId.make("remote-owner"),
          )}
        >
          <MemorySettings target={target} />
        </div>
      </RegistryContext>,
    );
  if (followNavigation)
    state.navigate.mockImplementation(({ search }) => {
      routeSearch = validateMemorySettingsSearch(search);
      target = routeSearch;
      renderContent();
      return Promise.resolve();
    });
  const render = () =>
    act(async () => {
      notifyFixture();
      renderContent();
    });
  await render();
  return { render, registry };
}

it.each([false, true])(
  "clears an in-flight forget on write-only revoke and ignores its late result (after regrant: %s)",
  async (afterRegrant) => {
    const first = await deferredResult();
    state.executors.set("forget", (input) => {
      state.calls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget");
    await click("Confirm forget");
    const oldRequest = state.calls.mock.calls.at(-1)![0];
    state.write = false;
    await render();
    expect(container.textContent).toContain("Synthetic original");
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    if (afterRegrant) {
      state.write = true;
      await render();
    }
    await act(async () => {
      await first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    state.write = true;
    await render();
    expect(container.textContent).not.toContain("Forget request failed");
    await click("Forget");
    expect(
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Confirm forget")
        ?.disabled,
    ).toBe(false);
    await click("Cancel");
    await click("Forget");
    state.executors.set("forget", async (input) => {
      state.calls(input);
      return { _tag: "Failure" };
    });
    await render();
    await click("Confirm forget");
    expect(state.calls.mock.calls.at(-1)![0]).not.toEqual(oldRequest);
    expect(container.textContent).toContain("Forget request failed");
  },
);

it("discards the editor and its draft on write-only revoke and requires Edit after regrant", async () => {
  const { render, registry } = await supportedScreen();
  const writes = vi.spyOn(registry, "set");
  state.navigate.mockClear();
  await click("Edit");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Memory text"]')?.value).toBe(
    "Synthetic original",
  );
  state.write = false;
  await render();
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
  expect(writes.mock.calls.at(-1)?.[1]).toBeNull();
  state.write = true;
  await render();
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
  await click("Edit");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Memory text"]')?.value).toBe(
    "Synthetic original",
  );
});

it("retries a failed load inline without a reload control", async () => {
  let loads = 0;
  state.executors.set("hubSettingsGet", async () =>
    ++loads === 1 ? { _tag: "Failure" } : success(hubView(3)),
  );
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Could not load sharing settings.");
  await click("Retry");
  expect(loads).toBe(2);
  expect(container.textContent).toContain("This device is the hub");
  expect(container.textContent).not.toContain("Could not load sharing settings.");
  expect(container.textContent).not.toContain("Reload sharing settings");
  expect(container.textContent).not.toContain("Operational details");
  expect(container.textContent).not.toContain("Device removal applied");
});

it("reads memory status again when memory is turned off or its model changes", async () => {
  let reads = 0;
  state.executors.set("syncStatus", async () => {
    reads += 1;
    return success({ state: "online", memorySpaceId: id(1) });
  });
  await supportedScreen(false);
  const first = reads;
  expect(first).toBeGreaterThan(0);
  // A pause belongs to the old model, so either change must replace the shown status.
  await act(async () => {
    state.memoryEnabled = false;
    notifyFixture();
  });
  expect(reads).toBe(first + 1);
  await act(async () => {
    state.memoryModel = { instanceId: "codex", model: "other" };
    notifyFixture();
  });
  expect(reads).toBe(first + 2);
  // Unrelated settings changes do not read it again.
  await act(async () => {
    state.agentAccess = false;
    notifyFixture();
  });
  expect(reads).toBe(first + 2);
});

it("automatically opens the ready space and keeps saved memories read-only after disabling", async () => {
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(1) }));
  state.queries.set("list", Option.some({ items: [activeItem], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Synthetic original");
  expect(container.querySelector('[aria-label="Memory space ID"]')).toBeNull();
  expect(container.textContent).not.toContain("remote-owner ·");
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  state.responses.set(
    "hubSettingsUpdate",
    success({ view: { version: 3, settings: { mode: "disabled" } }, credential: null }),
  );
  await click("Turn sharing off");
  expect(container.textContent).toContain("Saved memories stay.");
  await click("Stop sharing");
  expect(container.textContent).toContain("Turn on memory to save new memories.");
  expect(container.textContent).toContain("Synthetic original");
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(8) }));
  state.responses.set("hubSettingsUpdate", success({ view: hubView(4, id(8)), credential: null }));
  await click("Make this device the hub");
  expect(
    state.calls.mock.calls.findLast(
      ([input]) => (input as { input?: { action?: string } }).input?.action === "configure",
    )?.[0],
  ).toMatchObject({ input: { settings: { mode: "hub", memorySpaceId: null } } });
  expect(container.textContent).toContain("Synthetic original");
});

it("unmounts retained bodies and an open source when read is None, without reopening source on recovery", async () => {
  const { render } = await supportedScreen();
  state.queries.set(
    "history",
    Option.some({
      ...retained,
      revisions: [
        {
          revision: revision(3),
          payload: {
            ...payload,
            text: "Retained body",
            evidence: [
              {
                origin: "user",
                sourceThread: { environmentId: "source-owner", threadId: "synthetic-thread" },
                messageIds: ["synthetic-message"],
              },
            ],
          },
        },
      ],
      resolutions: [entry],
      reports: [],
    }),
  );
  state.queries.set(
    "readSource",
    Option.some({
      messages: [{ messageId: "synthetic-message", text: "Source body" }],
      nextCursor: null,
    }),
  );
  await render();
  await click("Open Original 1");
  await click("Open Resolution");
  await click("Read original");
  expect(container.textContent).toContain("Retained body");
  expect(container.textContent).toContain("Synthetic judgment");
  expect(container.textContent).toContain("Source body");
  state.queries.set("read", Option.none());
  await render();
  expect(container.textContent).toContain("Visible details have been cleared");
  expect(container.textContent).not.toContain("Retained body");
  expect(container.textContent).not.toContain("Synthetic judgment");
  expect(container.textContent).not.toContain("Source body");
  expect(container.textContent).not.toContain("Read original");
  expect(container.textContent).not.toContain("Close original");
  state.queries.set("read", Option.some(activeItem));
  await render();
  expect(container.textContent).not.toContain("Source body");
  expect(container.textContent).not.toContain("Close original");
  expect(container.textContent).not.toContain("Retained body");
  expect(container.textContent).toContain("Open Original 1");
});

it.each([false, true])(
  "retries the same forget after body-free invalidation (signal first: %s)",
  async (signalFirst) => {
    const first = await deferredResult();
    state.executors.set("forget", (input) => {
      state.calls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget");
    await click("Confirm forget");
    const original = state.calls.mock.calls.at(-1)![0];
    async function invalidate() {
      state.queries.set("read", Option.none());
      state.queries.set("history", Option.none());
      await render();
      expect(container.textContent).not.toContain("Synthetic original");
      expect(container.textContent).not.toContain("Synthetic judgment");
      expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
    }
    if (signalFirst) await invalidate();
    await act(async () => {
      first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    if (!signalFirst) await invalidate();
    expect(container.textContent).toContain("Try again to continue this request");
    state.executors.set("forget", async (input) => {
      state.calls(input);
      return { _tag: "Failure" };
    });
    await render();
    const callsBeforeRetry = state.calls.mock.calls.length;
    await click("Confirm forget");
    expect(state.calls.mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(state.calls.mock.calls.at(-1)![0]).toEqual(original);
    expect(original).toMatchObject({
      environmentId: "remote-owner",
      input: { memorySpaceId: id(1), memoryId: id(2), expectedHeads: [id(5)] },
    });
    expect(container.textContent).not.toContain("Synthetic original");
  },
);

it.each(["write", "read", "reconnect", "close"])(
  "discards a body-free forget retry after %s changes",
  async (boundary) => {
    const first = await deferredResult();
    const forgetCalls = vi.fn();
    state.executors.set("forget", (input) => {
      state.calls(input);
      forgetCalls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget");
    await click("Confirm forget");
    state.queries.set("read", Option.none());
    state.queries.set("history", Option.none());
    await render();
    const calls = forgetCalls.mock.calls.length;
    if (boundary === "write") state.write = false;
    if (boundary === "read") state.allowed = false;
    if (boundary === "reconnect") state.connection = {};
    if (boundary === "close") await act(async () => root.render(null));
    else await render();
    await act(async () => {
      first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    state.write = true;
    state.allowed = true;
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    expect(forgetCalls.mock.calls.length).toBe(calls);
  },
);

it.each(["write", "read", "reconnect"])(
  "checks the current %s before sending a retry from the rendered confirmation",
  async (boundary) => {
    const forgetCalls = vi.fn();
    state.executors.set("forget", async (input) => {
      forgetCalls(input);
      return { _tag: "Failure" };
    });
    const { render } = await supportedScreen();
    await click("Forget");
    await click("Confirm forget");
    const original = forgetCalls.mock.calls[0]![0];
    expect(container.textContent).toContain("Try again to continue this request");
    state.queries.set("read", Option.none());
    state.queries.set("history", Option.none());
    await render();
    expect(container.textContent).not.toContain("Synthetic original");
    const calls = forgetCalls.mock.calls.length;
    const connection = state.connection;
    // Change the authoritative guard before React has observed the new lifecycle.
    if (boundary === "write") state.write = false;
    if (boundary === "read") state.allowed = false;
    if (boundary === "reconnect") state.connection = {};
    if (boundary === "read") {
      expect(state.write).toBe(true);
      expect(state.connection).toBe(connection);
    }
    await click("Confirm forget");
    expect(forgetCalls.mock.calls.length).toBe(calls);
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    state.write = true;
    state.allowed = true;
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    expect(forgetCalls.mock.calls.length).toBe(calls);
    // A returning body permits a new explicit intent, never revives the old one.
    state.queries.set("read", Option.some(activeItem));
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    await click("Forget");
    await click("Confirm forget");
    expect(forgetCalls.mock.calls.length).toBe(calls + 1);
    expect(forgetCalls.mock.calls.at(-1)![0]).not.toEqual(original);
  },
);

it("adds a named device, retries install without exposing its key, and confirms removal", async () => {
  const { render } = await supportedScreen(false);
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "active-device";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Add");
  expect(container.textContent).toContain("Add active device?");
  const credential = "ephemeral-key-that-must-not-be-rendered";
  const mutations: { environmentId: string; input: Record<string, unknown> }[] = [];
  let failInstall = true;
  const log = vi.spyOn(console, "log");
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  state.executors.set("hubSettingsUpdate", async (raw) => {
    const request = raw as { environmentId: string; input: Record<string, unknown> };
    mutations.push(request);
    if (request.input.action === "installCredential" && failInstall) {
      failInstall = false;
      return { _tag: "Failure" };
    }
    return success({
      view: {
        ...hubView(request.input.action === "provisionMember" ? 3 : 4),
        members:
          request.input.action === "revokeMember"
            ? []
            : [
                {
                  environmentId: "active-device",
                  credentialVersion: 1,
                  status: "active",
                  joinedAt: 0,
                },
              ],
      },
      credential:
        request.input.action === "provisionMember"
          ? { requestId: request.input.requestId, memorySpaceId: id(1), credential }
          : null,
    });
  });
  await render();
  await click("Confirm");
  expect(mutations.map((r) => r.input.action)).toEqual(["provisionMember", "installCredential"]);
  expect(container.innerHTML).not.toContain(credential);
  expect(container.textContent).toContain("Retry to continue");
  await click("Retry");
  expect(mutations.map((r) => r.input.action)).toEqual([
    "provisionMember",
    "installCredential",
    "installCredential",
    "acknowledgeCredential",
  ]);
  expect(mutations[1]).toEqual(mutations[2]);
  expect(container.innerHTML).not.toContain(credential);
  expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
    credential,
  );
  const row = [...container.querySelectorAll("[data-test-row]")].find((e) =>
    e.textContent?.startsWith("active device"),
  )!;
  const remove = [...row.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
  await act(async () => remove.click());
  expect(mutations).toHaveLength(4);
  expect(container.textContent).toContain("Remove active device?");
  await click("Remove device");
  expect(mutations.at(-1)?.input.action).toBe("revokeMember");
});

it("opens memories when bootstrap publishes a reset without a reload or timer", async () => {
  state.responses.set("syncStatus", success({ state: "bootstrapping", memorySpaceId: id(1) }));
  state.queries.set("list", Option.some({ items: [activeItem], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Memory is getting ready.");
  expect(container.textContent).not.toContain("Synthetic original");
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(1) }));
  await act(async () => {
    state.exposure += 1;
    notifyFixture();
  });
  expect(container.textContent).toContain("Synthetic original");
  expect(container.textContent).not.toContain("Memory is getting ready.");
});

it("reloads persisted members, excludes them from Add, and removes an offline unknown device", async () => {
  const { render } = await supportedScreen(false);
  const members = [
    { environmentId: "active-device", credentialVersion: 2, status: "active", joinedAt: 0 },
    {
      environmentId: "unregistered-private-id",
      credentialVersion: 1,
      status: "pending_ack",
      joinedAt: 0,
    },
  ];
  state.responses.set("hubSettingsGet", success({ ...hubView(4), members }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await render();
  expect(container.textContent).not.toContain("Device list unavailable");
  expect(
    [...container.querySelectorAll("[data-test-row]")].some((row) =>
      row.textContent?.startsWith("active device"),
    ),
  ).toBe(true);
  expect(container.textContent).not.toContain("unregistered-private-id");
  expect(container.textContent).toContain("Waiting for the device to confirm");
  const picker =
    container.querySelector<HTMLSelectElement>('select[aria-label="Device"]') ??
    container.querySelector<HTMLSelectElement>("select")!;
  expect([...picker.options].map((o) => o.value)).not.toContain("active-device");
  const row = [...container.querySelectorAll("[data-test-row]")].find((e) =>
    e.textContent?.startsWith("Unknown device"),
  )!;
  expect(row.textContent).toContain(
    "Connect this device in Settings → Connections to replace its key.",
  );
  const buttons = [...row.querySelectorAll("button")];
  expect(buttons.find((b) => b.textContent === "Replace key")!.disabled).toBe(true);
  expect(buttons.find((b) => b.textContent === "Remove")!.disabled).toBe(false);
  await act(async () => buttons.find((b) => b.textContent === "Remove")!.click());
  state.responses.set(
    "hubSettingsUpdate",
    success({
      view: { ...hubView(5), members: [members[0]] },
      credential: null,
    }),
  );
  state.responses.set("hubSettingsGet", success({ ...hubView(5), members: [members[0]] }));
  await click("Remove device");
  expect(
    state.calls.mock.calls
      .map(([call]) => call)
      .findLast((call) => call.input.action === "revokeMember"),
  ).toMatchObject({
    environmentId: "remote-owner",
    input: { action: "revokeMember", environmentId: "unregistered-private-id", expectedVersion: 4 },
  });
  expect(container.textContent).not.toContain("Waiting for the device to confirm");
});

it("keeps original labels tied to revision IDs across omitted payloads and reversed resolution inputs", async () => {
  const history = {
    ...retained,
    revisions: [
      { revision: revision(9), payload: null },
      { revision: revision(4), payload: { ...payload, text: "Second original body" } },
      { revision: revision(3), payload: { ...payload, text: "Third original body" } },
    ],
  };
  await renderRevert(history);
  const choices = [...container.querySelectorAll("label")];
  const second = choices.find((label) => label.textContent?.includes("Second original body"))!;
  expect(second.textContent).toContain("Original 2");
  const third = choices.find((label) => label.textContent?.includes("Third original body"))!;
  expect(third.textContent).toContain("Original 3");
  await act(async () => second.querySelector<HTMLInputElement>("input")!.click());
  await click("Revert resolution");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({ input: { restoredRevisionId: id(4) } });
});

it("invalidates a focus read when sharing changes, so its late reply cannot reopen sharing", async () => {
  const { render } = await supportedScreen(false);
  const late = await deferredResult();
  state.executors.set("hubSettingsGet", () => late.promise);
  await render();
  await act(async () => window.dispatchEvent(new Event("focus")));
  state.responses.set(
    "hubSettingsUpdate",
    success({
      view: { version: 3, members: [], settings: { mode: "disabled" } },
      credential: null,
    }),
  );
  await click("Turn sharing off");
  await click("Stop sharing");
  await act(async () => late.resolve(success(hubView(2))));
  expect(container.textContent).toContain("Make this device the hub");
  expect(container.textContent).not.toContain("This device is the hub");
  expect(container.textContent).not.toContain("Conversation access");
});

it("ends a confirmed sharing conflict, refreshes and requires a new confirmation with fresh version", async () => {
  const { render } = await supportedScreen(false);
  const Cause = await import("effect/Cause");
  state.responses.set("hubSettingsUpdate", {
    _tag: "Failure",
    cause: Cause.fail({ code: "revision_changed" }),
  });
  await click("Turn sharing off");
  await click("Stop sharing");
  const old = state.calls.mock.calls.at(-1)![0];
  expect(container.textContent).toContain("Review latest settings");
  state.responses.set("hubSettingsGet", success(hubView(7)));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await render();
  expect(container.textContent).toContain("Review latest settings");
  await click("Review latest settings");
  await render();
  await click("Turn sharing off");
  await click("Stop sharing");
  const fresh = state.calls.mock.calls.at(-1)![0];
  expect(fresh).toMatchObject({ input: { expectedVersion: 7 } });
  expect(fresh.input.requestId).not.toBe(old.input.requestId);
});

async function selectAddDevice() {
  const picker = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    picker.value = "active-device";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Add");
}

it.each(["http://localhost:3773", "https://127.0.0.2", "http://[::1]:3773", "https://localhost."])(
  "blocks loopback %s before provisioning another device",
  async (address) => {
    state.connection = { httpBaseUrl: address };
    await supportedScreen(false);
    await selectAddDevice();
    expect(container.textContent).toContain("Localhost points to the device itself");
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(state.calls.mock.calls.some(([call]) => call.input.action === "provisionMember")).toBe(
      false,
    );
  },
);

it.each(["reading", "installing"])(
  "recovers on member-only reconnection while %s without reusing a stale credential",
  async (stage) => {
    const { render } = await supportedScreen(false);
    state.deviceConnections.set("active-device", { httpBaseUrl: "https://member.example" });
    const deferred = await deferredResult();
    const mutations: { environmentId: string; input: { action: string } }[] = [];
    state.executors.set("hubSettingsGet", async (raw) => {
      const call = raw as { environmentId: string };
      return stage === "reading" && call.environmentId === "active-device"
        ? deferred.promise
        : success(hubView(3));
    });
    state.executors.set("hubSettingsUpdate", async (raw) => {
      const call = raw as (typeof mutations)[number];
      mutations.push(call);
      if (call.input.action === "installCredential") return deferred.promise;
      return success({
        view: hubView(4),
        credential: { memorySpaceId: id(1), credential: "synthetic-ephemeral-key" },
      });
    });
    await render();
    await selectAddDevice();
    await click("Confirm");
    state.deviceConnections.set("active-device", { httpBaseUrl: "https://member-new.example" });
    await render();
    expect(container.textContent).toContain("Device connection changed");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await render();
    expect(container.textContent).toContain("Review latest settings");
    await act(async () => deferred.resolve(success({ view: hubView(5), credential: null })));
    expect(mutations.some((call) => call.input.action === "acknowledgeCredential")).toBe(false);
    await click("Review latest settings");
    expect(container.textContent).not.toContain("Device connection changed");
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add",
    )!;
    expect(add.disabled).toBe(false);
    expect(container.innerHTML).not.toContain("synthetic-ephemeral-key");
  },
);

it("offers explicit recovery after a device setup version conflict", async () => {
  const { render } = await supportedScreen(false);
  const Cause = await import("effect/Cause");
  state.deviceConnections.set("active-device", { httpBaseUrl: "https://member.example" });
  const provisioned = {
    ...hubView(4),
    members: [
      { environmentId: "active-device", credentialVersion: 1, status: "pending_ack", joinedAt: 0 },
    ],
  };
  state.executors.set("hubSettingsUpdate", async (raw) => {
    const call = raw as { input: { action: string } };
    if (call.input.action === "installCredential")
      return { _tag: "Failure", cause: Cause.fail({ code: "revision_changed" }) };
    return success({
      view: provisioned,
      credential: { memorySpaceId: id(1), credential: "ephemeral" },
    });
  });
  await render();
  await selectAddDevice();
  await click("Confirm");
  expect(container.textContent).toContain("Setup may be incomplete");
  state.responses.set("hubSettingsGet", success(provisioned));
  await click("Review latest settings");
  const row = [...container.querySelectorAll("[data-test-row]")].find((row) =>
    row.textContent?.startsWith("active device"),
  )!;
  expect(row.textContent).toContain("Replace key");
  expect(row.textContent).toContain("Remove");
});

it("refreshes a confirmed owner policy conflict and asks for a new access change", async () => {
  await supportedScreen(false);
  const Cause = await import("effect/Cause");
  state.responses.set("ownerSourceReadPolicyUpdate", {
    _tag: "Failure",
    cause: Cause.fail({ code: "revision_changed" }),
  });
  const removeAccess = async () => {
    const row = [...container.querySelectorAll("[data-test-row]")].find((row) =>
      row.textContent?.startsWith("device-a"),
    )!;
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
  };
  await removeAccess();
  const first = state.calls.mock.calls.at(-1)![0];
  expect(container.textContent).toContain("Conversation access changed");
  state.responses.set("ownerSourceReadPolicyGet", success(ownerView(8, "device-a")));
  await click("Review latest settings");
  await removeAccess();
  const next = state.calls.mock.calls.at(-1)![0];
  expect(next.input.expectedVersion).toBe(8);
  expect(next.input.requestId).not.toBe(first.input.requestId);
});

it.each([false, true])(
  "focuses details and closes a successful forget with only the appropriate origin notice (imported: %s)",
  async (imported) => {
    const { render } = await supportedScreen();
    if (activeItem.status !== "active") throw new Error("Active fixture required");
    state.queries.set(
      "read",
      Option.some({
        ...activeItem,
        payload: {
          ...activeItem.payload,
          evidence: imported
            ? [{ origin: "import", importSourceId: id(8), messageIds: [] }]
            : activeItem.payload.evidence,
        },
      }),
    );
    await render();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Memory details");
    state.responses.set("forget", success({ outcome: "deleted", pendingSync: true }));
    state.navigate.mockClear();
    await click("Forget");
    await click("Confirm forget");
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.not.objectContaining({ memoryId: id(2) }) }),
    );
    expect(container.textContent).toContain("Forgotten. Other devices remove it when they sync.");
    expect(container.textContent?.includes("The provider's original conversation stays")).toBe(
      imported,
    );
    expect(container.textContent).not.toContain("Expansion:");
    expect(container.textContent).not.toContain("Sharing pending:");
    expect(state.refresh).toHaveBeenCalled();
  },
);

it("keeps saved memories readable while memory is off and blocks saving and editing", async () => {
  const { render } = await supportedScreen();
  await click("Edit");
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await render();
  expect(container.textContent).toContain(
    "Saved memories stay. Turn on memory to save new memories.",
  );
  expect(container.textContent).toContain("Synthetic original");
  expect(
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Remember something")!
      .disabled,
  ).toBe(true);
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(
    false,
  );
  expect(container.querySelector("textarea")).toBeNull();
});

it("labels ordinary history as versions and closes details with the accessible icon", async () => {
  const { render } = await supportedScreen();
  state.queries.set(
    "history",
    Option.some({
      ...retained,
      resolutions: [],
      reports: [],
      revisions: [{ revision: revision(3), payload }],
    }),
  );
  await render();
  expect(container.textContent).toContain("Open Version 1");
  expect(container.textContent).not.toContain("Open Original");
  expect(container.textContent).not.toContain("Refresh details");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Close details"]')!.click(),
  );
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ search: expect.not.objectContaining({ memoryId: id(2) }) }),
  );
});

it("explains the device limit and starts a fresh add after removing a device", async () => {
  const { render } = await supportedScreen(false);
  const Cause = await import("effect/Cause");
  const { MemoryRpcError } = await import("@goat/contracts");
  const Schema = await import("effect/Schema");
  const capacity = Schema.decodeSync(MemoryRpcError)({
    _tag: "MemoryRpcError",
    code: "capacity_exceeded",
    capacity: {
      code: "capacity_exceeded",
      dimension: "members",
      current: 128,
      limit: 128,
      reclaimable: 0,
    },
  });
  state.responses.set("hubSettingsUpdate", { _tag: "Failure", cause: Cause.fail(capacity) });
  await selectAddDevice();
  await click("Confirm");
  const first = state.calls.mock.calls
    .map(([c]) => c)
    .findLast((c) => c.input.action === "provisionMember");
  expect(container.textContent).toContain("Device limit reached. Remove a device to add another.");
  const member = {
    environmentId: "old-device",
    credentialVersion: 1,
    status: "active",
    joinedAt: 0,
  };
  state.responses.set("hubSettingsGet", success({ ...hubView(5), members: [member] }));
  await click("Review latest settings");
  await render();
  await click("Remove");
  state.responses.set("hubSettingsUpdate", success({ view: hubView(6), credential: null }));
  await click("Remove device");
  state.executors.set("hubSettingsUpdate", async (raw) => {
    state.calls(raw);
    return { _tag: "Failure", cause: Cause.fail(capacity) };
  });
  await selectAddDevice();
  await click("Confirm");
  const fresh = state.calls.mock.calls
    .map(([c]) => c)
    .findLast((c) => c.input.action === "provisionMember");
  expect(fresh.input.expectedVersion).toBe(6);
  expect(fresh.input.requestId).not.toBe(first.input.requestId);
});

it("describes both seeing and saving memories on a fresh visit while sharing is off", async () => {
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Turn on memory to see and save memories.");
  expect(container.textContent).not.toContain("Turn on memory to start saving memories.");
});

it("removes an open editor and history when shared admission removes the derived memory", async () => {
  const { render, registry } = await supportedScreen();
  const writes = vi.spyOn(registry, "set");
  state.navigate.mockClear();
  await click("Edit");
  expect(container.querySelector('[aria-label="Memory text"]')).not.toBeNull();
  state.queries.set("read", Option.none());
  state.queries.set("history", Option.none());
  await render();
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
  expect(container.textContent).not.toContain("Synthetic original");
  expect(writes.mock.calls.at(-1)?.[1]).toBeNull();
  expect(container.textContent).toContain(
    "Closed because this memory is no longer available. A related memory may have been forgotten.",
  );
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/settings/memory", hash: "" }),
  );
});

it("reopens saved memory after sharing is disabled and the settings screen remounts", async () => {
  state.queries.set("list", Option.some({ items: [activeItem], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Synthetic original");
  state.responses.set(
    "syncStatus",
    success({ state: "disabled", memorySpaceId: null, retainedLocalSpaceId: id(1) }),
  );
  state.responses.set(
    "hubSettingsUpdate",
    success({ view: { version: 3, settings: { mode: "disabled" } }, credential: null }),
  );
  await click("Turn sharing off");
  await click("Stop sharing");
  await act(async () => root.render(null));
  await supportedScreen(false);
  expect(container.textContent).toContain("Synthetic original");
  expect(container.textContent).toContain("Turn on memory to save new memories.");
  expect(
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Remember something")!
      .disabled,
  ).toBe(true);
});

it("chooses an original from its bounded query while the ordinary history page has no input bodies", async () => {
  await renderRevert({ ...retained, revisions: [], nextCursor: "80" }, retained);
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(1);
  await chooseOriginal();
  await click("Revert resolution");
  expect(state.calls).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ restoredRevisionId: id(3) }) }),
  );
});

it("browses, searches and creates in an explicitly bound project, then returns to user scope", async () => {
  state.projects = [
    {
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: "remote-owner",
      repositoryIdentity: null,
    },
  ];
  const scope = {
    kind: "project",
    projectKey: { kind: "explicit", sharedProjectId: "synthetic-shared" },
  };
  state.responses.set(
    "projectBindingGet",
    success({ projectKey: scope.projectKey, repositoryKey: null }),
  );
  state.queries.set("list", Option.some({ items: [], nextCursor: null, projectionWatermark: 1 }));
  const { render } = await supportedScreen(false);
  await selectMemoryScope("project:synthetic-project");
  expect(state.calls).toHaveBeenCalledWith({
    environmentId: "remote-owner",
    input: {
      memorySpaceId: id(1),
      project: { environmentId: "remote-owner", projectId: "synthetic-project" },
    },
  });
  expect(state.requests.at(-1)).toMatchObject({ label: "list", input: { scope } });
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search memories"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "missing",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.queries.set(
    "search",
    Option.some({ items: [], nextCursor: "more", projectionWatermark: 1 }),
  );
  await click("Search");
  expect(state.requests.at(-1)).toMatchObject({
    label: "search",
    input: { scope, mode: "fts", query: "missing" },
  });
  expect(container.textContent).toContain("Continue to the next page");
  await click("Remember something");
  expect(container.textContent).toContain("Save to: Synthetic project");
  expect(container.textContent?.match(/Save to:/g)).toHaveLength(1);
  expect(container.textContent).not.toContain("New memory · Project");
  const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Memory text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Synthetic project memory",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.responses.set("upsert", success({ outcome: "accepted" }));
  await act(async () =>
    textarea
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const request = state.calls.mock.calls.at(-1)?.[0].input;
  expect(encodeUpsert(MemoryUpsertInput.make(request))).toMatchObject({
    scope,
    payload: { text: "Synthetic project memory" },
  });
  state.projects = [];
  await render();
  expect(container.querySelector('[aria-label="Search memories"]')).toBeNull();
  await selectMemoryScope("user");
  expect(state.requests.at(-1)).toMatchObject({
    label: "list",
    input: { scope: { kind: "user" } },
  });
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
});

it.each([false, true])(
  "retains the first project selection through navigation and late options/binding (explicit destination: %s)",
  async (explicitDestination) => {
    const project = {
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: "remote-owner",
      repositoryIdentity: null,
    };
    state.projects = [project];
    const pending = await deferredResult();
    state.executors.set("projectBindingGet", () => pending.promise);
    const { render } = await supportedScreen(explicitDestination, true);
    await selectMemoryScope("project:synthetic-project");
    state.projects = [{ ...project, title: "Resolved project" }];
    await render();
    expect(container.querySelector<HTMLSelectElement>("#memory-browse-scope select")?.value).toBe(
      "project:synthetic-project",
    );
    expect(container.querySelector('[aria-label="Search memories"]')).toBeNull();
    const scope = {
      kind: "project",
      projectKey: { kind: "explicit", sharedProjectId: "synthetic-shared" },
    };
    await act(async () =>
      pending.resolve(success({ projectKey: scope.projectKey, repositoryKey: null })),
    );
    expect(state.requests.at(-1)).toMatchObject({ label: "list", input: { scope } });
    await click("Remember something");
    expect(container.textContent).toContain("Save to: Resolved project");
    expect(container.textContent).not.toContain("Save to: User");
  },
);

it("offers User and projects without a context-free Thread option in Settings", async () => {
  state.threads = [{ id: "thread-a", environmentId: "remote-owner", title: "Thread A" }];
  await supportedScreen(false);
  const picker = container.querySelector<HTMLSelectElement>("#memory-browse-scope select")!;
  expect([...picker.options].map((option) => option.value).filter(Boolean)).toEqual(["user"]);
  expect(state.threadReads.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
});

it.each([false, true])(
  "keeps legacy history revert with incomplete page=%s",
  async (incomplete) => {
    for (const environment of state.environments)
      delete environment.serverConfig.environment.capabilities.memory.resolutionInputs;
    await renderRevert({ ...retained, nextCursor: incomplete ? "more" : null });
    expect(
      state.requests.some((request) => "resolutionInputsFor" in (request.input as object)),
    ).toBe(false);
    if (incomplete) {
      expect(container.textContent).toContain("Load complete history before reverting");
      expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
    } else {
      await chooseOriginal();
      await click("Revert resolution");
      expect(state.calls).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ restoredRevisionId: id(3) }) }),
      );
    }
  },
);

it("does not silently browse user memory when a project binding lookup fails", async () => {
  state.projects = [
    {
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: "remote-owner",
      repositoryIdentity: null,
    },
  ];
  await supportedScreen(false);
  await selectMemoryScope("project:synthetic-project");
  expect(container.textContent).toContain("Could not load project memory scope");
  expect(container.querySelector('[aria-label="Search memories"]')).toBeNull();
  state.responses.set(
    "projectBindingGet",
    success({
      projectKey: { kind: "explicit", sharedProjectId: "retry-shared" },
      repositoryKey: null,
    }),
  );
  await selectMemoryScope("project:synthetic-project");
  expect(state.requests.at(-1)).toMatchObject({
    label: "list",
    input: {
      scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "retry-shared" } },
    },
  });
  await selectMemoryScope("user");
  expect(container.querySelector('[aria-label="Search memories"]')).not.toBeNull();
});

it.each([{ items: [] }, { items: [activeItem] }])(
  "shows incomplete search coverage with matching items %j",
  async ({ items }) => {
    await supportedScreen(false);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search memories"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "pending",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.queries.set(
      "search",
      Option.some({
        items,
        nextCursor: null,
        projectionWatermark: 1,
        indexCoverage: {
          status: "partial",
          eligibleItems: 2,
          indexedItems: 1,
          unindexedItems: 1,
          projectionWatermark: 1,
        },
      }),
    );
    await click("Search");
    expect(container.textContent).toContain(
      items.length
        ? "Some memories are still being indexed"
        : "Results are incomplete; memories may still be available",
    );
    expect(container.textContent).not.toContain("No memories yet");
  },
);

it("ignores a late project binding after returning to user scope", async () => {
  state.projects = [
    {
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: "remote-owner",
      repositoryIdentity: null,
    },
  ];
  const pending = await deferredResult();
  state.executors.set("projectBindingGet", () => pending.promise);
  await supportedScreen(false);
  await selectMemoryScope("project:synthetic-project");
  expect(container.textContent).toContain("Loading project memory scope");
  await selectMemoryScope("user");
  await act(async () =>
    pending.resolve(
      success({
        projectKey: { kind: "explicit", sharedProjectId: "late-shared" },
        repositoryKey: null,
      }),
    ),
  );
  expect(state.requests.at(-1)).toMatchObject({
    label: "list",
    input: { scope: { kind: "user" } },
  });
  expect(container.textContent).not.toContain("Loading project memory scope");
});

it("explains why a read-only session cannot look up project keys", async () => {
  state.write = false;
  state.projects = [
    {
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: "remote-owner",
      repositoryIdentity: null,
    },
  ];
  await supportedScreen(false);
  expect(container.textContent).toContain("Project scope requires memory write permission");
  await selectMemoryScope("project:synthetic-project");
  expect(state.calls.mock.calls.some(([request]) => request?.input?.project)).toBe(false);
  expect(container.querySelector('[aria-label="Search memories"]')).not.toBeNull();
});

async function selectMemoryScope(value: string) {
  const picker = container.querySelector<HTMLSelectElement>(
    '#memory-browse-scope select[aria-label="Memory scope"]',
  )!;
  await act(async () => {
    picker.value = value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("keeps scope selection in one row with dozens of projects and selects the last project", async () => {
  state.projects = Array.from({ length: 60 }, (_, index) => ({
    id: `project-${index}`,
    title: `Project ${index}`,
    environmentId: "remote-owner",
    repositoryIdentity: null,
  }));
  state.responses.set(
    "projectBindingGet",
    success({
      projectKey: { kind: "explicit", sharedProjectId: "last-shared" },
      repositoryKey: null,
    }),
  );
  await supportedScreen(false);
  const picker = container.querySelector<HTMLSelectElement>(
    '#memory-browse-scope select[aria-label="Memory scope"]',
  )!;
  expect(picker.closest("section")!.querySelectorAll("[data-test-row]")).toHaveLength(1);
  expect(picker.querySelectorAll("option[value^='project:']")).toHaveLength(60);
  expect(picker.closest("section")!.querySelectorAll("button")).toHaveLength(0);
  await selectMemoryScope("project:project-59");
  expect(state.calls.mock.calls.at(-1)?.[0]).toMatchObject({
    input: { project: { projectId: "project-59" } },
  });
  expect(state.requests.at(-1)).toMatchObject({
    label: "list",
    input: {
      scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "last-shared" } },
    },
  });
});

// WP6 controls exercise the actual workflow/store; command transport is the fixture boundary.
async function renderControl(element: ReactNode | (() => ReactNode)) {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    return label ? (state.allowed as never) : get(atom);
  });
  const render = () =>
    act(async () => {
      notifyFixture();
      root.render(
        <RegistryContext value={registry}>
          {typeof element === "function" ? element() : element}
        </RegistryContext>,
      );
    });
  await render();
  return { registry, render };
}
async function chooseControl(value: string, index = 0) {
  const picker = container.querySelectorAll("select")[index]!;
  expect(picker).toBeDefined();
  await act(async () => {
    picker.value = value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const envId = EnvironmentId.make("remote-owner");
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";
import { MemoryReportRetrySettings } from "./MemoryReportRetrySettings";
import { MemoryScopeSettings } from "./MemoryScopeSettings";
import { MemoryImportSettings } from "./MemoryImportSettings";
import {
  MemorySpaceId,
  type MemoryImportProviderInput,
  type MemoryReportDelivery,
} from "@goat/contracts";
import {
  registerMemoryImportDestination,
  memoryImportRecoveryStorage,
} from "../../lib/memoryImportRecoveryStorage";
const spaceId = MemorySpaceId.make(id(1));
it("toggles environment agent access off and on through updateSettings independently of sharing", async () => {
  state.executors.set("updateSettings", async (input) => {
    state.calls(input);
    state.agentAccess = (
      input as { input: { patch: { enableAgentMemoryAccess: boolean } } }
    ).input.patch.enableAgentMemoryAccess;
    notifyFixture();
    return success({});
  });
  const view = await renderControl(<MemoryAgentAccessSettings environmentId={envId} />);
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle().click());
  expect(state.agentAccess).toBe(false);
  await act(async () => toggle().click());
  expect(state.agentAccess).toBe(true);
  expect(state.calls.mock.calls.map((call) => call[0])).toEqual(
    [false, true].map((enableAgentMemoryAccess) => ({
      environmentId: envId,
      input: { patch: { enableAgentMemoryAccess } },
    })),
  );
  state.allowed = false;
  await view.render();
  await act(async () => toggle().click());
  expect(state.calls).toHaveBeenCalledTimes(2);
});
it("bounds retry selection, preserves Unknown attempts, and displays reset/unchanged counts", async () => {
  const reports = Array.from({ length: 34 }, (_, index) => ({
    reportId: String(index).padStart(64, "0"),
    state: "failed",
    automaticAttempts: index === 33 ? undefined : 10,
    resolvingEnvironmentId: envId,
  })) as MemoryReportDelivery[];
  state.responses.set("resetReportAttempts", success({ resetCount: 30, unchangedCount: 2 }));
  const settled = vi.fn();
  const view = await renderControl(
    <MemoryReportRetrySettings
      environmentId={envId}
      memorySpaceId={spaceId}
      reports={reports}
      onSettled={settled}
    />,
  );
  expect(container.textContent).toContain("Automatic attempts: Unknown");
  for (const box of [
    ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].slice(0, 33))
    await act(async () => box.click());
  expect(container.querySelectorAll("input:checked")).toHaveLength(32);
  await click("Retry selected reports");
  expect(state.calls.mock.calls[0]![0]).toMatchObject({
    environmentId: envId,
    input: {
      environmentId: envId,
      memorySpaceId: spaceId,
      reportIds: reports.slice(0, 32).map((r) => r.reportId),
    },
  });
  expect(container.textContent).toContain("30 reports ready to retry; 2 unchanged");
  expect(settled).toHaveBeenCalledOnce();
  state.allowed = false;
  await view.render();
  expect(container.querySelectorAll("input:checked")).toHaveLength(0);
});
it("shows reset denial and does not offer unknown or foreign-owner reports", async () => {
  const reports = [
    {
      reportId: "a".repeat(64),
      state: "failed",
      automaticAttempts: 10,
      resolvingEnvironmentId: envId,
    },
    {
      reportId: "b".repeat(64),
      state: "failed",
      automaticAttempts: 10,
      resolvingEnvironmentId: "foreign",
    },
  ] as MemoryReportDelivery[];
  await renderControl(
    <MemoryReportRetrySettings
      environmentId={envId}
      memorySpaceId={spaceId}
      reports={reports}
      onSettled={() => undefined}
    />,
  );
  expect(container.querySelectorAll<HTMLInputElement>("input")[1]!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
  await click("Retry selected reports");
  expect(container.textContent).toContain("Report retry denied or unavailable");
});
it("uses binding CAS, reloads after conflict, and reverses dedicated identity to repository", async () => {
  state.projects = [{ id: "project-a", environmentId: envId, title: "Project A" }];
  const binding = {
    memorySpaceId: spaceId,
    project: { environmentId: envId, projectId: "project-a" },
    version: 4,
    projectKey: { kind: "repository", groupingKey: "private-repository-key" },
    repositoryKey: { kind: "repository", groupingKey: "private-repository-key" },
  };
  state.responses.set("projectBindingGet", success(binding));
  const selection = vi.fn();
  await renderControl(
    <MemoryScopeSettings environmentId={envId} memorySpaceId={spaceId} onChange={selection} />,
  );
  await chooseControl("project");
  await chooseControl("project-a", 1);
  expect(selection).toHaveBeenLastCalledWith({
    scope: { kind: "project", projectKey: binding.projectKey },
    project: binding.project,
  });
  await click("Create dedicated shared project");
  await click("Confirm binding change");
  expect(container.textContent).toContain("Reload before trying again");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
    input: { expectedVersion: 4, action: "setExplicit" },
  });
  const dedicated = {
    ...binding,
    version: 5,
    projectKey: { kind: "explicit", sharedProjectId: "private-shared-key" },
  };
  state.responses.set("projectBindingGet", success(dedicated));
  await click("Reload binding");
  state.responses.set("projectBindingUpdate", success({ binding: { ...binding, version: 6 } }));
  await click("Use repository identity");
  await click("Confirm binding change");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
    input: { expectedVersion: 5, action: "useRepository" },
  });
  expect(container.textContent).not.toContain("private-");
});
it("chooses all-project and thread scopes explicitly and clears a removed destination", async () => {
  state.threads = [{ id: "thread-a", environmentId: envId, title: "Thread A" }];
  const selection = vi.fn();
  const view = await renderControl(
    <MemoryScopeSettings environmentId={envId} memorySpaceId={spaceId} onChange={selection} />,
  );
  expect(selection).toHaveBeenLastCalledWith(null);
  await chooseControl("user");
  expect(selection).toHaveBeenLastCalledWith({ scope: { kind: "user" } });
  await chooseControl("thread");
  await chooseControl("thread-a", 1);
  expect(selection).toHaveBeenLastCalledWith({
    scope: { kind: "thread", thread: { environmentId: envId, threadId: "thread-a" } },
  });
  state.threads = [];
  await view.render();
  expect(selection).toHaveBeenLastCalledWith(null);
});
it("checks saved imports on a fresh mount without discovering, previewing, or applying", async () => {
  const operationId = (await import("@goat/contracts")).MemoryOperationId.make(id(77));
  await memoryImportRecoveryStorage().save(
    { environmentId: envId, memorySpaceId: spaceId },
    operationId,
  );
  state.executors.set("importProvider", async (request) => {
    state.calls(request);
    throw new Error("offline");
  });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  expect(
    state.calls.mock.calls.map(
      (call) => (call[0] as { input: MemoryImportProviderInput }).input.action,
    ),
  ).toEqual(["status"]);
  expect(container.textContent).toContain("Reconnect and check the import result");
  await click("Check import result");
  expect(
    state.calls.mock.calls.map(
      (call) => (call[0] as { input: MemoryImportProviderInput }).input.action,
    ),
  ).toEqual(["status", "status"]);
});
it("requires discover, preview, scope and selection confirmation before an explicit apply", async () => {
  const sourceId = id(61);
  state.executors.set("importProvider", async (request) => {
    state.calls(request);
    const input = (request as { input: MemoryImportProviderInput }).input;
    if (input.action === "discover")
      return {
        action: "discover",
        sources: [
          {
            sourceId,
            format: "codex",
            parserVersion: "one",
            profile: "private-profile",
            label: "private-path",
          },
        ],
      };
    if (input.action === "preview")
      return {
        action: "preview",
        sourceId,
        sessionId: "private-session",
        items: [
          {
            sourceItemKey: "private-selector",
            sourceFingerprint: "a".repeat(64),
            byteCount: 1,
            mappingRequired: false,
            title: "Synthetic memory",
          },
        ],
      };
    throw new Error("response lost");
  });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  await chooseControl("codex");
  await chooseControl("user", 1);
  await click("Discover profiles");
  await click("Preview profile 1");
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Confirm selection");
  expect(
    state.calls.mock.calls.map(
      (call) => (call[0] as { input: MemoryImportProviderInput }).input.action,
    ),
  ).toEqual(["discover", "preview"]);
  await click("Apply import");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: envId,
    input: { action: "apply", items: [{ scope: { kind: "user" } }] },
  });
  expect(container.textContent).toContain("The result is unknown");
  expect(container.textContent).not.toContain("private-");
});
it("shows the original empty list without inventing unknown coverage", async () => {
  state.queries.set("list", Option.some({ items: [], projectionWatermark: 0, nextCursor: null }));
  await supportedScreen(false);
  const records = container.querySelector("#memory-records")!;
  expect(records.textContent).toContain("No memories yet");
  expect(records.textContent).toContain("Memories saved on this device will appear here.");
  expect(records.textContent).not.toContain("Results are incomplete");
  expect(records.textContent).not.toContain("Memory coverage unknown");
});
it.each([undefined, "unknown", "partial", "available", "unavailable"] as const)(
  "shows one empty search message for %s coverage",
  async (status) => {
    state.queries.set(
      "search",
      Option.some({
        items: [],
        projectionWatermark: 0,
        nextCursor: null,
        ...(status
          ? {
              indexCoverage: {
                status,
                eligibleItems: 0,
                indexedItems: 0,
                unindexedItems: 0,
                projectionWatermark: 0,
              },
            }
          : {}),
      }),
    );
    await supportedScreen(false);
    await searchRecords();
    const records = container.querySelector("#memory-records")!;
    const incomplete = status !== undefined && status !== "available";
    expect(records.textContent?.match(/Results are incomplete/g) ?? []).toHaveLength(
      incomplete ? 1 : 0,
    );
    expect(records.textContent?.match(/No memories found/g) ?? []).toHaveLength(incomplete ? 0 : 1);
    expect(records.textContent).not.toContain("No memories yet");
    expect(records.textContent).not.toContain("Memory coverage unknown");
    expect(records.textContent).not.toContain("Some memories are still being indexed");
    expect(records.textContent).not.toContain("Memory search ready");
    if (status === "unavailable")
      expect(records.textContent).toContain("Memory search unavailable");
  },
);
it.each(["available", "partial"] as const)(
  "only shows a coverage row for incomplete populated search (%s)",
  async (status) => {
    state.queries.set(
      "search",
      Option.some({
        items: [activeItem],
        projectionWatermark: 0,
        nextCursor: null,
        indexCoverage: {
          status,
          eligibleItems: 2,
          indexedItems: status === "available" ? 2 : 1,
          unindexedItems: status === "available" ? 0 : 1,
          projectionWatermark: 0,
        },
      }),
    );
    await supportedScreen(false);
    await searchRecords();
    const records = container.querySelector("#memory-records")!;
    expect(records.textContent).toContain("Synthetic original");
    expect(records.textContent).not.toContain("Memory search ready");
    expect(records.textContent?.match(/Some memories are still being indexed/g) ?? []).toHaveLength(
      status === "partial" ? 1 : 0,
    );
    expect(records.textContent).not.toContain("Results are incomplete");
  },
);
async function searchRecords() {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search memories"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "synthetic",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Search");
}
it("preserves the recovery handle while disconnected and checks it on reconnect", async () => {
  const operationId = (await import("@goat/contracts")).MemoryOperationId.make(id(78));
  const store = memoryImportRecoveryStorage();
  await store.save({ environmentId: envId, memorySpaceId: spaceId }, operationId);
  state.executors.set("importProvider", async (request) => {
    state.calls(request);
    throw new Error("offline");
  });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  state.connection = null;
  await act(async () => root.render(null));
  expect((await store.load({ environmentId: envId, memorySpaceId: spaceId }))?.operationId).toBe(
    operationId,
  );
  state.connection = {};
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  expect(
    state.calls.mock.calls.map(
      (call) => (call[0] as { input: MemoryImportProviderInput }).input.action,
    ),
  ).toEqual(["status", "status"]);
});
it("waits for initial grants without deleting saved recovery and then issues status only", async () => {
  const operationId = (await import("@goat/contracts")).MemoryOperationId.make(id(79));
  const store = memoryImportRecoveryStorage();
  await store.save({ environmentId: envId, memorySpaceId: spaceId }, operationId);
  state.allowed = false;
  const view = await renderControl(
    <MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />,
  );
  expect((await store.load({ environmentId: envId, memorySpaceId: spaceId }))?.operationId).toBe(
    operationId,
  );
  expect(state.calls).not.toHaveBeenCalled();
  state.executors.set("importProvider", async (request) => {
    state.calls(request);
    throw new Error("offline");
  });
  state.allowed = true;
  await view.render();
  expect(
    state.calls.mock.calls.map(
      (call) => (call[0] as { input: MemoryImportProviderInput }).input.action,
    ),
  ).toEqual(["status"]);
});
it("drops an old reset response after revoke/regrant and accepts a fresh selection", async () => {
  const first = await deferredResult();
  state.executors.set("resetReportAttempts", async (request) => {
    state.calls(request);
    return first.promise;
  });
  const reports = [
    {
      reportId: "a".repeat(64),
      state: "failed",
      automaticAttempts: 10,
      resolvingEnvironmentId: envId,
    },
  ] as MemoryReportDelivery[];
  const view = await renderControl(
    <MemoryReportRetrySettings
      environmentId={envId}
      memorySpaceId={spaceId}
      reports={reports}
      onSettled={() => undefined}
    />,
  );
  await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
  await click("Retry selected reports");
  state.allowed = false;
  await view.render();
  state.allowed = true;
  await view.render();
  await act(async () => first.resolve(success({ resetCount: 1, unchangedCount: 0 })));
  expect(container.textContent).not.toContain("1 reports ready to retry");
  expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
  expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
});
it("awaits importer removal before submitting a binding CAS change", async () => {
  state.projects = [{ id: "project-a", environmentId: envId, title: "Project A" }];
  const binding = {
    memorySpaceId: spaceId,
    project: { environmentId: envId, projectId: "project-a" },
    version: 4,
    projectKey: { kind: "repository", groupingKey: "repository" },
    repositoryKey: { kind: "repository", groupingKey: "repository" },
  };
  state.responses.set("projectBindingGet", success(binding));
  state.responses.set(
    "projectBindingUpdate",
    success({
      binding: {
        ...binding,
        version: 5,
        projectKey: { kind: "explicit", sharedProjectId: "shared" },
      },
    }),
  );
  const removed = await deferredResult();
  let started = false;
  const unregister = registerMemoryImportDestination(
    { environmentId: envId, memorySpaceId: spaceId },
    async () => {
      started = true;
      await removed.promise;
    },
  );
  try {
    await renderControl(
      <MemoryScopeSettings
        environmentId={envId}
        memorySpaceId={spaceId}
        onChange={() => undefined}
      />,
    );
    await chooseControl("project");
    await chooseControl("project-a", 1);
    await click("Create dedicated shared project");
    await click("Confirm binding change");
    expect(started).toBe(true);
    expect(
      state.calls.mock.calls.filter(([request]) => request.input.action === "setExplicit"),
    ).toEqual([]);
    await act(async () => removed.resolve(undefined));
    expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
      input: { action: "setExplicit", expectedVersion: 4 },
    });
  } finally {
    unregister();
  }
});

it("gates diagnostics by capability and rearms with its version, then reloads both views", async () => {
  const refresh = vi.fn();
  state.responses.set(
    "hubDiagnostics",
    success({
      version: 7,
      publication: { state: "last_valid" },
      readiness: "ready",
      connection: "unreachable",
      recoverableHolds: ["availability"],
      permanentHolds: [],
      reconcile: "available",
    }),
  );
  state.responses.set("hubReconcile", success({}));
  const view = await renderControl(
    <MemoryHubDiagnosticsSettings
      environmentId={envId}
      sync={memorySyncFixture}
      onRefresh={refresh}
    />,
  );
  expect(container.textContent).not.toContain("Reconcile");
  state.environment = {
    serverConfig: {
      environment: { capabilities: { memory: { protocolVersion: 1, hubDiagnostics: true } } },
    },
  };
  await view.render();
  expect(container.textContent).toContain("Last valid settings in use");
  expect(container.textContent).toContain("Hub disconnected");
  await click("Reconcile");
  expect(state.calls).toHaveBeenCalledWith({
    environmentId: envId,
    input: {
      environmentId: envId,
      memorySpaceId: memorySyncFixture.memorySpaceId,
      expectedVersion: 7,
    },
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Synchronization may still be in progress");
  state.allowed = false;
  await view.render();
  expect(
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Reconcile")!
      .disabled,
  ).toBe(true);
  expect(container.textContent).not.toContain("Last valid settings in use");
});
it("distinguishes a saved memory ceiling from current permission and drops unknown evidence", async () => {
  let current: import("@goat/contracts").MemoryCurrentAccess | undefined = {
    access: "none",
    reason: "environment_off",
  };
  const view = await renderControl(() => (
    <MemoryRunAccessLabel memoryGrantCeiling="read_write" currentMemoryAccess={current} />
  ));
  expect(container.textContent).toContain("Memory limit: read & write");
  expect(container.textContent).toContain("Allowed now: None");
  current = undefined;
  await view.render();
  expect(container.textContent).not.toContain("Allowed now");
});

it("renders save failure, retries only on click and shows totals across chunks", async () => {
  const sourceId = id(61);
  const inputs: MemoryImportProviderInput[] = [];
  state.executors.set("importProvider", async (request) => {
    const input = (request as { input: MemoryImportProviderInput }).input;
    inputs.push(input);
    if (input.action === "discover")
      return {
        action: "discover",
        sources: [
          { sourceId, format: "codex", parserVersion: "one", profile: "fixture", label: "fixture" },
        ],
      };
    if (input.action === "preview")
      return {
        action: "preview",
        sourceId,
        sessionId: "fixture",
        items: Array.from({ length: 33 }, (_, i) => ({
          sourceItemKey: `item-${i}`,
          sourceFingerprint: "a".repeat(64),
          byteCount: 1,
          mappingRequired: false,
        })),
      };
    if (input.action === "apply")
      return {
        action: "apply",
        syncStatus: memorySyncFixture,
        receipt: {
          operationId: input.operationId,
          sourceId,
          sessionId: "fixture",
          sessionNewItems: 0,
          sessionBodyBytes: 0,
          state: "completed",
          remaining: 0,
          items: input.items.map((item) => ({
            sourceItemKey: item.sourceItemKey,
            outcome: "rejected",
            issue: "source_changed",
          })),
        },
      };
    throw new Error("Unexpected request");
  });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  await chooseControl("codex");
  await chooseControl("user", 1);
  await click("Discover profiles");
  await click("Preview profile 1");
  await act(async () => {
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      checkbox.click();
  });
  await click("Confirm selection");
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await click("Apply import");
  expect(container.textContent).toContain("Retry saving import");
  expect(inputs.filter((i) => i.action === "apply")).toHaveLength(0);
  save.mockRestore();
  await click("Retry saving import");
  expect(inputs.filter((i) => i.action === "apply")).toHaveLength(2);
  expect(container.textContent).toContain("33 rejected");
  expect(container.textContent).toContain("2 chunks completed");
});

it("shows refused history without consuming the one-time revert slot", async () => {
  await renderRevert({
    ...retained,
    revertResults: [
      decodeRevert({
        operationId: id(9),
        memoryId: id(2),
        resolutionId: id(6),
        revertDeadlineUtc: resolution.revertDeadlineUtc,
        status: "refused",
        failureCode: "source_invalidated",
      }),
    ],
  });
  expect(container.textContent).toContain("Last revert attempt was refused: source invalidated");
  expect(container.querySelector('[aria-label="Revert confirmation"]')).not.toBeNull();
  expect(state.calls).not.toHaveBeenCalled();
});

it("allows a fresh explicit attempt after a refused response", async () => {
  await renderRevert();
  await chooseOriginal();
  state.result = success(
    decodeRevert({
      operationId: id(9),
      memoryId: id(2),
      resolutionId: id(6),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "refused",
      failureCode: "source_invalidated",
    }),
  );
  await click("Revert resolution");
  const first = state.calls.mock.calls[0]![0] as { input: { operationId: string } };
  expect(container.textContent).toContain("Revert attempt refused");
  await chooseOriginal();
  state.result = success(
    decodeRevert({
      operationId: id(10),
      memoryId: id(2),
      resolutionId: id(6),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "pending",
    }),
  );
  await click("Revert resolution");
  const second = state.calls.mock.calls[1]![0] as { input: { operationId: string } };
  expect(second.input.operationId).not.toBe(first.input.operationId);
  expect(container.textContent).toContain("Waiting for revert approval");
});

it("keeps 2000 unrelated shells unsubscribed in user/project scope and only reports thread identity changes", async () => {
  state.threads = Array.from({ length: 2000 }, (_, i) => ({
    id: `thread-${i}`,
    environmentId: envId,
    title: `Thread ${i}`,
  }));
  const selection = vi.fn();
  const view = await renderControl(
    <MemoryScopeSettings environmentId={envId} memorySpaceId={spaceId} onChange={selection} />,
  );
  await chooseControl("user");
  selection.mockClear();
  state.threadReads.mockClear();
  state.threads = state.threads.map((thread) => ({ ...thread, title: `${thread.title} updated` }));
  await view.render();
  expect(state.threadReads.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
  expect(selection).not.toHaveBeenCalled();
  await chooseControl("project");
  selection.mockClear();
  state.threadReads.mockClear();
  await view.render();
  expect(state.threadReads.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
  expect(selection).not.toHaveBeenCalled();
  await chooseControl("thread");
  await chooseControl("thread-1999", 1);
  selection.mockClear();
  state.threads = state.threads.map((thread) => ({ ...thread, title: `${thread.title} again` }));
  await view.render();
  expect(selection).not.toHaveBeenCalled();
});
it("explains unavailable safe import admission while keeping Check import result enabled", async () => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  expect(container.textContent).toContain("This browser can't safely run imports");
  const check = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Check import result",
  )!;
  expect(check.disabled).toBe(false);
});
it("storage generation notification stops selection without deleting recovery", async () => {
  const { memoryImportGenerationKey } = await import("../../lib/memoryImportRecoveryStorage");
  const destination = { environmentId: envId, memorySpaceId: spaceId };
  const operationId = (await import("@goat/contracts")).MemoryOperationId.make(id(80));
  const store = memoryImportRecoveryStorage();
  await store.save(destination, operationId);
  state.executors.set("importProvider", async (request) => {
    state.calls(request);
    throw new Error("offline");
  });
  await renderControl(<MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />);
  await chooseControl("user", 1);
  expect(container.querySelectorAll("select")[1]!.value).toBe("user");
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: memoryImportGenerationKey({ environmentId: envId, memorySpaceId: spaceId }),
        storageArea: localStorage,
        newValue: "changed-by-other-tab",
      }),
    ),
  );
  expect(container.textContent).toContain("Destination changed. Choose a scope and preview again.");
  expect((await store.load(destination))?.operationId).toBe(operationId);
});

it("shows automatically initialized memory as on and usable without an enable action", async () => {
  state.queries.set("list", Option.some({ items: [], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("This device is the hub");
  expect(container.textContent).toContain("Memory is on.");
  expect(container.textContent).not.toContain("Sharing off");
  expect(container.textContent).not.toContain("Make this device the hub");
  expect(container.textContent).not.toContain("Turn on memory to");
  await click("Remember something");
  expect(container.querySelector('[aria-label="Memory text"]')).not.toBeNull();
});
