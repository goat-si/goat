import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import type { ThreadUserInputQuestion } from "@goat/client-runtime/state/thread-requests";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  RuntimeRequestId,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect, useState, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Snapshot = {
  items: readonly DecisionItem[];
  authoritativeRefs: readonly ScopedThreadRef[];
  loadingRefs: readonly ScopedThreadRef[];
  errors: readonly { ref: ScopedThreadRef; message: string }[];
  isLoading: boolean;
};
type Run = (...args: unknown[]) => Promise<AtomCommandResult<void, Error>>;
const fixture = vi.hoisted<{
  raw: Atom.Writable<Snapshot> | null;
  summary: Atom.Writable<{ count: number; refs: readonly ScopedThreadRef[] }> | null;
  items: Atom.Atom<Snapshot> | null;
  registry: AtomRegistry.AtomRegistry | null;
  evaluations: number;
  detailEvaluations: number;
  activeItems: number;
  activeDetails: number;
  focused: boolean;
  allowed: Set<EnvironmentId>;
  approval: ReturnType<typeof vi.fn<Run>>;
  userInput: ReturnType<typeof vi.fn<Run>>;
  producers: Map<string, Atom.Atom<number>>;
  producerEvaluations: Map<string, number>;
  os: string;
  threads: EnvironmentThreadShell[];
  projects: EnvironmentProject[];
  selectedEnvironmentId: EnvironmentId | null;
  selectedProjectKey: string | null;
  searchQuery: string;
  navigate: (name: string, ref?: ScopedThreadRef) => void;
  back: () => void;
  canGoBack: boolean;
}>(() => ({
  raw: null,
  summary: null,
  items: null,
  registry: null,
  evaluations: 0,
  detailEvaluations: 0,
  activeItems: 0,
  activeDetails: 0,
  focused: true,
  allowed: new Set(),
  approval: vi.fn(),
  userInput: vi.fn(),
  producers: new Map(),
  producerEvaluations: new Map(),
  os: "ios",
  threads: [],
  projects: [],
  selectedEnvironmentId: null,
  selectedProjectKey: null,
  searchQuery: "",
  navigate: () => {},
  back: () => {},
  canGoBack: true,
}));

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  fixture.raw = Atom.make<Snapshot>({
    items: [],
    authoritativeRefs: [],
    loadingRefs: [],
    errors: [],
    isLoading: false,
  }).pipe(Atom.keepAlive);
  fixture.summary = Atom.make<{ count: number; refs: readonly ScopedThreadRef[] }>({
    count: 0,
    refs: [],
  }).pipe(Atom.keepAlive);
  function stateAtom(environmentId: EnvironmentId, threadId: ThreadId) {
    const key = JSON.stringify([environmentId, threadId]);
    let atom = fixture.producers.get(key);
    if (!atom) {
      atom = Atom.make(() => {
        fixture.producerEvaluations.set(key, (fixture.producerEvaluations.get(key) ?? 0) + 1);
        return 0;
      }).pipe(Atom.setIdleTTL(0));
      fixture.producers.set(key, atom);
    }
    return atom;
  }
  const detail = Atom.make((get) => {
    fixture.detailEvaluations++;
    fixture.activeDetails++;
    get.addFinalizer(() => fixture.activeDetails--);
    const state = get(fixture.raw!);
    const refs = [
      ...state.items.map((item) => item.ref),
      ...state.loadingRefs,
      ...state.errors.map((entry) => entry.ref),
    ];
    for (const ref of refs) get(stateAtom(ref.environmentId, ref.threadId));
    return state;
  }).pipe(Atom.setIdleTTL(0));
  fixture.items = Atom.make((get) => {
    fixture.evaluations++;
    fixture.activeItems++;
    get.addFinalizer(() => fixture.activeItems--);
    return get(detail);
  }).pipe(Atom.setIdleTTL(0));
  return {
    decisionInbox: { itemsAtom: fixture.items, summaryAtom: fixture.summary },
    threadEnvironment: { respondToApproval: "approval", respondToUserInput: "userInput" },
    environmentThreads: { stateAtom },
  };
});
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (id: EnvironmentId | null) => id !== null && fixture.allowed.has(id),
  readEnvironmentScope: (id: EnvironmentId) => fixture.allowed.has(id),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "approval" ? fixture.approval : fixture.userInput,
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => {
    throw new Error("Inbox must not read selection");
  },
}));

