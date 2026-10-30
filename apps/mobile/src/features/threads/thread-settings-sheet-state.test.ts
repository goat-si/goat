import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { EnvironmentId, ProviderInstanceId, type ProviderOptionSelection } from "@goat/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { modelOptionMemoryAtom } from "../../state/use-composer-drafts";
import { canSelectModel } from "./thread-settings-sheet-state";
import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";

vi.hoisted(() =>
  Object.assign(globalThis, {
    __DEV__: true,
    expo: {
      EventEmitter: class {
        readonly native = true;
      },
    },
  }),
);

const route = vi.hoisted(() => ({
  session: null as { readonly ownerId: string } | null,
  focus: () => {},
  screens: [] as string[],
}));

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    StackActions: { push: (name: string) => name },
    useNavigation: () => ({
      dispatch: (name: string) => route.screens.push(name),
      addListener: () => () => {},
    }),
    useFocusEffect: (callback: () => void) => {
      useEffect(() => {
        route.focus = callback;
        return () => {
          route.focus = () => {};
        };
      }, [callback]);
    },
  };
});
vi.mock("./ThreadSettingsSheet", () => ({
  useExistingThreadSettingsRoutePresentation: () => ({
    present: (session: { readonly ownerId: string }) => {
      route.session = session;
    },
    clear: (ownerId: string) => {
      if (route.session?.ownerId === ownerId) route.session = null;
    },
  }),
}));
vi.mock("./use-thread-settings-sheet-presentation", async () => {
  const { useState } = await import("react");
  return {
    useThreadSettingsSheetPresentation: () => {
      const [visible, setVisible] = useState(false);
      return {
        isActive: visible,
        isVisible: visible,
        keepsComposerExpanded: visible,
        open: () => setVisible(true),
        onDismissed: () => setVisible(false),
        onStackTransitionsFinished: () => {},
      };
    },
  };
});
vi.mock("../../components/ComposerModelControl", async () => {
  const { createElement } = await import("react");
  return {
    ComposerModelControl: ({ onPress }: { onPress: () => void }) =>
      createElement("button", { onClick: onPress }, "Model settings"),
  };
});
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View,
    Platform: { OS: "android" },
    Keyboard: { dismiss: () => {} },
  };
});
vi.mock("expo", () => ({ requireNativeModule: vi.fn(), requireOptionalNativeModule: vi.fn() }));
vi.mock("expo-crypto", () => ({
  EncryptionKey: class {
    readonly native = true;
  },
  getRandomBytes: (length: number) => new Uint8Array(length),
  digest: async () => new Uint8Array(32),
  CryptoDigestAlgorithm: { SHA1: "SHA-1", SHA256: "SHA-256", SHA384: "SHA-384", SHA512: "SHA-512" },
}));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK: "afterFirstUnlock" }));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-modules-core", () => ({
  EventEmitter: class {
    readonly native = true;
  },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const { View } = await import("react-native");
  const animation = {
    delay: () => animation,
    duration: () => animation,
    reduceMotion: () => animation,
  };
  return {
    default: { View, createAnimatedComponent: (component: unknown) => component },
    FadeIn: animation,
    FadeOut: animation,
    ReduceMotion: { System: "system" },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => useRef({ value, set: () => {} }).current,
    withTiming: (value: number) => value,
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}), useAtomRefresh: () => () => {} }));
vi.mock("../../state/queued-run-edit", () => ({ setActiveComposerDraftText: () => {} }));
vi.mock("../../state/use-composer-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/use-composer-drafts")>()),
  useComposerDraft: () => ({ text: "", attachments: [] }),
}));
vi.mock("../../state/entities", () => ({ useProject: () => null, useThreadShells: () => [] }));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadsAtom: {},
  composerAttachmentsStillUploading: () => false,
  composerAttachmentUploadBlockReason: () => null,
}));
vi.mock("../workspace/useSystemWorkspaceTabBar", () => ({ useSidebarWorkspaceTabs: () => null }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ setComposerEditing: () => {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: { "--color-composer-panel": "#ffffff" } }),
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 14, lineHeight: 20 }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/composerImages", () => ({ composerStripAttachments: () => [] }));
vi.mock("../../lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));
vi.mock("../../lib/filePreviewGallery", () => ({ filePreviewGallery: () => [] }));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  armAgentAwarenessLiveActivityForLocalWork: () => {},
}));
vi.mock("./use-composer-command-menu", () => ({
  useComposerCommandMenu: () => ({ trigger: null, items: [], skills: [], selection: null }),
}));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ state: { phase: "idle" }, elapsedSeconds: 0 }),
}));
vi.mock("../voice-input/ComposerDictationControl", async () => {
  const { View } = await import("react-native");
  return {
    ComposerDictationDraftContent: View,
    ComposerDictationToolbar: () => null,
    ComposerDictationCancelAction: () => null,
    ComposerDictationPrimaryAction: () => null,
    ComposerDictationStartAction: () => null,
    ComposerDictationStatus: () => null,
  };
});
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: () => null }));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: () => null,
  ComposerToolbarRow: () => null,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
  ComposerAttachmentThumbnail: () => null,
}));
vi.mock("./ComposerAttachmentButton", () => ({ ComposerAttachmentButton: () => null }));
vi.mock("./ComposerQueuedEdit", () => ({ ComposerQueuedEditAttachments: () => null }));
vi.mock("./ComposerCommandPopover", () => ({ ComposerCommandPopover: () => null }));
vi.mock("./ComposerPopoverAnchor", () => ({ ComposerPopoverAnchor: () => null }));

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    },
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("thread settings sheet state", () => {
  it("clears the composer's settings session on return and can present it again", async () => {
    route.session = null;
    route.screens = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environmentId = EnvironmentId.make("settings-environment");
    const selection = modelOption("gpt-next").selection;
    const noop = () => {};
    const props: ThreadComposerProps = {
      environmentId,
      selectedThread: {
        id: "settings-thread",
        projectId: "settings-project",
        environmentId,
        title: "Settings regression",
        modelSelection: selection,
        runtimeMode: "full-access",
      } as ThreadComposerProps["selectedThread"],
      placeholder: "Message",
      environmentLabel: null,
      projectCwd: null,
      serverConfig: null,
      connectionState: "offline",
      canOperateThread: true,
      canSwitchProvider: true,
      hasCompactableConversation: false,
      queueCount: 0,
      activeThreadBusy: false,
      canStopThread: false,
      canSteerActiveTurn: false,
      followUpBehavior: "queue",
      hidden: false,
      onChangeDraftMessage: noop,
      onPickDraftMedia: async () => {},
      onPickDraftFiles: async () => {},
      onNativePasteImages: async () => {},
      onNativePasteText: async () => {},
      onRemoveDraftImage: noop,
      onStopThread: noop,
      onResumeQueue: null,
      onSendMessage: async () => null,
      onShowUsageLimits: noop,
      onUpdateModelSelection: noop,
      onUpdateRuntimeMode: noop,
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ThreadComposer, props)));
      const button = container.querySelector("button");
      if (!button) throw new Error("Model settings control was not rendered");
      await act(async () => button.click());
      expect(route.screens).toEqual(["ThreadSettingsSheet"]);
      expect(route.session).toMatchObject({ ownerId: "settings-environment:settings-thread" });
      await act(async () => route.focus());
      expect(route.session).toBeNull();
      await act(async () => button.click());
      expect(route.screens).toEqual(["ThreadSettingsSheet", "ThreadSettingsSheet"]);
      expect(route.session).toMatchObject({ ownerId: "settings-environment:settings-thread" });
    } finally {
      await act(async () => root.unmount());
      route.session = null;
    }
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canSelectModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot select a model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canSelectModel(pending, [group])).toBe(true);
    expect(canSelectModel(pending, [])).toBe(false);
    expect(
      canSelectModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});
