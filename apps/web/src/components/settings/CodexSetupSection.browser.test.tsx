import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ChatGptHandoffState,
  type ServerProvider,
} from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { act, render, stubGlobal } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  install: vi.fn(),
  handoff: vi.fn(),
  startAuth: vi.fn(),
  startInstall: vi.fn(),
  completeAuth: vi.fn(),
  cancelAuth: vi.fn(),
  cancelInstall: vi.fn(),
  reconnect: vi.fn(),
  importProfile: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  httpUrl: vi.fn(),
  primaryId: vi.fn(),
  environment: vi.fn(),
  prepared: vi.fn(),
  presentation: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: mocks.auth,
    providerInstallState: mocks.install,
    chatGptHandoffState: mocks.handoff,
    startProviderAuth: mocks.startAuth,
    startProviderInstall: mocks.startInstall,
    completeProviderAuth: mocks.completeAuth,
    cancelProviderAuth: mocks.cancelAuth,
    cancelProviderInstall: mocks.cancelInstall,
    chatGptReconnectProfile: mocks.reconnect,
    chatGptImportProfile: mocks.importProfile,
    refreshProviders: mocks.refresh,
    logoutProviderAuth: mocks.logout,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readPreparedConnection: mocks.prepared,
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: mocks.httpUrl,
  usePrimaryEnvironmentId: mocks.primaryId,
  useEnvironment: mocks.environment,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: mocks.presentation },
}));
vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null).pipe(Atom.keepAlive) };
});
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.open } }),
}));
vi.mock("./AddCodexAccountDialog", () => ({ AddCodexAccountDialog: () => null }));
vi.mock("./ChatGptAccountPicker", () => ({ ChatGptAccountPicker: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { CodexSetupSection } from "./CodexSetupSection";

const writablePrimaryEnvironmentId =
  primaryEnvironmentIdAtom as Atom.Writable<EnvironmentId | null>;

const environmentId = EnvironmentId.make("remote");
const primaryId = EnvironmentId.make("primary");
const instanceId = ProviderInstanceId.make("codex");
const installState = (overrides: Partial<ProviderInstallState> = {}): ProviderInstallState => ({
  driver: ProviderDriverKind.make("codex"),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: "2",
  installedVersion: "1",
  canRemove: true,
  message: null,
  ...overrides,
});
const authState = (overrides: Partial<ProviderAuthState> = {}): ProviderAuthState => ({
  instanceId,
  flowId: null,
  phase: "idle",
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  ...overrides,
});
const waiting = (flowId = "ours") =>
  authState({ flowId, phase: "waiting", authorizationUrl: `https://example.com/${flowId}` });
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup({ update = false, local = true, primary = false } = {}) {
  for (const mock of Object.values(mocks)) mock.mockReset();
  const installation = Atom.make<AsyncResult.AsyncResult<ProviderInstallState, never>>(
    AsyncResult.success(installState({ installedVersion: update ? "1" : "2" })),
  );
  const auth = Atom.make<AsyncResult.AsyncResult<ProviderAuthState, never>>(
    AsyncResult.success(authState()),
  );
  const handoff = Atom.make<AsyncResult.AsyncResult<ChatGptHandoffState, never>>(
    AsyncResult.initial(),
  );
  const connection = Atom.make({
    connection: { phase: primary ? "connected" : "disconnected" },
  }).pipe(Atom.keepAlive);
  appAtomRegistry.set(writablePrimaryEnvironmentId, primary ? primaryId : null);
  mocks.auth.mockReturnValue(auth);
  mocks.install.mockReturnValue(installation);
  mocks.handoff.mockReturnValue(handoff);
  mocks.presentation.mockReturnValue(connection);
  const url = local ? "http://127.0.0.1:1234" : "https://remote.example.com";
  mocks.httpUrl.mockImplementation((id) => (id === primaryId ? "http://127.0.0.1:2345" : url));
  mocks.prepared.mockImplementation((id) => ({
    httpBaseUrl: id === primaryId ? "http://127.0.0.1:2345" : url,
  }));
  mocks.primaryId.mockReturnValue(primary ? primaryId : null);
  mocks.environment.mockReturnValue({
    connection: { phase: primary ? "connected" : "disconnected" },
  });
  mocks.startInstall.mockResolvedValue({
    _tag: "Success",
    value: installState({ operationId: "ours", phase: "downloading" }),
  });
  mocks.startAuth.mockResolvedValue({
    _tag: "Success",
    value: authState({ flowId: "ours", phase: "starting" }),
  });
  for (const mock of [
    mocks.completeAuth,
    mocks.cancelAuth,
    mocks.cancelInstall,
    mocks.importProfile,
    mocks.refresh,
    mocks.logout,
  ])
    mock.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.reconnect.mockResolvedValue({ _tag: "Success", value: null });
  mocks.open.mockResolvedValue(undefined);
  return { installation, auth, handoff, connection };
}
function ui() {
  return (
    <AppAtomRegistryProvider>
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider}
        mode="managed"
        enabled
        onModeChange={() => {}}
      />
    </AppAtomRegistryProvider>
  );
}
async function publish<A>(
  atom: Atom.Writable<AsyncResult.AsyncResult<A, never>, AsyncResult.AsyncResult<A, never>>,
  value: A,
) {
  await act(() => appAtomRegistry.set(atom, AsyncResult.success(value)));
}

it("waits for the install it started instead of signing in with the previous runtime", async () => {
  const state = setup({ update: true });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  expect(mocks.startInstall).toHaveBeenCalledOnce();
  expect(mocks.startAuth).not.toHaveBeenCalled();
  await publish(state.installation, installState({ operationId: "other", phase: "succeeded" }));
  expect(mocks.startAuth).not.toHaveBeenCalled();
  await publish(
    state.installation,
    installState({ operationId: "ours", phase: "succeeded", installedVersion: "2" }),
  );
  expect(mocks.startAuth).toHaveBeenCalledOnce();
});

it.each(["failed", "cancelled"] as const)(
  "does not sign in after its install %s",
  async (phase) => {
    const state = setup({ update: true });
    await using screen = await render(ui());
    await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await publish(state.installation, installState({ operationId: "ours", phase }));
    expect(mocks.startAuth).not.toHaveBeenCalled();
  },
);

it("opens only the auth flow returned to this client", async () => {
  const state = setup();
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.auth, waiting("other"));
  expect(mocks.open).not.toHaveBeenCalled();
  await publish(state.auth, waiting());
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/ours");
});

it("opens an authorization page returned before its subscription updates", async () => {
  setup();
  mocks.startAuth.mockResolvedValue({ _tag: "Success", value: waiting() });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await vi.waitFor(() =>
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/ours"),
  );
});

it("does not open a late page after the card unmounts", async () => {
  const state = setup();
  const response = deferred<{ _tag: "Success"; value: ProviderAuthState }>();
  mocks.startAuth.mockReturnValue(response.promise);
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await screen.unmount();
  await act(() => response.resolve({ _tag: "Success", value: waiting() }));
  await publish(state.auth, waiting());
  expect(mocks.open).not.toHaveBeenCalled();
});

it("cancels install continuation even if the server later reports success", async () => {
  const state = setup({ update: true });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.installation, installState({ operationId: "ours", phase: "downloading" }));
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await publish(
    state.installation,
    installState({ operationId: "ours", phase: "succeeded", installedVersion: "2" }),
  );
  expect(mocks.startAuth).not.toHaveBeenCalled();
  expect(mocks.cancelInstall).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, operationId: "ours" },
  });
});