// Interactive native host adapters preserve the real cards, body and list branches.
type HostProps = {
  children?: ReactNode;
  onPress?: () => void;
  onChangeText?: (value: string) => void;
  disabled?: boolean;
  editable?: boolean;
  value?: string;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  accessibilityElementsHidden?: boolean;
};
function Box(props: HostProps) {
  return (
    <div data-testid={props.testID} hidden={props.accessibilityElementsHidden}>
      {props.children}
    </div>
  );
}
function TextHost(props: HostProps) {
  return <span>{props.children}</span>;
}
function PressHost(props: HostProps) {
  return (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children ?? props.label}
    </button>
  );
}
function InputHost(props: HostProps) {
  return (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value ?? ""}
      disabled={props.editable === false || props.disabled}
      onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
    />
  );
}
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: Box,
  Text: TextHost,
  Pressable: PressHost,
  ScrollView: Box,
  TextInput: InputHost,
  ActivityIndicator: () => null,
  Platform: {
    get OS() {
      return fixture.os;
    },
    isPad: true,
    select: (values: Record<string, unknown>) => values[fixture.os] ?? values.default,
  },
  StyleSheet: { create: <A,>(value: A) => value, hairlineWidth: 1, absoluteFillObject: {} },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: TextHost, AppTextInput: InputHost }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { title: string; onBack: () => void }) => (
    <header>
      <button onClick={props.onBack}>Back</button>
      {props.title}
    </header>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: Box }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => fixture.focused,
  useNavigation: () => ({
    isFocused: () => fixture.focused,
    canGoBack: () => fixture.canGoBack,
    goBack: () => fixture.back(),
    navigate: (name: string, ref?: ScopedThreadRef) => fixture.navigate(name, ref),
  }),
  useFocusEffect: () => {},
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref ? { title: `Thread ${ref.threadId}` } : null,
  useNavigationThreadShells: () => fixture.threads,
  useProjects: () => fixture.projects,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnection: (id: EnvironmentId | null) =>
    id ? { environmentLabel: `Environment ${id}` } : null,
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: Box },
  Easing: { out: (value: unknown) => value, cubic: "cubic" },
  FadeInUp: { duration: () => ({ easing: () => undefined }) },
  FadeOutDown: { duration: () => ({ easing: () => undefined }) },
  LinearTransition: { duration: () => undefined },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: PressHost,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Box }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Box }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { readonly markdown: string }) => (
    <TextHost>{props.markdown}</TextHost>
  ),
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => () => {},
  useNavigateToPullRequest: () => () => {},
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../threads/QuestionAttachments", () => ({
  QuestionAttachments: (props: HostProps & { question: ThreadUserInputQuestion }) => (
    <InputHost {...props} accessibilityLabel={props.question.question} />
  ),
}));

import { useDecisionInbox, useDecisionInboxSessionState } from "./useDecisionInbox";
import { DecisionsRouteScreen } from "./DecisionsRouteScreen";
import { PendingUserInputBody } from "../threads/PendingUserInputBody";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
} from "../../lib/threadActivity";
import { makeThreadShellFixture } from "../../test-fixtures";

const envA = EnvironmentId.make("A");
const envB = EnvironmentId.make("B");
const requestId = RuntimeRequestId.make("same-request");
const question: ThreadUserInputQuestion = {
  id: "q",
  header: "Choice",
  question: "Choose an answer",
  multiSelect: true,
  allowCustomAnswer: true,
  options: [
    { value: "one", label: "One", description: "First" },
    { value: "two", label: "Two", description: "Second" },
  ],
};
function approval(
  environmentId = envA,
  threadId = ThreadId.make("thread"),
  date = "2026-10-01T00:00:00.000Z",
): Extract<DecisionItem, { kind: "approval" }> {
  return {
    id: JSON.stringify([environmentId, threadId, requestId]),
    ref: { environmentId, threadId },
    createdAt: date,
    kind: "approval",
    request: { requestId, createdAt: date, requestKind: "command", responseCapability: "live" },
  };
}
function userInput(
  environmentId = envA,
  questions: readonly ThreadUserInputQuestion[] = [question],
  threadId = ThreadId.make("thread"),
): Extract<DecisionItem, { kind: "user_input" }> {
  const base = approval(
    environmentId,
    threadId,
    environmentId === envA ? "2026-10-01T00:00:00.000Z" : "2026-10-02T00:00:00.000Z",
  );
  return {
    ...base,
    kind: "user_input",
    request: {
      requestId,
      createdAt: base.createdAt,
      questions,
      dismissible: true,
      responseCapability: "message",
    },
  };
}
const a = approval();
const b = approval(envB, ThreadId.make("thread"), "2026-10-02T00:00:00.000Z");
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useDecisionInbox> | undefined;
let session: ReturnType<typeof useDecisionInboxSessionState> | undefined;
function inbox() {
  if (!latest) throw new Error("Inbox not mounted");
  return latest;
}
function Child(props: { session: ReturnType<typeof useDecisionInboxSessionState>; body: boolean }) {
  const value = useDecisionInbox(props.session, () => fixture.focused);
  useLayoutEffect(() => {
    latest = value;
  });
  const request = value.current?.kind === "user_input" ? value.current.request : null;
  return props.body && request ? (
    <>
      <PendingUserInputBody
        pendingUserInput={request}
        drafts={value.drafts}
        respondingUserInputId={null}
        onSelectOption={value.onSelectOption}
        renderCustomAnswer={(q, draft, disabled) => (
          <InputHost
            accessibilityLabel={q.question}
            value={draft?.customAnswer}
            disabled={disabled}
            onChangeText={(text) => value.onChangeCustomAnswer(request.requestId, q.id, text)}
          />
        )}
      />
      <button onClick={() => void value.onSubmit()}>Submit</button>
    </>
  ) : null;
}
function Probe(props: { body?: boolean }) {
  const value = useDecisionInboxSessionState();
  useLayoutEffect(() => {
    session = value;
  });
  return fixture.focused ? <Child session={value} body={props.body ?? false} /> : null;
}
function write(items: readonly DecisionItem[], diagnostics: Partial<Omit<Snapshot, "items">> = {}) {
  const unresolved = [
    ...(diagnostics.loadingRefs ?? []),
    ...(diagnostics.errors ?? []).map(({ ref }) => ref),
  ];
  registry.set(fixture.raw!, {
    items,
    authoritativeRefs: [a.ref, b.ref, ...items.map((item) => item.ref)].filter(
      (ref) =>
        !unresolved.some(
          (other) => other.environmentId === ref.environmentId && other.threadId === ref.threadId,
        ),
    ),
    loadingRefs: [],
    errors: [],
    isLoading: false,
    ...diagnostics,
  });
}
async function render(node: ReactNode) {
  await act(async () =>
    root.render(<RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>),
  );
}
async function mount(items: readonly DecisionItem[] = [a, b], node: ReactNode = <Probe />) {
  write(items);
  await render(node);
}
function deferred() {
  let finish: (result: AtomCommandResult<void, Error>) => void = () => {
    throw new Error("Missing resolver");
  };
  let reject: (reason: Error) => void = () => {
    throw new Error("Missing rejector");
  };
  const promise = new Promise<AtomCommandResult<void, Error>>((resolve, rejectPromise) => {
    finish = resolve;
    reject = rejectPromise;
  });
  return { promise, finish, reject };
}
function button(label: string) {
  const value = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(label: string, text: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  fixture.registry = registry;
  fixture.focused = true;
  fixture.os = "ios";
  fixture.canGoBack = true;
  fixture.allowed.clear();
  fixture.allowed.add(envA);
  fixture.allowed.add(envB);
  fixture.approval.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixture.userInput.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixture.evaluations = 0;
  fixture.detailEvaluations = 0;
  fixture.activeItems = 0;
  fixture.activeDetails = 0;
  fixture.producers.clear();
  fixture.producerEvaluations.clear();
  fixture.threads = [];
  fixture.projects = [];
  fixture.selectedEnvironmentId = null;
  fixture.selectedProjectKey = null;
  fixture.searchQuery = "";
  fixture.navigate = () => {};
  fixture.back = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  latest = undefined;
  session = undefined;
  vi.unstubAllGlobals();
});

