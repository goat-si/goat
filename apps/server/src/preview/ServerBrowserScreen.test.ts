import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import type { ServerBrowserViewerOutput } from "./ServerBrowser.ts";
import {
  assertScreenExpectation,
  makeSurface,
  paintOccludedRefs,
  type ScreenTab,
  screenActionGate,
  screenTree,
} from "./ServerBrowserScreen.ts";
import { SessionControl } from "./SessionControl.ts";

const tab = (documentGeneration: number) =>
  ({
    threadId: "thread",
    tabId: "tab",
    control: { assertObservedGeneration: () => undefined },
    page: { url: () => "https://example.test/after" },
    desktop: null,
    viewers: new Set(),
    documentGeneration,
  }) as unknown as ScreenTab;

const request = (documentGeneration?: number): PreviewAutomationRequest => ({
  requestId: "request",
  threadId: ThreadId.make("thread"),
  tabId: "tab" as PreviewAutomationRequest["tabId"],
  tabIdExplicit: true,
  operation: "click",
  input: {},
  timeoutMs: 1000,
  screenExpectation: {
    browserInstanceId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    connectionId: "connection",
    controlGeneration: 0,
    origin: "https://example.test",
    ...(documentGeneration === undefined ? {} : { documentGeneration }),
  },
});

describe("screen expectation at the input gate", () => {
  it("refuses a screenshot point once the page has moved to another document", () => {
    expect(() => assertScreenExpectation(tab(2), request(1))).toThrow(
      "The page changed since that screenshot",
    );
    expect(() => assertScreenExpectation(tab(2), request(2))).not.toThrow();
    // Element actions carry no document; Playwright refs already fail on a new document.
    expect(() => assertScreenExpectation(tab(2), request())).not.toThrow();
  });

  it("an action's gate check refuses once Stop and resume changed its control, as type sees it", () => {
    const control = new SessionControl("agent");
    const agentTab = {
      threadId: "thread",
      tabId: "tab",
      control,
      page: { url: () => "https://example.test/after" },
      desktop: null,
      viewers: new Set(),
      documentGeneration: 2,
    } as unknown as ScreenTab;
    const gate = screenActionGate(agentTab, request());
    expect(() => gate.check?.()).not.toThrow();
    control.stopAgents();
    control.resumeAgents();
    // The agent may dispatch again, but this action began under the control that Stop ended.
    expect(() => control.assertAgentMayDispatch()).not.toThrow();
    expect(() => gate.check?.()).toThrow();
  });
});

describe("refs other content paints over", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it("a modal painted above a button hides it, but not a frame's button under the same modal", () => {
    const occluded = paintOccludedRefs([
      { ref: "e1", box: box(0, 0, 800, 600), paintOrder: 1, opaque: true },
      { ref: "e2", box: box(100, 100, 80, 20), paintOrder: 2 },
      { ref: "e3", box: box(200, 150, 400, 300), paintOrder: 9, opaque: true },
      { ref: "e4", box: box(250, 200, 80, 20), paintOrder: 5 },
      // A frame's boxes and paint order are its own; the main document's modal does not reach it.
      { ref: "f1e2", box: box(250, 200, 80, 20), paintOrder: 1 },
      // No paint data: the element stays visible.
      { ref: "e5", box: box(260, 210, 10, 10) },
    ]);
    expect([...occluded]).toEqual(["e4"]);
  });

  it("the tree marks an occluded ref and leaves every other line as it was", () => {
    const tree =
      '- dialog [ref=e3]\n  - button "Close" [ref=e5]\n- button "Buy" [ref=e4] [box=250,200,80,20]';
    const input = { limit: 10_000, unread: [], generation: "7" };
    const plain = screenTree(tree, { ...input, refs: new Map() });
    const refs = new Map<string, string>();
    const marked = screenTree(tree, { ...input, refs, occluded: new Set(["e4"]) });
    expect(marked.accessibilityTree.split("\n")).toEqual([
      ...plain.accessibilityTree.split("\n").slice(0, 2),
      '- button "Buy" [ref=t3-7-e4] [occluded] [box=250,200,80,20]',
    ]);
    expect(refs.get("t3-7-e4")).toBe("e4");
    expect(marked.treeComplete).toBe(true);
  });
});

