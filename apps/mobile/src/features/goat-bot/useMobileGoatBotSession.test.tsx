import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  resolveGoatBotHomeSelection,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import { EnvironmentId, ProjectId, ThreadId, type ChannelBotRef } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: null as ChannelBotRef | null,
  loaded: true,
  run: vi.fn(),
  save: vi.fn(),
}));
const connection = AsyncResult.success({ phase: "connected", generation: 1 });
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) =>
    atom === permissionAtom ? true : atom === connectionAtom ? connection : null,
  useAtomSet: () => harness.save,
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  runAtomCommand: harness.run,
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => connectionAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => connection },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    ensureBot: { permissionAtom: () => permissionAtom },
    ingest: { permissionAtom: () => permissionAtom },
  },
}));
vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ status: "loading" }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request" }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    ...harness,
    home: resolveGoatBotHomeSelection(harness.environments, harness.botRef),
  }),
}));
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";

const permissionAtom = Atom.make(true);
const connectionAtom = Atom.make(connection);
let root: Root | null = null;
let session: ReturnType<typeof useMobileGoatBotSession>;
function Consumer() {
  const value = useMobileGoatBotSession(true);
  useLayoutEffect(() => {
    session = value;
  }, [value]);
  return null;
}
async function render() {
  root ??= createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(<Consumer />);
  });
}
function environment(id: string, connected = true): GoatBotEnvironmentInput {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connected,
    primary: false,
    supportsChannelLedger: true,
  };
}
function bot(environmentId: EnvironmentId): ChannelBotRef {
  return { environmentId, projectId: ProjectId.make("project"), threadId: ThreadId.make("bot") };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [];
  harness.botRef = null;
  harness.loaded = true;
  harness.save.mockReset();
  harness.run.mockReset().mockImplementation(async (_registry, _command, { environmentId }) => ({
    _tag: "Success",
    value: bot(environmentId),
  }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("mobile GOAT Bot session selection", () => {
  it("keeps a missing legacy stored bot offline without ensuring on another server", async () => {
    harness.botRef = bot(EnvironmentId.make("missing-A"));
    harness.environments = [environment("missing-B")];
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(session.availability).toBe("offline");
  });
  it("keeps a disconnected legacy stored bot offline without replacing its reference", async () => {
    harness.botRef = bot(EnvironmentId.make("offline-A"));
    harness.environments = [environment("offline-A", false), environment("offline-B")];
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(session.availability).toBe("offline");
  });
  it("ensures on connected B when legacy A is offline and no bot is stored", async () => {
    harness.environments = [environment("new-A", false), environment("new-B")];
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: bot(EnvironmentId.make("new-B")) });
    expect(session.availability).toBe("ready");
  });
  it("does not ensure until delayed preferences identify stored B", async () => {
    harness.environments = [environment("loading-A"), environment("loading-B")];
    harness.loaded = false;
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    harness.loaded = true;
    harness.botRef = bot(EnvironmentId.make("loading-B"));
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: harness.botRef });
  });
  it("uses the shared claimed home B even when the stored bot belongs to A", async () => {
    const b = EnvironmentId.make("home-B");
    const claim = { environmentId: b, claimedAt: 1, claimId: "claim" };
    harness.botRef = bot(EnvironmentId.make("home-A"));
    harness.environments = [environment("home-A"), environment("home-B")].map((entry) => ({
      ...entry,
      homeTarget: {
        environmentId: entry.environmentId,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: claim,
      },
    }));
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: bot(b) });
    expect(session.availability).toBe("ready");
  });
});