it("holds a synchronous double-tap lock through receipt until projection removal", async () => {
  const receipt = deferred();
  fixture.approval.mockReturnValueOnce(receipt.promise);
  await mount();
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = inbox().onRespond(requestId, "accept");
    void inbox().onRespond(requestId, "accept");
  });
  expect(fixture.approval).toHaveBeenCalledTimes(1);
  expect(inbox().responding).toBe(true);
  await act(async () => {
    receipt.finish(AsyncResult.success(undefined));
    await pending;
  });
  expect(inbox().current?.id).toBe(a.id);
  expect(inbox().responding).toBe(true);
  await act(async () => write([b]));
  expect(inbox().current?.id).toBe(b.id);
  expect(inbox().responding).toBe(false);
});

it("keeps distinct drafts and sends the full destination when request IDs collide", async () => {
  const qa = userInput();
  const qb = userInput(envB);
  const qc = {
    ...userInput(envB, [question], ThreadId.make("second")),
    createdAt: "2026-10-03T00:00:00.000Z",
  };
  await mount([qc, qb, qa]);
  expect(inbox().current?.id).toBe(qa.id);
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "q", "A answer");
    inbox().skip();
  });
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "B answer"));
  await act(async () => inbox().onSubmit());
  expect(fixture.userInput).toHaveBeenCalledWith({
    environmentId: envB,
    input: { threadId: qb.ref.threadId, requestId, answers: { q: "B answer" } },
  });
  expect(session?.draftsById[qa.id]?.q?.customAnswer).toBe("A answer");
  expect(session?.draftsById[qb.id]?.q?.customAnswer).toBe("B answer");
  expect(session?.draftsById[qc.id]).toBeUndefined();
});

it("waits for initial loading then corrects two flagged threads to three requests", async () => {
  write([], { loadingRefs: [a.ref, b.ref], isLoading: true });
  await render(<Probe />);
  expect(inbox().current).toBeNull();
  const third = approval(envA, ThreadId.make("second"));
  await act(async () => write([b, third, a]));
  expect(inbox().queue).toHaveLength(3);
  expect(inbox().position).toBe(1);
});

it("waits for staggered initial responses and selects the oldest decision", async () => {
  write([b], { loadingRefs: [a.ref], isLoading: true });
  await render(<Probe />);
  expect(inbox().current).toBeNull();
  expect(session?.selected).toBeNull();
  await act(async () => write([b, a]));
  expect(inbox().current?.id).toBe(a.id);
  expect(inbox().position).toBe(1);
});

it("keeps drafts and skip positions through disconnect, other skips and reconnect", async () => {
  const qa = userInput();
  const qb = userInput(envB);
  const qc = {
    ...userInput(envB, [question], ThreadId.make("second")),
    createdAt: "2026-10-03T00:00:00.000Z",
  };
  await mount([qa, qb, qc]);
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "q", "Keep across disconnect");
    inbox().skip();
  });
  await act(async () => write([qb, qc], { authoritativeRefs: [qb.ref, qc.ref] }));
  expect(session?.draftsById[qa.id]?.q?.customAnswer).toBe("Keep across disconnect");
  await act(async () => inbox().skip());
  await act(async () => write([qa, qb, qc]));
  expect(inbox().queue.map((entry) => entry.id)).toEqual([qc.id, qa.id, qb.id]);
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(qa.id);
  expect(inbox().drafts.q?.customAnswer).toBe("Keep across disconnect");
  await act(async () => write([qb, qc]));
  expect(session?.draftsById[qa.id]).toBeUndefined();
  expect(session?.skippedIds).not.toContain(qa.id);
});

it("keeps the receipt lock through disconnect and reconnect until live removal", async () => {
  await mount([a]);
  await act(async () => inbox().onRespond(requestId, "accept"));
  await act(async () => write([], { authoritativeRefs: [] }));
  expect(session?.busyById[a.id]).toBe(true);
  expect(session?.inFlight.current.has(a.id)).toBe(true);
  await act(async () => write([a]));
  expect(inbox().responding).toBe(true);
  await act(async () => inbox().onRespond(requestId, "accept"));
  expect(fixture.approval).toHaveBeenCalledTimes(1);
  await act(async () => write([]));
  expect(session?.busyById[a.id]).toBeUndefined();
  expect(session?.inFlight.current.has(a.id)).toBe(false);
});

