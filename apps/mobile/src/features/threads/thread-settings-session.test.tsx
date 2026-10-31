import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@goat/shared/model";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  ThreadSettingsSessionProvider,
  useThreadSettingsSession,
  type ThreadSettingsSessionProps,
  type ThreadSettingsSessionValue,
} from "./thread-settings-session";

vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/use-model-option-memory", () => ({ rememberModelOptions: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
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
): Promise<{ readonly session: () => ThreadSettingsSessionValue } & AsyncDisposable> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
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
