import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderInstanceId, type ModelSelection } from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  ThreadSettingsSessionProvider,
  useThreadSettingsSession,
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

describe("ThreadSettingsSessionProvider", () => {
  it("Keep current drops a pending switch and its prompt when the thread's model is not in the catalog", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const registry = AtomRegistry.make();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelectModel = vi.fn();
    const onPromptChange = vi.fn();
    const unlisted: ModelSelection = { instanceId: claude, model: "retired-model" };
    let session: ThreadSettingsSessionValue | null = null;
    const Probe = () => {
      session = useThreadSettingsSession();
      return null;
    };
    const current = () => {
      if (!session) throw new Error("session not mounted");
      return session;
    };
    try {
      await act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <ThreadSettingsSessionProvider
              environmentId={EnvironmentId.make("env-a")}
              projectId={null}
              providerGroups={[
                { providerKey: "claudeAgent", providerLabel: "Claude", models: [opus] },
              ]}
              selectedModel={unlisted}
              prompt="Fix the build"
              onPromptChange={onPromptChange}
              onSelectModel={onSelectModel}
              optionDescriptors={[]}
              onUpdateOptionSelections={vi.fn()}
              runtimeMode="full-access"
              onUpdateRuntimeMode={vi.fn()}
            >
              <Probe />
            </ThreadSettingsSessionProvider>
          </RegistryContext>,
        ),
      );
      expect(current().appliedModel).toBeNull();
      expect(current().appliedModelSelection).toEqual(unlisted);

      await act(async () => current().pressModel(opus));
      await act(async () => current().applyOptionChange("effort", "ultrathink"));
      expect(current().pendingModel?.key).toBe(opus.key);

      await act(async () => current().keepAppliedModel());
      expect(current().pendingModel).toBeNull();
      expect(current().displayedModelSelection).toEqual(unlisted);
      expect(current().commitPendingModel()).toBe(true);
      expect(onSelectModel).not.toHaveBeenCalled();
      expect(onPromptChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