it("pins the draft and disables replies through its own reload or error", async () => {
  const qa = userInput();
  await mount([qa, b]);
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "Keep me"));
  await act(async () => write([b], { loadingRefs: [qa.ref], isLoading: true }));
  expect(inbox().current?.id).toBe(qa.id);
  expect(inbox().paused).toBe(true);
  await act(async () => inbox().onSubmit());
  expect(fixture.userInput).not.toHaveBeenCalled();
  await act(async () => write([b], { errors: [{ ref: qa.ref, message: "Disconnected" }] }));
  expect(inbox().drafts.q?.customAnswer).toBe("Keep me");
  await act(async () => write([qa, b]));
  expect(inbox().paused).toBe(false);
  expect(inbox().drafts.q?.customAnswer).toBe("Keep me");
});

it.each(["failure", "throw"])(
  "retains drafts after %s and retries until projection removal",
  async (mode) => {
    const qa = userInput();
    if (mode === "failure")
      fixture.userInput.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Offline"))),
      );
    else fixture.userInput.mockRejectedValueOnce(new Error("Offline"));
    await mount([qa, b]);
    await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "Retained"));
    await act(async () => inbox().onSubmit());
    expect(inbox().error).toContain("Offline");
    expect(inbox().responding).toBe(false);
    expect(inbox().drafts.q?.customAnswer).toBe("Retained");
    await act(async () => inbox().onSubmit());
    expect(inbox().responding).toBe(true);
    expect(inbox().current?.id).toBe(qa.id);
    await act(async () => write([b]));
    expect(inbox().current?.id).toBe(b.id);
  },
);

it("ignores late failures after another device removed the submitting request", async () => {
  const receipt = deferred();
  fixture.approval.mockReturnValueOnce(receipt.promise);
  await mount();
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = inbox().onRespond(requestId, "accept");
  });
  await act(async () => write([b]));
  fixture.approval.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("B failed"))));
  await act(async () => inbox().onRespond(requestId, "decline"));
  await act(async () => {
    receipt.finish(AsyncResult.failure(Cause.fail(new Error("Late A"))));
    await pending;
  });
  expect(inbox().current?.id).toBe(b.id);
  expect(inbox().error).toContain("B failed");
  expect(session?.errorsById[a.id]).toBeUndefined();
});

it("rechecks the destination grant immediately before a retained callback", async () => {
  await mount([b, a]);
  await act(async () => inbox().skip());
  const respond = inbox().onRespond;
  fixture.allowed.delete(envB);
  await act(async () => respond(requestId, "accept"));
  expect(fixture.approval).not.toHaveBeenCalled();
  expect(inbox().error).toContain("no longer available");
  await render(<Probe />);
  expect(inbox().canOperateThread).toBe(false);
  fixture.allowed.add(envB);
  await render(<Probe />);
  await act(async () => inbox().onRespond(requestId, "accept"));
  expect(fixture.approval.mock.calls[0]?.[0]).toMatchObject({ environmentId: envB });
});

it("rejects disconnected destinations, nonresumable requests and obsolete approval choices", async () => {
  await mount();
  const respond = inbox().onRespond;
  await act(async () => {
    write([b]);
    await respond(requestId, "accept");
  });
  expect(fixture.approval).not.toHaveBeenCalled();
  const unavailable: typeof a = {
    ...a,
    request: { ...a.request, responseCapability: "not_resumable" },
  };
  await act(async () => write([unavailable]));
  await act(async () => inbox().onRespond(requestId, "accept"));
  expect(fixture.approval).not.toHaveBeenCalled();
  const custom: typeof a = {
    ...a,
    request: { ...a.request, options: [{ decision: "acceptAlways", label: "Allow tool" }] },
  };
  await act(async () => write([custom]));
  await act(async () => inbox().onRespond(requestId, "decline"));
  expect(fixture.approval).not.toHaveBeenCalled();
  await act(async () => inbox().onRespond(requestId, "acceptAlways"));
  expect(fixture.approval.mock.calls[0]?.[0]).toMatchObject({
    input: { decision: "acceptAlways" },
  });
});

it("cycles skips locally, restores drafts and prunes removed skipped IDs", async () => {
  const qa = userInput();
  const qb = userInput(envB);
  await mount([qb, qa]);
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "q", "Saved");
    inbox().skip();
  });
  expect(inbox().current?.id).toBe(qb.id);
  await act(async () => inbox().skip());
  expect(inbox().drafts.q?.customAnswer).toBe("Saved");
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(qb.id);
  await act(async () => write([qb]));
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(qb.id);
  expect(session?.skippedIds).toEqual([qb.id]);
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(fixture.approval).not.toHaveBeenCalled();
});

it("seeds once, preserves explicit clearing and builds multiselect/custom answers", async () => {
  const seeded = userInput(envA, [{ ...question, initialAnswer: "Initial" }]);
  await mount([seeded, b]);
  expect(inbox().drafts.q?.customAnswer).toBe("Initial");
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "q", "");
    inbox().skip();
  });
  await act(async () => inbox().skip());
  expect(inbox().drafts.q?.customAnswer).toBe("");
  await act(async () => inbox().onSelectOption(requestId, question, "one"));
  await act(async () => inbox().onSelectOption(requestId, question, "two"));
  expect(inbox().answers).toEqual({ q: ["one", "two"] });
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "Custom"));
  expect(inbox().answers).toEqual({ q: "Custom" });
});

it("rejects obsolete fields and does not submit incomplete answers", async () => {
  await mount([userInput()]);
  await act(async () => {
    inbox().onSelectOption(requestId, { ...question, id: "old" }, "one");
    inbox().onSelectOption(requestId, question, "obsolete");
    inbox().onChangeCustomAnswer(requestId, "old", "bad");
    await inbox().onSubmit();
  });
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(inbox().answers).toBeNull();
  expect(session?.draftsById).toEqual({});
});

