import { describe, expect, it } from "@effect/vitest";
import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import { assertScreenExpectation, type ScreenTab } from "./ServerBrowserScreen.ts";

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