describe("the agent's position on a screen tab", () => {
  it.effect(
    "a cursor state redraws the agent's last pointer on that document under its owner",
    () =>
      Effect.gen(function* () {
        const seen: ServerBrowserViewerOutput[] = [];
        const agentTab = {
          threadId: "thread",
          tabId: "tab",
          control: { agentId: "agent", isPrivate: false, controller: null },
          page: { url: () => "https://example.test/" },
          desktop: null,
          viewers: new Set([
            { push: (output: ServerBrowserViewerOutput) => void seen.push(output) },
          ]),
          documentGeneration: 1,
        } as unknown as ScreenTab & { documentGeneration: number };
        const surface = makeSurface(
          (threadId, tabId) => (threadId === "thread" && tabId === "tab" ? agentTab : undefined),
          () => {},
        );
        const owner = {
          environmentId: EnvironmentId.make("environment"),
          runId: "run",
          turnId: "turn",
          targetId: "target",
          generation: 1,
        };
        const state = (sequence: number, phase: "thinking" | "resting") =>
          surface.service.cursorState({
            threadId: "thread",
            tabId: "tab",
            cursor: { identity: { ...owner, sequence }, phase },
          });
        // The click's pointer reached the tab before the cell's thinking state did.
        surface.showPointer(agentTab, 140, 50, "click");
        yield* state(1, "thinking");
        expect(seen.at(-1)).toEqual({
          _tag: "pointer",
          phase: "move",
          x: 140,
          y: 50,
          sequence: 2,
          cursor: { identity: { ...owner, sequence: 1 }, phase: "thinking" },
        });
        // A new document moved everything; the old position is not redrawn on it.
        agentTab.documentGeneration = 2;
        yield* state(2, "resting");
        expect(seen.at(-1)).toEqual({
          _tag: "cursor-state",
          cursor: { identity: { ...owner, sequence: 2 }, phase: "resting" },
        });
      }),
  );

  it.effect(
    "a viewer that opens after an unwatched action starts at the agent's pointer once framed",
    () =>
      Effect.gen(function* () {
        const agentTab = {
          threadId: "thread",
          tabId: "tab",
          control: { agentId: "agent", isPrivate: false, controller: null },
          page: { url: () => "https://example.test/" },
          desktop: null,
          viewers: new Set(),
          documentGeneration: 1,
        } as unknown as ScreenTab;
        const surface = makeSurface(
          (threadId, tabId) => (threadId === "thread" && tabId === "tab" ? agentTab : undefined),
          () => {},
        );
        const cursor = {
          identity: {
            environmentId: EnvironmentId.make("environment"),
            runId: "run",
            turnId: "turn",
            targetId: "target",
            generation: 1,
            sequence: 1,
          },
          phase: "resting" as const,
        };
        // The click ran with nobody watching; the cell's state followed.
        surface.notePointer(agentTab, 140, 50);
        yield* surface.service.cursorState({ threadId: "thread", tabId: "tab", cursor });
        const seen: ServerBrowserViewerOutput[] = [];
        const viewer = { push: (output: ServerBrowserViewerOutput) => void seen.push(output) };
        // The viewer's first frame brings the replay; later frames do not repeat it.
        surface.framed(agentTab, viewer);
        surface.framed(agentTab, viewer);
        expect(seen).toEqual([
          expect.objectContaining({ _tag: "pointer", phase: "move", x: 140, y: 50, cursor }),
        ]);
        // A delayed phase from an older binding generation is rejected so it cannot overwrite the cache.
        const stale = {
          identity: { ...cursor.identity, targetId: "older", generation: 0, sequence: 9 },
          phase: "resting" as const,
        };
        expect(
          yield* surface.service.cursorState({ threadId: "thread", tabId: "tab", cursor: stale }),
        ).toBe(false);
      }),
  );
});