it("reads no details on first hidden mount and rejects hidden response/retry callbacks", async () => {
  fixture.focused = false;
  write([userInput(), b]);
  await render(<Probe />);
  expect(fixture.evaluations).toBe(0);
  expect(fixture.detailEvaluations).toBe(0);
  expect(fixture.activeItems).toBe(0);
  expect(fixture.activeDetails).toBe(0);
  fixture.focused = true;
  await render(<Probe />);
  expect(fixture.activeItems).toBe(1);
  expect(fixture.activeDetails).toBe(1);
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "Survives blur"));
  const stale = inbox();
  const get = vi.spyOn(registry, "get");
  fixture.focused = false;
  await render(<Probe />);
  get.mockClear();
  expect(fixture.activeItems).toBe(0);
  expect(fixture.activeDetails).toBe(0);
  const before = fixture.evaluations;
  await act(async () => {
    write([userInput(envB)]);
    await stale.onSubmit();
    stale.retry();
  });
  expect(get).not.toHaveBeenCalled();
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(fixture.evaluations).toBe(before);
  fixture.focused = true;
  await render(<Probe />);
  expect(inbox().current?.ref.environmentId).toBe(envB);
  expect(session?.draftsById[userInput().id]).toBeUndefined();
  get.mockRestore();
});

it("keeps the draft, skip order and in-flight guard when covering Thread blurs Decisions", async () => {
  const qa = userInput();
  const qb = userInput(envB);
  const receipt = deferred();
  fixture.userInput.mockReturnValueOnce(receipt.promise);
  await mount([qa, qb]);
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "q", "A saved");
    inbox().skip();
  });
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "B saved"));
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = inbox().onSubmit();
  });
  fixture.focused = false;
  await render(<Probe />);
  await act(async () => {
    receipt.finish(AsyncResult.success(undefined));
    await pending;
  });
  fixture.focused = true;
  await render(<Probe />);
  expect(inbox().current?.id).toBe(qb.id);
  expect(inbox().drafts.q?.customAnswer).toBe("B saved");
  expect(inbox().responding).toBe(true);
  expect(session?.skippedIds).toEqual([qa.id]);
});

it("refreshes each failed producer once and retains the pinned draft on retry", async () => {
  const qa = userInput();
  await mount([qa]);
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", "Draft"));
  await act(async () =>
    write([], {
      errors: [
        { ref: qa.ref, message: "Failed" },
        { ref: qa.ref, message: "Failed again" },
      ],
    }),
  );
  const key = JSON.stringify([qa.ref.environmentId, qa.ref.threadId]);
  const before = fixture.producerEvaluations.get(key) ?? 0;
  const refresh = vi.spyOn(registry, "refresh");
  await act(async () => inbox().retry());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh.mock.calls[0]?.[0]).toBe(
    fixture.producers.get(JSON.stringify([qa.ref.environmentId, qa.ref.threadId])),
  );
  expect(fixture.producerEvaluations.get(key)).toBeGreaterThan(before);
  expect(inbox().drafts.q?.customAnswer).toBe("Draft");
  refresh.mockRestore();
});

it("answers through mounted body option and text interactions without selection", async () => {
  await mount([userInput()], <Probe body />);
  await click("OneFirst");
  await click("TwoSecond");
  expect(inbox().answers).toEqual({ q: ["one", "two"] });
  await type(question.question, "Typed reply");
  await click("Submit");
  expect(fixture.userInput.mock.calls[0]?.[0]).toMatchObject({
    input: { answers: { q: "Typed reply" } },
  });
});

it("renders recovery and honest empty states then allows a recovered answer", async () => {
  write([], { loadingRefs: [a.ref], isLoading: true });
  await render(<DecisionsRouteScreen />);
  expect(container.textContent).toContain("Loading decisions…");
  expect(container.textContent).not.toContain("No pending thread requests");
  await act(async () => write([], { errors: [{ ref: a.ref, message: "Detail failure" }] }));
  expect(container.textContent).toContain("Some decisions could not be loaded.");
  await click("Retry");
  await act(async () => write([userInput()]));
  await click("OneFirst");
  await click("Submit answers");
  expect(fixture.userInput).toHaveBeenCalledTimes(1);
  await act(async () => write([]));
  expect(container.textContent).toContain("No pending thread requests");
});

it("shows partial counts, failure text and disabled nonresumable actions", async () => {
  fixture.userInput.mockRejectedValueOnce(new Error("Send failed"));
  write([userInput()], { errors: [{ ref: b.ref, message: "B unavailable" }] });
  await render(<DecisionsRouteScreen />);
  expect(container.textContent).toContain("1 loaded");
  await click("OneFirst");
  await click("Submit answers");
  expect(container.textContent).toContain("Send failed");
  const unavailable: ReturnType<typeof userInput> = {
    ...userInput(),
    request: { ...userInput().request, responseCapability: "not_resumable" },
  };
  await act(async () => write([unavailable]));
  await click("Submit answers");
  expect(fixture.userInput).toHaveBeenCalledTimes(1);
  await act(async () =>
    write([{ ...a, request: { ...a.request, responseCapability: "not_resumable" } }]),
  );
  await click("Allow once");
  await click("Allow session");
  await click("Decline");
  expect(fixture.approval).not.toHaveBeenCalled();
});

