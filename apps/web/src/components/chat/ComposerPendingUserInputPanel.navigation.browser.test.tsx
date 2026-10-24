import {
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import type { EnvironmentCatalogState } from "@goat/client-runtime/state/connections";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

const boundary = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock(import("../../state/session"), { spy: true });
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => boundary.respond,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }) },
  };
});

import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentCatalog } from "../../connection/catalog";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { questionAttachmentDraftId } from "../../questionAttachments";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentScope } from "../../state/session";
import { toastManager } from "../ui/toast";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

function setup() {
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  boundary.respond.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  appAtomRegistry.set(
    environmentCatalog.catalogValueAtom as Atom.Writable<EnvironmentCatalogState>,
    { isReady: true, entries: new Map() },
  );
}

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

function PendingRequestsProbe({
  environmentId,
  projection,
  loading = false,
  onState,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  onState: (state: ReturnType<typeof usePendingThreadRequests>) => void;
}) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    activeThread: projection.thread,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
  useLayoutEffect(() => {
    onState(state);
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  setup();
  let requests!: ReturnType<typeof usePendingThreadRequests>;
  function Probe(props: Omit<ComponentProps<typeof PendingRequestsProbe>, "onState">) {
    return (
      <PendingRequestsProbe
        {...props}
        onState={(next) => {
          requests = next;
        }}
      />
    );
  }
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <Probe environmentId={environmentId} projection={projection} loading={loading} />
  );
  await using screen = await render(probe());
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  setup();
  let requests!: ReturnType<typeof usePendingThreadRequests>;
  function Probe(props: Omit<ComponentProps<typeof PendingRequestsProbe>, "onState">) {
    return (
      <PendingRequestsProbe
        {...props}
        onState={(next) => {
          requests = next;
        }}
      />
    );
  }
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: ComponentProps<typeof Probe>) => screen.rerender(<Probe {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(0);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => requests.onAdvanceActivePendingUserInput());
  }

  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(requests.activePendingUserInput?.requestId).toBe("second");
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

// #1406: an SSH route can disappear while a custom question answer is still a draft.
it("refuses a question answer after its attached thread loses its SSH route and keeps the draft", async () => {
  setup();
  using _bridge = stubGlobal("desktopBridge", {});
  const environmentId = EnvironmentId.make("question-desktop");
  const remoteId = EnvironmentId.make("question-remote");
  const primary: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "This computer",
      httpBaseUrl: "http://localhost",
      wsBaseUrl: "ws://localhost",
    }),
    profile: Option.none(),
    enabled: true,
  };
  const remote: ConnectionCatalogEntry = {
    target: new SshConnectionTarget({
      environmentId: remoteId,
      connectionId: "question-ssh",
      label: "Build machine",
    }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId: remoteId,
        connectionId: "question-ssh",
        label: "Build machine",
        target: { alias: "build-box", hostname: "example.invalid", username: null, port: null },
      }),
    ),
    enabled: true,
  };
  const writeRoutes = (includeRemote: boolean) =>
    appAtomRegistry.set(
      environmentCatalog.catalogValueAtom as Atom.Writable<EnvironmentCatalogState>,
      {
        isReady: true,
        entries: new Map([
          [environmentId, primary],
          ...(includeRemote ? [[remoteId, remote] as const] : []),
        ]),
      },
    );
  writeRoutes(true);
  const projection = questionProjection(ThreadId.make("question-route-removal"), ["answer"]);
  const record = {
    ...threadContextRecord(
      { environmentId: remoteId, threadId: ThreadId.make("remote-work") },
      "Remote work",
    ),
    host: "previous-alias",
  };
  const text = `Read ${formatComposerContextReference(record)}`;
  const target = questionAttachmentDraftId(
    environmentId,
    projection.thread.id,
    "answer",
    "question-1",
  );
  let requests!: ReturnType<typeof usePendingThreadRequests>;
  await using _screen = await render(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={projection}
      onState={(next) => {
        requests = next;
      }}
    />,
  );
  using toast = vi.spyOn(toastManager, "add");
  await act(() => {
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "First answer");
    requests.onChangeActivePendingUserInputCustomAnswer("question-1", text);
    requests.onChangeActivePendingUserInputCustomAnswer("question-2", "Last answer");
    useComposerDraftStore.getState().setPrompt(target, text);
    useComposerDraftStore.getState().addThreadContexts(target, [record]);
  });
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onAdvanceActivePendingUserInput());
  writeRoutes(false);
  await act(() => requests.onAdvanceActivePendingUserInput());

  expect(boundary.respond).not.toHaveBeenCalled();
  expect(requests.activePendingDraftAnswers["question-1"]?.customAnswer).toBe(text);
  expect(useComposerDraftStore.getState().getComposerDraft(target)).toMatchObject({
    prompt: text,
    threadContexts: [record],
  });
  expect(requests.activePendingIsResponding).toBe(false);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "Attached thread is on another machine",
    }),
  );

  // Restoring the route permits retry and projects the freshly settled alias.
  writeRoutes(true);
  await act(() => requests.onAdvanceActivePendingUserInput());
  expect(boundary.respond).toHaveBeenCalledTimes(1);
  expect(boundary.respond).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({
        answers: {
          "question-0": "First answer",
          "question-1": expect.stringContaining("host: build-box"),
          "question-2": "Last answer",
        },
      }),
    }),
  );
  expect(boundary.respond.mock.calls[0]?.[0].input.answers["question-1"]).not.toContain(
    "previous-alias",
  );
});

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";
import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

