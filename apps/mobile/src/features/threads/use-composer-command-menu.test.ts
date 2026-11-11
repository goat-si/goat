import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@goat/contracts";

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

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
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
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  useComposerDraftSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
  environmentServerConfigsAtom: {},
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  resolveComposerMenuSelection,
  resolveComposerSendIntercept,
} from "./use-composer-command-menu";

describe("resolveComposerMenuSelection", () => {
  it("prefers the caret an insertion placed in the current draft text", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hello @chip ",
        ownerKey: "draft-a",
        inserted: { start: 12, end: 12 },
        local: { ownerKey: "draft-a", start: 2, end: 2 },
      }),
    ).toEqual({ start: 12, end: 12 });
  });

  it("clamps the composer's own caret when the draft shrinks", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hi",
        ownerKey: "draft-a",
        inserted: null,
        local: { ownerKey: "draft-a", start: 5, end: 9 },
      }),
    ).toEqual({ start: 2, end: 2 });
  });

  it("starts at the end of the draft after switching owners", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "other draft",
        ownerKey: "draft-b",
        inserted: null,
        local: { ownerKey: "draft-a", start: 1, end: 1 },
      }),
    ).toEqual({ start: 11, end: 11 });
  });
});

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("still applies the GOAT plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("mobile /fork command", () => {
  const forkItems = (input: { readonly offersFork: boolean; readonly atMessageStart?: boolean }) =>
    buildComposerSlashCommandItems({
      query: "fo",
      atMessageStart: input.atMessageStart ?? true,
      hasThread: true,
      offersFork: input.offersFork,
      allowInteractionMode: true,
      selectedProviderStatus: null,
    }).filter((item) => item.id === "cmd:fork");

  it("is offered only for a forkable thread at the start of the message", () => {
    expect(forkItems({ offersFork: true })).toEqual([
      expect.objectContaining({ type: "slash-command", command: "fork", label: "/fork" }),
    ]);
    expect(forkItems({ offersFork: false })).toEqual([]);
    expect(forkItems({ offersFork: true, atMessageStart: false })).toEqual([]);
  });

  it("removes only its own token and asks the composer to fork", () => {
    const [item] = forkItems({ offersFork: true });
    if (!item) throw new Error("expected /fork");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/fo keep this",
        trigger: { rangeStart: 0, rangeEnd: 3 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: " keep this", cursor: 0, interactionMode: null, fork: true });
  });

  it("catches a typed standalone /fork in any existing thread, whatever is attached", () => {
    // Availability is not an input: an unforkable thread explains why instead of sending the text.
    const intercept = (text: string, attachmentCount = 0, inThread = true) =>
      resolveComposerSendIntercept({ text, attachmentCount, usageLimitsOffered: true, inThread });
    expect(intercept(" /fork ")).toBe("fork");
    expect(intercept("/FORK", 2)).toBe("fork");
    expect(intercept("/fork", 0, false)).toBeNull();
    expect(intercept("/fork this please")).toBeNull();
    expect(intercept("/usage-limits")).toBe("usage-limits");
    expect(intercept("/usage-limits", 1)).toBeNull();
    expect(intercept("hello")).toBeNull();
  });
});