it.each(["ios", "android"])(
  "keeps %s feed edits, collapse, submit and dismiss around the extracted body",
  async (os) => {
    fixture.os = os;
    vi.resetModules();
    const { PendingUserInputCard } = await import("../threads/PendingUserInputCard");
    const submitted = vi.fn();
    const dismissed = vi.fn();
    function Feed() {
      const [drafts, setDrafts] = useState<
        Record<string, { customAnswer?: string; selectedOptionValues?: readonly string[] }>
      >({});
      const [collapsed, setCollapsed] = useState(false);
      return (
        <PendingUserInputCard
          canOperateThread
          pendingUserInput={userInput().request}
          maxHeight={400}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          drafts={drafts}
          answers={buildPendingUserInputAnswers([question], drafts)}
          respondingUserInputId={null}
          onSelectOption={(_id, q, value) =>
            setDrafts((previous) => ({
              ...previous,
              [q.id]: togglePendingUserInputOptionSelection(q, previous[q.id], value),
            }))
          }
          onChangeCustomAnswer={(_id, q, value) => setDrafts({ [q]: { customAnswer: value } })}
          onSubmit={async () => {
            submitted(drafts);
          }}
          onDismiss={async () => {
            dismissed();
          }}
        />
      );
    }
    await render(<Feed />);
    await click("OneFirst");
    await click("TwoSecond");
    await click("Submit answers");
    expect(submitted).toHaveBeenCalledWith({
      q: { customAnswer: "", selectedOptionValues: ["one", "two"] },
    });
    await type("Choose an answer", "Feed answer");
    await click("Submit answers");
    expect(submitted).toHaveBeenCalledWith({ q: { customAnswer: "Feed answer" } });
    await click("Dismiss without answering");
    expect(dismissed).toHaveBeenCalledTimes(1);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label*="Collapse"]');
    if (!toggle) throw new Error("Missing collapse control");
    await act(async () => toggle.click());
    await click("Expand user input, 1 question");
    await type("Choose an answer", "After expansion");
    await click("Submit answers");
    expect(submitted).toHaveBeenLastCalledWith({ q: { customAnswer: "After expansion" } });
  },
);

// Keep actual Home/sidebar branch selection and shared list derivation. Only
// device chrome and runtime owners are adapted for the DOM harness.
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: <A,>(props: {
    data: readonly A[];
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    renderItem: (info: { item: A; index: number }) => ReactNode;
    keyExtractor: (item: A) => string;
  }) => (
    <section>
      {props.ListHeaderComponent}
      {props.data.length > 0
        ? props.data.map((item, index) => (
            <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
          ))
        : props.ListEmptyComponent}
    </section>
  ),
}));
vi.mock("@legendapp/list/reanimated", async () => ({
  AnimatedLegendList: (await import("@legendapp/list/react-native")).LegendList,
}));
vi.mock("../threads/threadListAnimations", () => ({ THREAD_SIDEBAR_ROW_LAYOUT: undefined }));
vi.mock("react-native-screens", () => ({ ScrollViewMarker: Box }));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: Box,
  useNativeGesture: () => ({}),
}));
vi.mock("../../native/v5-workspace-context", async () => ({
  NativePrimaryColumnContext: (await import("react")).createContext(null),
}));
vi.mock("../../native/scrollEdgeEffects", () => ({ nativeHeaderScrollEdgeEffects: {} }));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeLayoutMetrics: () => null,
  useNativeColumnLayoutMetrics: () => null,
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabClearance: 80, smallIconSize: 16 }),
}));
vi.mock("../../components/ui/useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 56, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../components/ui/FloatingActionButton", () => ({
  FloatingActionButton: () => null,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/CompactBrandTitle", () => ({ CompactBrandTitle: () => null }));
vi.mock("../../state/queries", () => ({
  useThreadSearch: () => ({ matches: [], isPending: false }),
}));
vi.mock("../../state/thread-order", () => ({ usePendingThreadOrder: () => null }));
vi.mock("../../state/use-thread-outbox", () => ({ useQueuedThreadKeys: () => new Set() }));
vi.mock("../../state/use-pending-new-tasks", () => ({ usePendingNewTasks: () => [] }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadListEnvironmentsAtom: Atom.make({
      providersByEnvironmentId: new Map(),
      machineByEnvironmentId: new Map(),
      settlementEnvironmentIds: new Set(),
      snoozeEnvironmentIds: new Set(),
      pinningEnvironmentIds: new Set(),
      autoSettleOptOutEnvironmentIds: new Set(),
      pinReorderEnvironmentIds: new Set(),
      activeReorderEnvironmentIds: new Set(),
      titleRegenerationEnvironmentIds: new Set(),
    }),
  };
});
vi.mock("../threads/thread-provider-instance", () => ({
  useThreadRowProviderInstanceResolver: () => () => null,
}));
vi.mock("../threads/use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({
    loaded: true,
    settledShelfExpanded: false,
    snoozedShelfExpanded: false,
    workingShelfEnabled: false,
    workingShelfExpanded: false,
    toggleSettledShelf: () => {},
    toggleSnoozedShelf: () => {},
    toggleWorkingShelf: () => {},
  }),
}));
vi.mock("../threads/thread-list-v2-items", () => ({
  ThreadListV2Row: (props: { thread: EnvironmentThreadShell }) => <p>{props.thread.title}</p>,
  ThreadListV2PendingRow: () => null,
  ThreadListV2SettledShelfHeader: () => <p>Settled</p>,
  ThreadListV2ShowMoreRow: () => null,
  ThreadListV2SnoozedShelfHeader: () => <p>Snoozed</p>,
  ThreadListV2WorkingShelfHeader: () => <p>Working</p>,
}));
vi.mock("../keyboard/threadKeyboardShortcuts", () => ({ useThreadJumpShortcuts: () => {} }));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("../home/thread-swipe-actions", () => ({
  SwipeableScrollGateProvider: Box,
  useSwipeableScrollGate: () => ({ swipeEnabled: false, scrollGateHandlers: {} }),
}));
vi.mock("../home/FabScrollContext", () => ({ useFabScroll: () => () => {} }));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../home/ThreadListFilters", () => ({ ThreadListFilters: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: { "--color-drawer": "white" } }),
}));
vi.mock("../home/home-list-options", () => ({
  useHomeListOptions: () => ({
    options: {
      selectedEnvironmentId: fixture.selectedEnvironmentId,
      selectedProjectKey: fixture.selectedProjectKey,
      projectGroupingMode: "repository",
      projectSortOrder: "updated_at",
    },
    setSelectedEnvironmentId: () => {},
    setSelectedProjectKey: () => {},
  }),
}));
vi.mock("../home/usePendingTaskListActions", () => ({
  usePendingTaskListActions: () => ({
    openPendingTask: () => {},
    confirmDeletePendingTask: () => {},
  }),
}));
vi.mock("../home/useThreadListActions", () => ({
  useThreadListActions: () => ({
    archiveThread: () => {},
    confirmDeleteThread: () => {},
    settleThread: () => {},
    snoozeThread: () => {},
    unsnoozeThread: () => {},
    unsettleThread: () => {},
    pinThread: () => {},
    unpinThread: () => {},
    setThreadAutoSettle: () => {},
    moveThread: () => {},
    renameThread: () => {},
    regenerateThreadTitle: () => {},
  }),
}));
vi.mock("../home/WorkspaceConnectionTitle", () => ({
  getConnectionAwareBrandHeaderOptions: () => ({}),
  WorkspaceConnectionTitle: Box,
}));
vi.mock("../threads/sidebar-header-actions", () => ({ SidebarHeaderActions: () => null }));
vi.mock("../home/ThreadListToolbar", () => ({ ThreadListToolbar: () => null }));
vi.mock("../threads/sidebar-filter-button", () => ({ SidebarFilterButton: () => null }));
vi.mock("../threads/sidebar-native-header-items", () => ({ createSidebarHeaderItems: () => [] }));
vi.mock("../threads/sidebar-navigation-shell", () => ({ SidebarNavigationShell: Box }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ environments: [], state: catalogState }),
}));

