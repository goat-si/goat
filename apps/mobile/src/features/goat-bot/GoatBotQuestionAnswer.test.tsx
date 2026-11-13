import {
  buildGoatBotTimeline,
  goatBotItemReaders,
  type GoatBotPendingInput,
} from "@goat/client-runtime/goatBot";
import {
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

// Event lines resolve their routine or task against the home's reads, which this test does not load.
// Chat file cards read the Library through the environment runtime; GoatBotTimelineRow.files.test covers them.
// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("./GoatBotReplyFiles", () => ({
  GoatBotFilesProvider: (props: { children?: unknown }) => props.children,
  GoatBotReplyFiles: () => null,
}));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
vi.mock("./GoatBotFace", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotHeaderFace: () => null,
    GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
      <Text>{`face:${props.state}:${props.inView}|`}</Text>
    ),
  };
});
vi.mock("./GoatBotShimmerText", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotShimmerText: (props: { label: string; animate: boolean }) => (
      <Text>{`shimmer:${props.label}:${props.animate}`}</Text>
    ),
  };
});
// The native Markdown renderer cannot load under Vitest; its source text stands in for it.
vi.mock("./GoatBotMarkdown", async () => {
  const { Text } = await import("react-native");
  return { GoatBotMarkdown: (props: { text: string }) => <Text>{`md[${props.text}]`}</Text> };
});
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
// The chat's step reader and file opener load the environment runtime.
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("./openBotLibraryFile", () => ({ openBotLibraryFile: async () => null }));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: clipboard.copy }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";

// Rows come from the shared timeline with answer references on, as the session builds them, and
// the real readers over the channel metadata the server stores.
const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = (second: number) => "2026-10-12T12:00:" + String(second).padStart(2, "0") + ".000Z";
const meta = { conversationId: "conv-1", originKind: "goat" };
const item = (raw: Record<string, unknown>) =>
  decode({
    threadId: "thread-bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: raw.at,
    completedAt: raw.at,
    updatedAt: raw.at,
    ...raw,
  });
const card = (open: ReadonlyArray<string>, answered?: ReadonlyArray<object>) =>
  item({
    id: "card-" + open.length + "-" + (answered?.length ?? 0),
    at: at(0),
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Task updated",
    ledgerTask: {
      taskId: "task-1",
      kind: "work",
      conversationId: "conv-1",
      taskVersion: 2,
      title: "Build",
      status: open.length > 0 ? "waiting_input" : "running",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at(0),
      updatedAt: at(0),
      openQuestionCount: open.length,
      openQuestionIds: open,
      ...(answered === undefined ? {} : { answeredQuestions: answered }),
    },
  });
const question = item({
  id: "b1",
  at: at(1),
  type: "assistant_message",
  messageId: "m-b1",
  text: "Which cache should the build use?",
  streaming: false,
  channel: {
    ...meta,
    kind: "question",
    taskId: "task-1",
    questionId: "q1",
    questionKind: "task",
    options: ["Keep", "Clear"],
  },
});
const person = (text: string, answersQuestionId: string | null) =>
  item({
    id: "u1",
    at: at(2),
    type: "user_message",
    messageId: "m-u1",
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "mobile",
    channel: {
      ...meta,
      kind: "inbound",
      inputId: "in-u1",
      clientMessageId: "c-u1",
      taskId: "task-1",
      answersQuestionId,
    },
  });
const refusal = item({
  id: "b2",
  at: at(3),
  type: "assistant_message",
  messageId: "m-b2",
  text: "That question was already answered.",
  streaming: false,
  channel: { ...meta, kind: "reply", inReplyToInputId: "in-u1" },
});
const sending = (text: string, state: GoatBotPendingInput["state"]): GoatBotPendingInput => ({
  clientKey: "k",
  text,
  createdAt: at(2),
  state,
  requestKey: null,
  taskId: "task-1",
  questionId: "q1",
});

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});

async function chat(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  pending: GoatBotPendingInput[] = [],
  onSend: (answer: string, taskId?: string, questionId?: string) => boolean = () => true,
) {
  const rows = buildGoatBotTimeline({
    visibleTurnItems: items.map((each, position) => ({
      position,
      visibility: "local",
      sourceThreadId: ThreadId.make("thread-bot"),
      sourceItemId: each.id,
      item: each,
    })),
    pendingInputs: pending,
    readers: goatBotItemReaders,
    taskId: null,
    knownTaskIds: ["task-1"],
    conversationOnly: true,
    answerReferences: true,
  }).filter((row) => row.kind !== "day" && row.kind !== "task");
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <>
      {rows.map((row) => (
        <GoatBotTimelineRow
          key={row.id}
          row={row}
          canSend
          onSend={onSend}
          onRetry={() => {}}
          onSelectThread={() => {}}
        />
      ))}
    </>,
  );
  await view.render();
  return {
    text: view.container.textContent ?? "",
    choices: [...view.container.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label !== null && /^[A-Z]\. |^Something else$/.test(label)),
  };
}

describe("a task question's answer is what the server recorded", () => {
  it("sends a picked choice with its task and question", async () => {
    const onSend = vi.fn(() => true);
    await chat([card(["q1"]), question], [], onSend);
    await view.click("B. Clear");
    expect(onSend).toHaveBeenCalledWith("Clear", "task-1", "q1");
  });

  it("folds an accepted pick into the question as the chosen row", async () => {
    const { text, choices } = await chat([
      card([], [{ questionId: "q1", inputId: "in-u1" }]),
      question,
      person("Clear", "q1"),
    ]);
    expect(text).toContain("Which cache should the build use?");
    expect(text).toContain("BClear");
    expect(choices).toEqual([]);
  });

  it("keeps an accepted typed answer as the person's message under the closed question", async () => {
    const { text, choices } = await chat([
      card([], [{ questionId: "q1", inputId: "in-u1" }]),
      question,
      person("Use the staging cache", "q1"),
    ]);
    expect(text).toContain("Which cache should the build use?");
    expect(text.match(/Use the staging cache/g)).toHaveLength(1);
    expect(choices).toEqual([]);
  });

  it("shows a pick on its way as sending, and keeps the choices when it failed", async () => {
    const on = await chat([card(["q1"]), question], [sending("Keep", "sending")]);
    expect(on.text).toContain("AKeepSending…");
    expect(on.choices).toEqual([]);
    await view.unmount();
    h.dispose();
    const failed = await chat([card(["q1"]), question], [sending("Keep", "failed")]);
    expect(failed.choices).toEqual(["A. Keep", "B. Clear", "Something else"]);
  });

  it("keeps a refused answer as the person's plain message, with the bot's refusal", async () => {
    const { text, choices } = await chat([
      card(["q1"]),
      question,
      person("Use the staging cache", null),
      refusal,
    ]);
    expect(text).toContain("Use the staging cache");
    expect(text).toContain("That question was already answered.");
    // The task still asks, so its choices stay.
    expect(choices).toEqual(["A. Keep", "B. Clear", "Something else"]);
  });
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
