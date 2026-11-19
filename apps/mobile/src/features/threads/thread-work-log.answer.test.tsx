import { RuntimeRequestId, type OrchestrationV2TurnItem } from "@goat/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
} from "../../testing/memoryNativeHarness";
import { base, projected } from "../../lib/threadActivity.testkit";
import { buildThreadFeed } from "../../lib/threadActivity";
import { deriveThreadWorkLogSizing } from "../../lib/layout";

vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => ({}) };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
    ReduceMotion: { System: 0 },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value, set: () => {} }),
    withTiming: (value: number) => value,
  };
});
vi.mock("./thread-subagent-group", () => ({ ThreadSubagentGroup: () => null }));
vi.mock("./ProposedPlanCard", () => ({ ProposedPlanCard: () => null }));
vi.mock("./FileChangeInlineDiff", () => ({ FileChangeInlineDiff: () => null }));
vi.mock("./BrowserAppIcon", () => ({ BrowserAppIcon: () => null }));
vi.mock("./ReplCodeText", () => ({ ReplCodeText: () => null, commandCodeText: () => "" }));
vi.mock("./threadComputerUseEntry", () => ({ threadComputerUseEntry: () => null }));
vi.mock("../pull-requests/PullRequestPresentation", () => ({ PullRequestDiffStats: () => null }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => true,
}));
vi.mock("./work-shimmer-arbiter", () => ({ useWorkShimmerTurn: () => false }));
vi.mock("./work-log-layout", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    EXPANDABLE_ROW_MIN_HEIGHT: 44,
    WorkLogLabel: Container,
    WorkLogBlock: Container,
    WorkLogRows: Container,
    WorkLogIconSlot: Container,
    WorkLogPressable: Container,
  };
});
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {}, threadEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("../cloud/dpop", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("expo", () => ({
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: {}, executionEnvironment: "storeClient" },
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@expo/ui/community/masked-view", () => ({
  MaskedView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("./thread-command-output", () => ({
  ThreadCommandOutput: () => null,
  useCommandOutputStreaming: () => false,
}));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: () => ({ data: null, error: null }) }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => () => {} }));
vi.mock("./QuestionAnswerHistory", () => ({ QuestionAnswerHistory: () => <span>ANSWERED</span> }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ThreadMarkdownImage", () => ({ ThreadMarkdownImage: () => null }));
vi.mock("../../components/FilePreviewGallery", () => ({ FilePreviewGallery: () => null }));
import { ThreadWorkLog } from "./thread-work-log";

it("shows a structured answer without repeating raw question JSON", async () => {
  const requestId = RuntimeRequestId.make("question");
  const item: OrchestrationV2TurnItem = {
    ...base("question", "2026-06-20T00:00:01.000Z", 0),
    type: "user_input_request",
    requestId,
    questions: [],
    questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
  };
  const group = buildThreadFeed([projected(item, 0)])[0];
  if (!group || group.type !== "activity-group") throw new Error("Missing activity");
  const row = group.activities[0];
  if (!row) throw new Error("Missing activity row");
  const h = createNativeMemoryHarness();
  const view = renderNative(
    h,
    <ThreadWorkLog
      activities={[row]}
      anchorKey="a"
      environmentId={nativeEnv}
      copiedRowId={null}
      expandedRows={{ [row.id]: true }}
      rowSizing={deriveThreadWorkLogSizing({ baseFontSize: 14, fontScale: 1 })}
      scrollPositions={new Map()}
      iconSubtleColor="#777"
      edgeFadeColor="#fff"
      themeAppearance="light"
      onCopyRow={() => {}}
      onToggleRow={() => {}}
      renderImage={() => null}
      renderReasoning={() => null}
      onPressPreview={() => {}}
    />,
  );
  try {
    await view.render();
    expect(view.container.textContent).toContain("ANSWERED");
    expect(view.container.textContent).not.toContain('"questionAnswer"');
  } finally {
    await view.unmount();
    h.dispose();
  }
});
