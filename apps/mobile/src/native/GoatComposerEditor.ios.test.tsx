import { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import type { ComposerContextId } from "@goat/contracts";

interface Selection {
  readonly start: number;
  readonly end: number;
}
interface NativeEvent {
  readonly value: string;
  readonly selection: Selection;
  readonly eventCount: number;
}
interface Document {
  readonly value: string;
  readonly selection: Selection | null;
  readonly tokensJson: string;
  readonly mostRecentEventCount: number;
  readonly isNativeEcho: boolean;
}

// Mirrors GoatComposerEditorView.swift: it keeps its own text, rejects stale payloads and
// records every programmatic write, since each one resets the iOS Korean keyboard.
const native = vi.hoisted(() => ({
  value: "",
  selection: { start: 0, end: 0 },
  eventCount: 0,
  tokensJson: "[]",
  writes: [] as string[],
  onChange: null as ((event: { nativeEvent: NativeEvent }) => void) | null,
  onSelection: null as ((event: { nativeEvent: NativeEvent }) => void) | null,
}));

function FakeNativeComposer(props: {
  readonly controlledDocumentJson: string;
  readonly onComposerChange: (event: { nativeEvent: NativeEvent }) => void;
  readonly onComposerSelectionChange: (event: { nativeEvent: NativeEvent }) => void;
}) {
  useLayoutEffect(() => {
    native.onChange = props.onComposerChange;
    native.onSelection = props.onComposerSelectionChange;
  });
  useLayoutEffect(() => {
    const document = JSON.parse(props.controlledDocumentJson) as Document;
    if (document.mostRecentEventCount < native.eventCount) return;
    if (document.isNativeEcho && document.value !== native.value) return;
    const tokensChanged = document.tokensJson !== native.tokensJson;
    native.tokensJson = document.tokensJson;
    if (tokensChanged || document.value !== native.value) {
      native.writes.push("text:" + document.value);
      native.value = document.value;
    }
    const selection = document.selection;
    if (
      selection &&
      (selection.start !== native.selection.start || selection.end !== native.selection.end)
    ) {
      native.writes.push("selection:" + selection.start + "-" + selection.end);
      native.selection = selection;
    }
  }, [props.controlledDocumentJson]);
  return null;
}

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
vi.mock("expo", () => ({
  requireNativeView: () => FakeNativeComposer,
  requireNativeModule: vi.fn(),
  requireOptionalNativeModule: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => new Uint8Array(length),
  digest: async () => new Uint8Array(32),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK: "afterFirstUnlock" }));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-modules-core", () => ({
  EventEmitter: class {
    readonly native = true;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));
vi.mock("../state/queries", () => ({}));
vi.mock("../state/use-composer-drafts", () => ({}));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../lib/nativeComposerTheme", () => ({
  createNativeComposerTheme: () => ({ text: "#000000", placeholder: "#888888" }),
}));
vi.mock("../lib/contextChipIconSource", () => ({ contextChipIconUri: () => null }));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));

import { ComposerEditor } from "./GoatComposerEditor.ios";
import {
  rememberComposerDraftSelection,
  useComposerDraftSelection,
} from "../state/composerDraftSelection";
import { resolveComposerMenuSelection } from "../features/threads/use-composer-command-menu";

function nativeEdit(value: string) {
  native.value = value;
  native.selection = { start: value.length, end: value.length };
  native.eventCount += 1;
  return { value, selection: native.selection, eventCount: native.eventCount };
}

// Each keystroke: the iOS Korean keyboard deletes the composing syllable, then inserts the next.
const KEYSTROKES: ReadonlyArray<ReadonlyArray<string>> = [
  ["ㅇ"],
  ["", "오"],
  ["", "옥"],
  ["", "오기"],
  ["오기 "],
  ["오기 ㅈ"],
  ["오기 ", "오기 저"],
  ["오기 ", "오기 전"],
];

const DRAFT_KEY = "draft:korean";
const IMAGE_CONTEXT = {
  version: 1 as const,
  records: [
    {
      version: 1 as const,
      kind: "image" as const,
      contextId: "att-1" as ComposerContextId,
      label: "IMG_0001.jpg",
      attachmentId: "att-1",
      name: "IMG_0001.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    },
  ],
};

const draft = { text: "" };

function Host({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  const [local, setLocal] = useState({ ownerKey: DRAFT_KEY, start: 0, end: 0 });
  const inserted = useComposerDraftSelection(DRAFT_KEY, value);
  const selection = resolveComposerMenuSelection({
    draftMessage: value,
    ownerKey: DRAFT_KEY,
    inserted,
    local,
  });
  return (
    <ComposerEditor
      value={value}
      selection={selection}
      context={IMAGE_CONTEXT}
      onChangeText={(next) => {
        draft.text = next;
        setValue(next);
      }}
      onSelectionChange={(next) => {
        // ComposerEditor remembers each caret against the draft store's text, as here.
        rememberComposerDraftSelection(DRAFT_KEY, draft.text, next);
        setLocal({ ownerKey: DRAFT_KEY, ...next });
      }}
    />
  );
}

async function typeKorean(prefix: string, batched: boolean, caretEvents = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.value = prefix;
  native.selection = { start: prefix.length, end: prefix.length };
  native.eventCount = 0;
  native.tokensJson = "[]";
  // Attaching a photo inserts its chip and remembers the caret after it.
  draft.text = prefix;
  rememberComposerDraftSelection(DRAFT_KEY, prefix, { start: prefix.length, end: prefix.length });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Host initial={prefix} />));
  native.writes = [];
  for (const keystroke of KEYSTROKES) {
    const events = keystroke.flatMap((value) => {
      const edit = { kind: "change" as const, ...nativeEdit(prefix + value) };
      if (!caretEvents) return [edit];
      native.eventCount += 1;
      return [edit, { ...edit, kind: "selection" as const, eventCount: native.eventCount }];
    });
    const deliver = (event: (typeof events)[number]) =>
      (event.kind === "change" ? native.onChange : native.onSelection)?.({ nativeEvent: event });
    if (batched) {
      await act(async () => {
        for (const event of events) deliver(event);
      });
    } else {
      for (const event of events) {
        await act(async () => deliver(event));
      }
    }
  }
  const result = { value: native.value, writes: native.writes };
  await act(async () => root.unmount());
  return result;
}

const CHIP = formatComposerContextReference({
  kind: "image",
  contextId: "att-1" as ComposerContextId,
  label: "IMG_0001.jpg",
});

const DELIVERIES = [
  { delivery: "batched", batched: true, caretEvents: false },
  { delivery: "one render per event", batched: false, caretEvents: false },
  { delivery: "batched, caret events", batched: true, caretEvents: true },
  { delivery: "one render per event, caret events", batched: false, caretEvents: true },
];

it.each(DELIVERIES)(
  "Korean composition gets no programmatic writes in plain text ($delivery)",
  async ({ batched, caretEvents }) => {
    expect(await typeKorean("", batched, caretEvents)).toEqual({ value: "오기 전", writes: [] });
  },
);

it.each(DELIVERIES)(
  "Korean composition gets no programmatic writes after a leading image chip ($delivery)",
  async ({ batched, caretEvents }) => {
    expect(await typeKorean(CHIP + " ", batched, caretEvents)).toEqual({
      value: CHIP + " 오기 전",
      writes: [],
    });
  },
);
