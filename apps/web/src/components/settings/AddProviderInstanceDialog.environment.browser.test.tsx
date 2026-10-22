import {
  DEFAULT_OPENCODEX_BASE_URL,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AcpRegistrySearchAgent,
  type ServerProvider,
} from "@goat/contracts";
import { act, render as renderScreen } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  onFinished: vi.fn(),
  canManageProviders: true,
  providers: [] as ServerProvider[],
}));
const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));
const preparedAgent = vi.hoisted((): AcpRegistrySearchAgent => ({
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
}));

vi.mock(import("@goat/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: settingsHooks.read as never,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  // One atom per fixture list, so a test's snapshots are what the dialog reads.
  let cached: { readonly value: ServerProvider[]; readonly atom: unknown } | undefined;
  const providers = () => {
    if (cached?.value !== actions.providers) {
      cached = { value: actions.providers, atom: Atom.make(actions.providers) };
    }
    return cached.atom;
  };
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, providersValueAtom: providers as never },
  };
});
// The registry search and the sign-in step talk to the environment over RPC; these
// stand-ins expose the choices a user makes there.
vi.mock(import("./AcpRegistrySearchStep"), async (original) => ({
  ...(await original()),
  AcpRegistrySearchStep: ((props: {
    onPrepared: (agent: AcpRegistrySearchAgent) => void;
    onManualConfiguration: () => void;
    onLocalConfiguration: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onPrepared(preparedAgent)}>
        Use Kilo Code
      </button>
      <button type="button" onClick={props.onManualConfiguration}>
        Enter registry agent
      </button>
      <button type="button" onClick={props.onLocalConfiguration}>
        Use local command
      </button>
    </div>
  )) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: (props: {
    environmentId: string;
    instanceId: string;
    onFinish: (result: { readonly signedIn: boolean }) => void;
  }) => (
    <section aria-label="Setup step">
      {props.environmentId}/{props.instanceId}
      <button type="button" onClick={() => props.onFinish({ signedIn: true })}>
        Finish sign-in
      </button>
    </section>
  ),
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
const input = (selector: string) => {
  const found = document.querySelector<HTMLInputElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
async function type(selector: string, value: string) {
  await userEvent.fill(input(selector), value);
  await act(async () => input(selector).blur());
}
const signInStep = () => document.querySelector('[aria-label="Setup step"]');
const radio = (label: string) =>
  [...document.querySelectorAll('[role="radio"]')].find((element) =>
    element.textContent?.includes(label),
  ) as HTMLElement;

function snapshot(
  instanceId: string,
  driver: string,
  patch: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

function setup() {
  const stack = new AsyncDisposableStack();
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

  actions.canManageProviders = true;
  actions.providers = [];
  actions.toast.mockReset();
  actions.onOpenChange.mockReset();
  actions.onFinished.mockReset();
  settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
  settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);

  async function render(
    onOpenChange = actions.onOpenChange,
    initialCodexRoute?: "opencodex",
    extra: { initialInstanceId?: ProviderInstanceId; initialDriver?: ProviderDriverKind } = {},
  ) {
    const ui = (
      <AddProviderInstanceDialog
        open
        environmentId={remoteEnvironmentId}
        environmentLabel="Remote device"
        onOpenChange={onOpenChange}
        onFinished={actions.onFinished}
        initialCodexRoute={initialCodexRoute}
        {...extra}
      />
    );
    if (screen) await screen.rerender(ui);
    else screen = stack.use(await renderScreen(ui));
  }

  async function prepareCodexInstance() {
    await render();
    await click("Configure manually");
    await type("#add-provider-label", "Work");
    await click("Next");
  }

  return { render, prepareCodexInstance, [Symbol.asyncDispose]: () => stack.disposeAsync() };
}

describe("AddProviderInstanceDialog environment routing", () => {
  it("creates a provider with its default identity without typing", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render();
    await act(async () => radio("Grok").click());
    await click("Next");
    await click("Next");
    await click("Add and set up");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("shows each provider's install and sign-in state on the provider list", async () => {
    await using fixture = setup();
    const { render } = fixture;

    actions.providers = [
      snapshot("codex", "codex", { auth: { status: "authenticated" } }),
      snapshot("claudeAgent", "claudeAgent"),
      snapshot("cursor", "cursor", { installed: false, status: "error" }),
    ];
    await render();

    expect(radio("Codex").textContent).toContain("Signed in");
    expect(radio("Claude").textContent).toContain("Installed");
    expect(radio("Cursor").textContent).toContain("Not installed");
    expect(radio("Grok").textContent).not.toMatch(/Installed|Signed in/);
  });

  it("finishes in the setup step for every driver and reports the new instance", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render();
    await act(async () => radio("Grok").click());
    await click("Next");
    await click("Next");
    await click("Add and set up");

    expect(signInStep()?.textContent).toContain("remote-device/grok");
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await click("Finish sign-in");
    expect(actions.onFinished).toHaveBeenCalledWith({ instanceId: "grok", signedIn: true });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens an existing instance straight to its setup step", async () => {
    await using fixture = setup();
    const { render } = fixture;

    actions.providers = [snapshot("claudeAgent", "claudeAgent")];
    await render(actions.onOpenChange, undefined, {
      initialInstanceId: ProviderInstanceId.make("claudeAgent"),
    });

    expect(signInStep()?.textContent).toContain("remote-device/claudeAgent");
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Set up");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
  });

  it("preselects the requested driver", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render(actions.onOpenChange, undefined, {
      initialDriver: ProviderDriverKind.make("opencode"),
    });

    expect(radio("OpenCode").getAttribute("aria-checked")).toBe("true");
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    await using fixture = setup();
    const { render } = fixture;

    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_2: { driver: "codex", enabled: false } },
    });
    await render();
    await click("Configure manually");
    await click("Next");
    await click("Add and set up");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    await using fixture = setup();
    const { render } = fixture;

    const mutation = deferred<{ readonly _tag: "Success"; readonly value: unknown }>();
    settingsHooks.mutate.mockReturnValueOnce(mutation.promise);
    await render();
    await click("Use Kilo Code");

    expect(document.body.textContent).toContain("v4.2.0 · binary");
    await click("Add and set up");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        displayName: "Kilo Code",
        config: {
          agentId: "kilo",
          distribution: "auto",
          registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
        },
      },
    });
    expect(signInStep()).toBeNull();

    await act(async () => mutation.resolve({ _tag: "Success", value: {} }));
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(signInStep()?.textContent).toContain("remote-device/acpRegistry_kilo_code");
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    await click("Finish sign-in");
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render();
    await click("Enter registry agent");
    await type("#add-provider-acpRegistry-manual-agentId", "devin");
    await click("Next");
    await click("Add and set up");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    expect(signInStep()).not.toBeNull();
  });

  it("creates a local command in the selected environment, then sets it up", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render();
    await click("Use local command");
    await click("Next");
    expect(document.body.textContent).toContain("Executable is required.");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    await type("#add-provider-acpRegistry-manual-commandPath", "dsh");
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    for (const [index, argument] of commandArgs.entries()) {
      await click("Add argument");
      if (argument) await type(`input[aria-label="Argument ${index + 1}"]`, argument);
    }
    await click("Add variable");
    await type('input[aria-label="Environment variable name 1"]', "DSH_PROFILE");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Mark environment variable DSH_PROFILE as sensitive"]',
        )!
        .click(),
    );
    await type('input[aria-label="Environment variable value 1"]', "work");
    await click("Next");
    await type("#add-provider-label", "Deepseek Harness");
    await click("Add and set up");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment: [
          expect.objectContaining({ name: "DSH_PROFILE", value: "work", sensitive: false }),
        ],
      },
    });
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(signInStep()?.textContent).toContain("acpRegistry_deepseek_harness");
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    await using fixture = setup();
    const { render } = fixture;

    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    await render();
    await click("Use Kilo Code");
    await click("Add and set up");

    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not add provider instance" }),
    );
    expect(button("Add and set up").disabled).toBe(false);
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    await using fixture = setup();
    const { prepareCodexInstance } = fixture;

    await prepareCodexInstance();
    await click("Add and set up");

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_work",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: { setupMode: "existing" },
      },
    });
    expect(signInStep()?.textContent).toContain("remote-device/codex_work");
  });

  it("rejects a queued save after the provider grant is revoked", async () => {
    await using fixture = setup();
    const { render, prepareCodexInstance } = fixture;

    await prepareCodexInstance();
    const save = button("Add and set up");
    actions.canManageProviders = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await render();
    expect(button("Add and set up").disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    await using fixture = setup();
    const { render, prepareCodexInstance } = fixture;

    actions.canManageProviders = false;
    await prepareCodexInstance();
    expect(button("Add and set up").disabled).toBe(true);
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    await render();
    expect(button("Add and set up").disabled).toBe(false);
    await click("Add and set up");
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(signInStep()).not.toBeNull();
  });
});

describe("OpenCodex Home routing", () => {
  it("creates the Home preset in the selected environment", async () => {
    await using fixture = setup();
    const { render } = fixture;

    await render(actions.onOpenChange, "opencodex");
    await click("Next");
    await click("Add and set up");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith({
      operation: "create",
      instanceId: "codex_home",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex · OpenCodex Home",
        config: {
          setupMode: "existing",
          modelRoute: "opencodex",
          opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
        },
      },
    });
  });

  it("keeps the user home and rejects a duplicate instance id", async () => {
    await using fixture = setup();
    const { render } = fixture;

    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_home: { driver: "codex", enabled: true } },
    });
    await render(actions.onOpenChange, "opencodex");
    await click("Next");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    await type("#add-provider-instance-id", "codex_home_2");
    await click("Next");
    await type("#add-provider-codex-homePath", "/home/person/.codex");
    await click("Add and set up");

    expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        instanceId: "codex_home_2",
        instance: expect.objectContaining({
          config: expect.objectContaining({
            setupMode: "existing",
            modelRoute: "opencodex",
            homePath: "/home/person/.codex",
          }),
        }),
      }),
    );
  });
});
