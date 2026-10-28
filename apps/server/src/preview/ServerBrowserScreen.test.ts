import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import type { ServerBrowserViewerOutput } from "./ServerBrowser.ts";
import { assertScreenExpectation, makeSurface, type ScreenTab } from "./ServerBrowserScreen.ts";

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
      }),
  );
});
