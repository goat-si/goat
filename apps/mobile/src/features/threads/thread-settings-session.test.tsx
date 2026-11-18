import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@goat/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  ThreadSettingsSessionProvider,
  useThreadSettingsSession,
  type ThreadSettingsSessionProps,
  type ThreadSettingsSessionValue,
} from "./thread-settings-session";

const mocks = vi.hoisted(() => ({ save: vi.fn(), alert: vi.fn() }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/use-model-option-memory", () => ({ rememberModelOptions: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentCatalog: { stateAtom: () => Atom.make(null) } };
});
vi.mock("../../state/preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: { updateSettings: {} },
  };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]) } };
});

const claude = ProviderInstanceId.make("claudeAgent");
const opus: ModelOption = {
  key: "claudeAgent:opus",
  label: "Opus",
  subtitle: "",
  providerKey: "claudeAgent",
  providerLabel: "Claude",
  providerDriver: "claudeAgent",
  isDefault: false,
  isLegacy: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
  }),
  selection: { instanceId: claude, model: "opus" },
};

async function mountSession(
  overrides: Partial<ThreadSettingsSessionProps> = {},
  options: { readonly settingsLoaded?: boolean } = {},
): Promise<{ readonly session: () => ThreadSettingsSessionValue } & AsyncDisposable> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.save.mockReset();
  mocks.alert.mockReset();
  const registry = AtomRegistry.make();
  if (options.settingsLoaded)
    registry.set(
      environmentServerConfigsAtom as unknown as Atom.Writable<ReadonlyMap<string, object>>,
      new Map([["env-a", { settings: DEFAULT_SERVER_SETTINGS, providers: [] }]]),
    );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const probe: { current: ThreadSettingsSessionValue | null } = { current: null };
  const Probe = (props: { readonly onSession: (session: ThreadSettingsSessionValue) => void }) => {
    props.onSession(useThreadSettingsSession());
    return null;
  };
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <ThreadSettingsSessionProvider
          environmentId={EnvironmentId.make("env-a")}
          projectId={null}
          cwd={null}
          providerGroups={[{ providerKey: "claudeAgent", providerLabel: "Claude", models: [opus] }]}
          selectedModel={{ instanceId: claude, model: "sonnet" }}
          prompt="Fix the build"
          onPromptChange={vi.fn()}
          onSelectModel={vi.fn()}
          optionDescriptors={[]}
          onUpdateOptionSelections={vi.fn()}
          runtimeMode="full-access"
          onUpdateRuntimeMode={vi.fn()}
          {...overrides}
        >
          <Probe
            onSession={(session) => {
              probe.current = session;
            }}
          />
        </ThreadSettingsSessionProvider>
      </RegistryContext>,
    ),
  );
  return {
    session: () => {
      if (!probe.current) throw new Error("session not mounted");
      return probe.current;
    },
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      registry.dispose();
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

describe("ThreadSettingsSessionProvider", () => {
  it("applies a model picked from the composer with its remembered options", async () => {
    const onSelectModel = vi.fn();
    const remembered = [{ id: "effort", value: "high" }];
    await using mounted = await mountSession({
      onSelectModel,
      restoreSelection: (selection) => ({ ...selection, options: remembered }),
    });

    let applied = false;
    await act(async () => {
      applied = mounted.session().selectModel(opus);
    });

    expect(applied).toBe(true);
    expect(onSelectModel).toHaveBeenCalledWith({
      ...opus,
      selection: { ...opus.selection, options: remembered },
    });
  });

  it("leaves the prompt and options unchanged when Ultrathink comes from a picker", async () => {
    const onPromptChange = vi.fn();
    const onUpdateOptionSelections = vi.fn();
    const descriptors = getProviderOptionDescriptors({ caps: opus.capabilities!, selections: [] });
    await using mounted = await mountSession({
      selectedModel: opus.selection,
      optionDescriptors: descriptors,
      onPromptChange,
      onUpdateOptionSelections,
    });

    await act(async () => mounted.session().applyOptionChange("effort", "ultrathink"));

    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onUpdateOptionSelections).not.toHaveBeenCalled();
  });
});

const hideable: ModelOption = { ...opus, canHide: true, isHidden: false };
const offline = () =>
  AsyncResult.failure(Cause.fail(new Error("Studio is not connected."))) as AsyncResult.AsyncResult<
    unknown,
    unknown
  >;

describe("model picker failures (#3556)", () => {
  it.each([
    [false, "Could not hide the model"],
    [true, "Could not show the model"],
  ] as const)(
    "says why the model could not change when hidden is %s (#3556)",
    async (isHidden, title) => {
      await using mounted = await mountSession({}, { settingsLoaded: true });
      mocks.save.mockResolvedValueOnce(offline());
      await act(async () => mounted.session().toggleHidden({ ...hideable, isHidden }));
      expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(title, "Studio is not connected.");
    },
  );

  it("says favorites were not saved when the save fails (#3556)", async () => {
    await using mounted = await mountSession({}, { settingsLoaded: true });
    mocks.save.mockResolvedValueOnce(offline());
    await act(async () => mounted.session().toggleFavorite(opus));
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
      "Favorites not saved",
      "Studio is not connected.",
    );
  });

  it("an earlier favorite save that fails after a later toggle alerts nothing (#3556)", async () => {
    await using mounted = await mountSession({}, { settingsLoaded: true });
    const earlier = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
    mocks.save.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(AsyncResult.success({}));
    let first: Promise<void> | undefined;
    await act(async () => {
      first = Promise.resolve(mounted.session().toggleFavorite(opus));
    });
    await act(async () => mounted.session().toggleFavorite(opus));
    await act(async () => {
      earlier.resolve(offline());
      await first;
    });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("a crash while saving a favorite shows the plain fallback (#3556)", async () => {
    await using mounted = await mountSession({}, { settingsLoaded: true });
    mocks.save.mockResolvedValueOnce(
      AsyncResult.failure(Cause.die(new Error("boom"))) as AsyncResult.AsyncResult<
        unknown,
        unknown
      >,
    );
    await act(async () => mounted.session().toggleFavorite(opus));
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
      "Favorites not saved",
      "The change was not saved. Try again.",
    );
  });

  it("guard: hiding again after a failure sends again (#3556)", async () => {
    await using mounted = await mountSession({}, { settingsLoaded: true });
    mocks.save.mockResolvedValueOnce(offline()).mockResolvedValueOnce(AsyncResult.success({}));
    await act(async () => mounted.session().toggleHidden(hideable));
    await act(async () => mounted.session().toggleHidden(hideable));
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it.each(["toggleHidden", "toggleFavorite"] as const)(
    "guard: an interrupted save from %s shows nothing (#3556)",
    async (toggle) => {
      await using mounted = await mountSession({}, { settingsLoaded: true });
      mocks.save.mockResolvedValueOnce(
        AsyncResult.failure(Cause.interrupt()) as AsyncResult.AsyncResult<unknown, unknown>,
      );
      await act(async () => mounted.session()[toggle](hideable));
      expect(mocks.alert).not.toHaveBeenCalled();
    },
  );
});