function Questions({
  initialIndex = 0,
  responseCapability = "live",
}: {
  initialIndex?: number;
  responseCapability?: PendingUserInput["responseCapability"];
}) {
  const [questionIndex, setQuestionIndex] = useState(initialIndex);
  const [disabled, setDisabled] = useState(false);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const advance = () => setQuestionIndex(questionIndex + 1);
  return (
    <>
      <output>{questionIndex}</output>
      <button onClick={() => setDisabled(true)}>Revoke</button>
      <button onClick={() => setDisabled(false)}>Grant</button>
      <button onClick={advance}>Next</button>
      <button onClick={() => setQuestionIndex(questionIndex - 1)}>Previous</button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...prompt, responseCapability }]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={disabled}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onToggleOption={(questionId, value) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}
function buttonWithText(text: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}
async function chooseOption() {
  await act(async () => buttonWithText("Incremental").click());
}
async function navigate(label: string) {
  await act(async () => buttonWithText(label).click());
}

it("cancels progression on revocation and resumes only after a new selection under a grant", async () => {
  setup();
  await using screen = await render(null);
  using _timers = fakeTimers();
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  await act(async () => screen.rerender(<Questions />));
  await chooseOption();
  await navigate("Revoke");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  await navigate("Grant");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it("blocks native option mutation and progression for a nonresumable request", async () => {
  setup();
  await using screen = await render(null);
  using _timers = fakeTimers();
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  await act(async () => screen.rerender(<Questions responseCapability="not_resumable" />));
  const option = buttonWithText("Incremental");
  expect(option.disabled).toBe(true);
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  expect(option.querySelectorAll("svg")).toHaveLength(0);
});

it("cancels an existing timer when the provider capability becomes nonresumable", async () => {
  setup();
  await using screen = await render(null);
  using _timers = fakeTimers();
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  await act(async () => screen.rerender(<Questions />));
  await chooseOption();
  await act(async () => screen.rerender(<Questions responseCapability="not_resumable" />));
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("preserves digit selection and ignores shortcuts in editable fields", async () => {
  setup();
  await using screen = await render(null);
  using _timers = fakeTimers();
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  await act(async () => screen.rerender(<Questions />));
  const input = document.createElement("input");
  document.body.append(input);
  try {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(activeIndex()).toBe("0");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(activeIndex()).toBe("1");
  } finally {
    input.remove();
  }
});
