import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  startInstall: vi.fn(),
  refreshProviders: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providerAuthState: (() => "auth") as never,
      providerInstallState: (() => "installation") as never,
      startProviderInstall: setup.startInstall as never,
      refreshProviders: setup.refreshProviders as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    typeof command === "function" ? command : vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: string) => ({
    data: atom === "auth" ? setup.auth : setup.installation,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("claude_work");

function provider(patch: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Work",
    enabled: true,
    installed: true,
    version: null,
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: true, canInstall: false },
    ...patch,
  };
}

let root: Root;
const onFinish = vi.fn();

const render = (snapshot: ServerProvider | undefined) =>
  act(async () =>
    root.render(
      <ProviderWizardAuthenticationStep
        environmentId={environmentId}
        environmentLabel="Remote device"
        instanceId={instanceId}
        provider={snapshot}
        onFinish={onFinish}
      />,
    ),
  );
const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
};

describe("ProviderWizardAuthenticationStep", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setup.auth = null;
    setup.installation = null;
    setup.startInstall.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    setup.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    onFinish.mockReset();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("shows the device code of a sign-in in progress", async () => {
    setup.auth = {
      instanceId,
      phase: "waiting",
      flowId: "flow-1",
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      interaction: {
        id: "device",
        type: "deviceCode",
        url: "https://example.com/device",
        userCode: "ABCD-1234",
      },
    } as ProviderAuthState;
    await render(provider());

    expect(document.body.textContent).toContain("ABCD-1234");
    expect(button("Skip for now").disabled).toBe(true);
  });

  it("gives the provider's own command and rechecks it when sign-in cannot run in the app", async () => {
    await render(provider({ setup: { canAuthenticate: false, canInstall: false } }));

    expect(document.querySelector("code")?.textContent).toBe("claude auth login");
    await act(async () => button("Check again").click());
    expect(setup.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, fresh: true },
    });
  });

  it("installs a missing CLI in the app when the environment can", async () => {
    setup.installation = {
      driver: ProviderDriverKind.make("claudeAgent"),
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: null,
      installedVersion: null,
      canRemove: false,
      message: null,
    };
    await render(
      provider({ installed: false, setup: { canAuthenticate: true, canInstall: true } }),
    );

    await act(async () => button("Install Claude Work").click());
    expect(setup.startInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it("asks to install it on the environment when the app cannot", async () => {
    await render(provider({ installed: false }));

    expect(document.body.textContent).toContain("isn't installed on Remote device");
    expect(button("Check again")).toBeDefined();
  });

  it("reports a finished sign-in", async () => {
    await render(provider({ auth: { status: "authenticated" } }));

    await act(async () => button("Done").click());
    expect(onFinish).toHaveBeenCalledWith({ signedIn: true });
  });
});