it("uses server callbacks for a local web connection", async () => {
  const state = setup();
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.auth, waiting());
  expect(mocks.startAuth).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ callbackMode: "server" }) }),
  );
  expect(mocks.open).toHaveBeenCalledOnce();
});

it("leaves a remote browser's sign-in page for an explicit click", async () => {
  const state = setup({ local: false });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.auth, waiting());
  expect(mocks.startAuth).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ callbackMode: "client" }) }),
  );
  expect(mocks.open).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Open ChatGPT sign-in", exact: true }).click();
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/ours");
});

it("completes a desktop callback against the flow that opened its page", async () => {
  const state = setup();
  const response = deferred<string>();
  const receive = vi.fn().mockReturnValue(response.promise);
  using _desktop = stubGlobal("desktopBridge", {
    receiveProviderAuthCallback: receive,
    cancelProviderAuthCallback: vi.fn().mockResolvedValue(undefined),
  });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.auth, waiting());
  expect(receive).toHaveBeenCalledExactlyOnceWith("https://example.com/ours");
  await act(() => response.resolve("http://localhost/callback?code=example"));
  expect(mocks.completeAuth).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, flowId: "ours", callbackUrl: "http://localhost/callback?code=example" },
  });
});

it("uses the primary environment connected while install was running", async () => {
  const state = setup({ update: true, local: false });
  using _desktop = stubGlobal("desktopBridge", {});
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await act(() => {
    appAtomRegistry.set(writablePrimaryEnvironmentId, primaryId);
    appAtomRegistry.set(state.connection, { connection: { phase: "connected" } });
  });
  await publish(
    state.installation,
    installState({ operationId: "ours", phase: "succeeded", installedVersion: "2" }),
  );
  expect(mocks.startAuth).not.toHaveBeenCalled();
  expect(mocks.reconnect).toHaveBeenCalledOnce();
  await publish(state.handoff, { phase: "auth", state: waiting("primary-flow") });
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/primary-flow");
});