import { HomeScreen } from "../home/HomeScreen";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import type { WorkspaceState } from "../../state/workspaceModel";

const catalogState: WorkspaceState = {
  isLoadingConnections: false,
  hasConnections: true,
  hasReadyEnvironment: true,
  hasConnectingEnvironment: false,
  hasSyncingConnectedEnvironment: false,
  connectingEnvironments: [],
  connectionState: "connected",
  connectionError: null,
  networkStatus: "online",
  hasLoadedShellSnapshot: true,
  hasPendingShellSnapshot: false,
  shellSnapshotError: null,
};
const noop = () => {};
const success = async () => true;
function homeProps(onOpenDecisions: () => void): ComponentProps<typeof HomeScreen> {
  return {
    projects: fixture.projects,
    threads: fixture.threads,
    pendingTasks: [],
    catalogState,
    savedConnectionsById: {},
    environments: [],
    searchQuery: fixture.searchQuery,
    selectedEnvironmentId: fixture.selectedEnvironmentId,
    selectedProjectKey: fixture.selectedProjectKey,
    projectSortOrder: "updated_at",
    projectGroupingMode: "repository",
    onSearchQueryChange: noop,
    onEnvironmentChange: noop,
    onProjectChange: noop,
    onAddConnection: noop,
    onOpenDecisions,
    onOpenSettings: noop,
    onStartNewTask: noop,
    onSelectThread: noop,
    onArchiveThread: noop,
    onDeleteThread: noop,
    onSettleThread: success,
    onSnoozeThread: success,
    onUnsnoozeThread: success,
    onUnsettleThread: noop,
    onPinThread: success,
    onUnpinThread: success,
    onSetThreadAutoSettle: success,
    onMoveThread: success,
    onRenameThread: noop,
    onRegenerateThreadTitle: success,
    onSelectPendingTask: noop,
    onDeletePendingTask: noop,
    onNewThreadOnBranch: noop,
    onNewThreadInProject: noop,
  };
}
function NavigationHarness(props: { surface: "home" | "sidebar" | "direct" }) {
  const [route, setRoute] = useState("Home");
  const [threadRef, setThreadRef] = useState<ScopedThreadRef | null>(null);
  useLayoutEffect(() => {
    fixture.navigate = (name, ref) => {
      setRoute(name);
      setThreadRef(ref ?? null);
    };
    fixture.back = () => setRoute("Home");
  });
  const open = () => setRoute("Decisions");
  if (route === "Thread")
    return (
      <>
        <p>{`Opened ${threadRef?.environmentId}/${threadRef?.threadId}`}</p>
        <button onClick={() => setRoute("Decisions")}>Back to decisions</button>
      </>
    );
  if (route === "Decisions" || props.surface === "direct") return <DecisionsRouteScreen />;
  return props.surface === "home" ? (
    <HomeScreen {...homeProps(open)} />
  ) : (
    <ThreadNavigationSidebar
      width={320}
      visible
      selectedThreadKey={null}
      onOpenDecisions={open}
      onOpenSettings={noop}
      onOpenEnvironmentSettings={noop}
      onOpenThreadPullRequests={noop}
      onOpenPendingTask={noop}
      onNewThreadOnBranch={noop}
      onNewThreadInProject={noop}
      onSearchQueryChange={noop}
      onSelectThread={noop}
      onRequestVisibility={noop}
      searchQuery={fixture.searchQuery}
    />
  );
}

