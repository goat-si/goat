import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { chromiumInstalled } from "./chromiumInstalled.testkit.ts";
import { testActionGate } from "./actionChannel.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { PreviewAutomationEvaluateInput } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);

describe.skipIf(!chromiumInstalled)("preview evaluation", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  it("evaluates top-level await and returns the final expression", async () => {
    await page.setContent("<title>Ready</title>");
    const result = await ServerBrowserPage.evaluate(
      { page, cdp },
      { expression: "await Promise.resolve(); document.title" },
      5_000,
      testActionGate(page, cdp),
    );
    expect(result).toBe("Ready");
  });

  it("returns object contents when a legacy caller asks for a remote reference", async () => {
    const input = decodeEvaluateInput({
      expression: "({ answer: 42, nested: { ready: true } })",
      returnByValue: false,
    });
    expect(
      await ServerBrowserPage.evaluate({ page, cdp }, input, 5_000, testActionGate(page, cdp)),
    ).toEqual({ answer: 42, nested: { ready: true } });
  });

  it("does not repeat side effects when a running expression throws a SyntaxError", async () => {
    await expect(
      ServerBrowserPage.evaluate(
        { page, cdp },
        { expression: "window.runs = (window.runs ?? 0) + 1; new Function('await 0')" },
        5_000,
        testActionGate(page, cdp),
      ),
    ).rejects.toThrow("await is only valid");
    expect(await page.evaluate("window.runs")).toBe(1);
  });
});

describe("preview evaluation action channel", () => {
  it("does not retry a parse error received after the timeout", async () => {
    const { makeActionChannel } = await import("./actionChannel.ts");
    const { evaluateWithTimeout } = await import("./actionEvaluation.ts");
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<unknown>();
      const methods: string[] = [];
      const cdp = {
        send: (method: string) => {
          methods.push(method);
          return method === "Runtime.evaluate" ? pending.promise : Promise.resolve({});
        },
      } as unknown as CDPSession;
      const channel = makeActionChannel({
        cdp,
        page: {} as Page,
        signal: new AbortController().signal,
        controlGeneration: () => {},
        isFenced: () => false,
        blockedFrame: () => false,
      });
      const result = evaluateWithTimeout(channel, { expression: "await 0" }, 10);
      const rejected = expect(result).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      pending.resolve({
        result: {},
        exceptionDetails: { scriptId: "1", exception: { className: "SyntaxError" } },
      });
      await pending.promise;
      expect(methods).toEqual(["Runtime.evaluate", "Runtime.terminateExecution"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry after the action channel is fenced", async () => {
    const { makeActionChannel } = await import("./actionChannel.ts");
    const { evaluateWithTimeout } = await import("./actionEvaluation.ts");
    const pending = Promise.withResolvers<unknown>();
    let fenced = false;
    let sends = 0;
    const cdp = {
      send: () => {
        sends++;
        return pending.promise;
      },
    } as unknown as CDPSession;
    const channel = makeActionChannel({
      cdp,
      page: {} as Page,
      signal: new AbortController().signal,
      controlGeneration: () => {},
      isFenced: () => fenced,
      blockedFrame: () => false,
    });
    const result = evaluateWithTimeout(channel, { expression: "await 0" }, 5_000);
    fenced = true;
    pending.resolve({
      result: {},
      exceptionDetails: { scriptId: "1", exception: { className: "SyntaxError" } },
    });
    await expect(result).rejects.toThrow();
    expect(sends).toBe(1);
  });
});