it("does not complete a desktop callback after cancelling sign-in", async () => {
  const state = setup();
  const response = deferred<string>();
  using _desktop = stubGlobal("desktopBridge", {
    receiveProviderAuthCallback: vi.fn().mockReturnValue(response.promise),
    cancelProviderAuthCallback: vi.fn().mockResolvedValue(undefined),
  });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await publish(state.auth, waiting());
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await act(() => response.resolve("http://localhost/callback?code=cancelled"));
  expect(mocks.cancelAuth).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, flowId: "ours" },
  });
  expect(mocks.completeAuth).not.toHaveBeenCalled();
});

it("does not start sign-in after the installing card unmounts", async () => {
  const state = setup({ update: true });
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await screen.unmount();
  await publish(
    state.installation,
    installState({ operationId: "ours", phase: "succeeded", installedVersion: "2" }),
  );
  expect(mocks.startAuth).not.toHaveBeenCalled();
});

it("does not open the primary environment's page after cancelling its handoff", async () => {
  const state = setup({ local: false, primary: true });
  using _desktop = stubGlobal("desktopBridge", {});
  await using screen = await render(ui());
  await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await publish(state.handoff, { phase: "auth", state: waiting("primary-flow") });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.importProfile).not.toHaveBeenCalled();
});

it.each(["failed", "cancelled", "succeeded"] as const)(
  "stops waiting when its auth flow %s before a page arrives",
  async (phase) => {
    const state = setup();
    await using screen = await render(ui());
    await screen.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await publish(state.auth, authState({ flowId: "ours", phase }));
    await publish(state.auth, waiting());
    expect(mocks.open).not.toHaveBeenCalled();
  },
);

it("does not submit a cancelled desktop page manually opened from shared auth state", async () => {
  const state = setup();
  const response = deferred<string>();
  using _desktop = stubGlobal("desktopBridge", {
    receiveProviderAuthCallback: vi.fn().mockReturnValue(response.promise),
    cancelProviderAuthCallback: vi.fn().mockResolvedValue(undefined),
  });
  await using screen = await render(ui());
  await publish(state.auth, waiting("other-client"));
  await screen.getByRole("button", { name: "Open sign-in page", exact: true }).click();
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await act(() => response.resolve("http://localhost/callback?code=cancelled"));
  expect(mocks.completeAuth).not.toHaveBeenCalled();
});