it.each([
  ["home", "ios", "populated"],
  ["home", "android", "populated"],
  ["home", "ios", "empty"],
  ["home", "android", "empty"],
  ["home", "ios", "filtered"],
  ["home", "android", "filtered"],
  ["sidebar", "ios", "populated"],
  ["sidebar", "android", "populated"],
  ["sidebar", "ios", "empty"],
  ["sidebar", "android", "empty"],
  ["sidebar", "ios", "filtered"],
  ["sidebar", "android", "filtered"],
  ["home", "ios", "project"],
  ["home", "android", "project"],
  ["sidebar", "ios", "project"],
  ["sidebar", "android", "project"],
  ["home", "ios", "environment"],
  ["home", "android", "environment"],
  ["sidebar", "ios", "environment"],
  ["sidebar", "android", "environment"],
])(
  "keeps %s %s %s Decisions above the roster and navigates to the scoped thread",
  async (surface, os, roster) => {
    if (surface !== "home" && surface !== "sidebar") throw new Error("Invalid test surface");
    fixture.os = os;
    fixture.threads =
      roster === "empty"
        ? []
        : [makeThreadShellFixture({ title: "Navigation thread", environmentId: envA })];
    fixture.searchQuery = roster === "filtered" ? "unmatched query" : "";
    if (roster === "project") {
      fixture.projects = [
        {
          environmentId: envA,
          id: ProjectId.make("other-project"),
          title: "Other project",
          workspaceRoot: "/synthetic/other-project",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: a.createdAt,
          updatedAt: a.createdAt,
        },
      ];
      fixture.selectedProjectKey = buildHomeProjectScopes({
        projects: fixture.projects,
        environmentId: null,
        projectGroupingMode: "repository",
      })[0]!.key;
    }
    if (roster === "environment") fixture.selectedEnvironmentId = envB;
    registry.set(fixture.summary!, { count: 2, refs: [a.ref, b.ref] });
    write([userInput(envB)]);
    await render(<NavigationHarness surface={surface} />);
    const row = button("2 decisions waiting");
    expect(
      [...container.querySelectorAll("button")].filter(
        (element) => element.textContent === "2 decisions waiting",
      ),
    ).toHaveLength(1);
    const rosterText = [...container.querySelectorAll("p")].find(
      (element) => element.textContent === "Navigation thread",
    );
    if (roster === "populated") {
      expect(rosterText).toBeDefined();
      if (rosterText)
        expect(
          row.compareDocumentPosition(rosterText) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    } else expect(rosterText).toBeUndefined();
    expect(fixture.detailEvaluations).toBe(0);
    await click("2 decisions waiting");
    expect(container.textContent).toContain("Choose an answer");
    await click("Go to thread");
    expect(container.textContent).toContain("Opened B/thread");
    await click("Back to decisions");
    await click("Back");
    expect(container.textContent).toContain("2 decisions waiting");
    await act(async () => registry.set(fixture.summary!, { count: 0, refs: [] }));
    expect(container.textContent).not.toContain("decisions waiting");
  },
);

it("supports a direct empty route and Home fallback", async () => {
  fixture.canGoBack = false;
  write([]);
  const navigate = vi.fn();
  fixture.navigate = navigate;
  await render(<DecisionsRouteScreen />);
  expect(container.textContent).toContain("No pending thread requests");
  await click("Back");
  expect(navigate).toHaveBeenCalledWith("Home", undefined);
});

it("rejects retained question callbacks after its advertised fields change", async () => {
  const qa = userInput();
  await mount([qa]);
  const stale = inbox();
  const replacement = userInput(envA, [{ ...question, id: "new-question", options: [] }]);
  await act(async () => {
    write([replacement]);
    stale.onSelectOption(requestId, question, "one");
    stale.onChangeCustomAnswer(requestId, "q", "Old field");
    stale.onChangeCustomAnswer(RuntimeRequestId.make("old-request"), "new-question", "Old request");
    await stale.onSubmit();
  });
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(inbox().answers).toBeNull();
  const unavailable: ReturnType<typeof userInput> = {
    ...replacement,
    request: { ...replacement.request, responseCapability: "not_resumable" },
  };
  await act(async () => write([unavailable]));
  await act(async () => {
    inbox().onChangeCustomAnswer(requestId, "new-question", "Not allowed");
    await inbox().onSubmit();
  });
  expect(fixture.userInput).not.toHaveBeenCalled();
});

it("blocks a destination without operate scope while another environment has it", async () => {
  fixture.allowed.delete(envB);
  await mount([userInput(envB)], <DecisionsRouteScreen />);
  await type(question.question, "Unauthorized");
  await click("OneFirst");
  await click("Submit answers");
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(container.textContent).toContain("This connection cannot submit answers.");
  const navigate = vi.fn();
  fixture.navigate = navigate;
  await click("Go to thread");
  expect(navigate).toHaveBeenCalledWith("Thread", b.ref);
});

it("mounts the real screen hidden without reading details, then shows a fresh corrected count", async () => {
  fixture.focused = false;
  const third = approval(envB, ThreadId.make("second"), "2026-10-03T00:00:00.000Z");
  await mount([a, b, third], <DecisionsRouteScreen />);
  expect(fixture.evaluations).toBe(0);
  expect(fixture.detailEvaluations).toBe(0);
  fixture.focused = true;
  await render(<DecisionsRouteScreen />);
  expect(container.textContent).toContain("3 decisions waiting");
  expect(fixture.activeItems).toBe(1);
  expect(fixture.activeDetails).toBe(1);
  fixture.focused = false;
  await render(<DecisionsRouteScreen />);
  expect(fixture.activeItems).toBe(0);
  expect(fixture.activeDetails).toBe(0);
});

it("uses the failed entry's scope for recovery navigation", async () => {
  write([], { errors: [{ ref: b.ref, message: "Failed B" }] });
  const navigate = vi.fn();
  fixture.navigate = navigate;
  await render(<DecisionsRouteScreen />);
  await click("Go to thread");
  expect(navigate).toHaveBeenCalledWith("Thread", b.ref);
});
