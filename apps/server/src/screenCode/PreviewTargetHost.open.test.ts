import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { actionErrorContext, browserFixture, call, context } from "./PreviewTargetHost.testkit.ts";

const errorPage = {
  environmentId: "env",
  browserInstanceId: "server-browser",
  connectionId: "connection",
  threadId: "thread",
  tabId: PreviewTabId.make("refused"),
  title: "localhost",
  url: "chrome-error://chromewebdata/",
  owner: "agent" as const,
  ownedByCaller: true,
  controlGeneration: 1,
};
const refused = () =>
  new PreviewAutomationExecutionError({
    ...actionErrorContext,
    operation: "open",
    reason: "The page did not load (ERR_CONNECTION_REFUSED).",
    unloadedTab: { tabId: errorPage.tabId, loadError: "ERR_CONNECTION_REFUSED" },
  });

/** A browser whose open leaves an error-page tab, closed by a close it accepts or refuses. */
const refusingBrowser = (
  close: "accept" | "refuse" | "ignore",
  failure = refused(),
  options: { readonly unlisted?: boolean; readonly hostGone?: boolean } = {},
) => {
  const state = {
    tabs: [errorPage],
    operations: [] as string[],
    routes: [] as Array<string | undefined>,
  };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    // A tab whose status the list could not read is left out of it while it stays live.
    listBoundTabs: () => Effect.succeed(options.unlisted ? [] : state.tabs),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation !== "open") state.routes.push(request.exact?.browserInstanceId);
      // An exact request reaches the browser only while it lists the tab: a closed tab, or a
      // browser that went away, answers no available host.
      if (request.operation === "status")
        return state.tabs.length > 0 && !options.hostGone
          ? Effect.succeed({ tabId: errorPage.tabId } as A)
          : Effect.fail(
              new PreviewAutomationNoAvailableHostError({
                operation: "status",
                environmentId: actionErrorContext.environmentId,
                threadId: actionErrorContext.threadId,
                providerSessionId: actionErrorContext.providerSessionId,
                providerInstanceId: actionErrorContext.providerInstanceId,
              }),
            );
      state.operations.push(request.operation);
      if (request.operation === "open") return Effect.fail(failure);
      if (request.operation === "close" && close === "refuse")
        return Effect.fail(
          new PreviewAutomationControlInterruptedError({
            ...actionErrorContext,
            operation: "close",
            reason: "humanControl",
          }),
        );
      if (request.operation === "close" && close === "accept") state.tabs = [];
      return Effect.succeed({} as A);
    },
  };
  return { state, broker };
};

it.effect("a blocked open returns the refusal without claiming an effect", () =>
  Effect.gen(function* () {
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([]),
      invoke: () =>
        Effect.fail(
          new PreviewAutomationControlInterruptedError({
            ...actionErrorContext,
            operation: "open",
            reason: "blocked_url",
            dispatched: false,
          }),
        ),
    };
    const host = yield* makePreviewTargetHost(broker);
    const result = yield* host
      .dispatch(call("open_tab", 1, { url: "https://blocked.test/" }), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "blocked_url", effectStarted: false });
  }),
);

it.effect("a blocked redirect after open reports that navigation started", () =>
  Effect.gen(function* () {
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([]),
      invoke: () =>
        Effect.fail(
          new PreviewAutomationControlInterruptedError({
            ...actionErrorContext,
            operation: "open",
            reason: "blocked_url",
            dispatched: true,
          }),
        ),
    };
    const host = yield* makePreviewTargetHost(broker);
    const result = yield* host
      .dispatch(call("open_tab", 1, { url: "https://safe.test/" }), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "blocked_url", effectStarted: true });
  }),
);

it.effect(
  "an open whose page refused the connection closes the tab it left and fails as a connection failure",
  () =>
    Effect.gen(function* () {
      const { state, broker } = refusingBrowser("accept");
      const host = yield* makePreviewTargetHost(broker);
      const result = yield* host
        .dispatch(call("open_tab", 1, { url: "http://127.0.0.1:4719/" }), context)
        .pipe(Effect.flip);
      expect(result).toMatchObject({ code: "downstream_failure", effectStarted: false });
      expect(result.message).toContain("ERR_CONNECTION_REFUSED");
      expect(result.message).toContain("closed");
      expect(state.operations).toEqual(["open", "close"]);
      expect(state.tabs).toEqual([]);
      // Nothing of it is left for turn cleanup.
      expect(yield* host.finishTurn({ runId: "run", turnId: "turn" })).toEqual([]);
    }),
);

it.effect.each(["refuse", "ignore"] as const)(
  "an error-page tab that could not be closed (%s) is named by id and left to turn cleanup",
  (close) =>
    Effect.gen(function* () {
      const { state, broker } = refusingBrowser(close);
      const host = yield* makePreviewTargetHost(broker);
      const result = yield* host
        .dispatch(call("open_tab", 1, { url: "http://127.0.0.1:4719/" }), context)
        .pipe(Effect.flip);
      expect(result).toMatchObject({ code: "downstream_failure", effectStarted: true });
      expect(result.message).toContain("refused is still open");
      expect(result.nextStep).toContain('tabId: "refused"');
      expect(state.tabs).toHaveLength(1);
    }),
);

it.effect("an error-page tab the list left out is not reported closed while it stays live", () =>
  Effect.gen(function* () {
    const { state, broker } = refusingBrowser("ignore", refused(), { unlisted: true });
    const host = yield* makePreviewTargetHost(broker);
    const result = yield* host
      .dispatch(call("open_tab", 1, { url: "http://127.0.0.1:4719/" }), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "downstream_failure", effectStarted: true });
    expect(result.message).toContain("refused is still open");
    expect(state.operations).toEqual(["open", "close"]);
    // No claim holds it, so the answer does not promise turn cleanup, and both calls stayed on
    // the browser that answered the open.
    expect(result.nextStep).not.toContain("turn cleanup");
    expect(state.routes).toEqual(["server-browser", "server-browser"]);
  }),
);

it.effect("an open failure that names no tab stays an unknown outcome", () =>
  Effect.gen(function* () {
    const failure = new PreviewAutomationExecutionError({
      ...actionErrorContext,
      operation: "open",
    });
    const { state, broker } = refusingBrowser("accept", failure);
    const host = yield* makePreviewTargetHost(broker);
    const result = yield* host
      .dispatch(call("open_tab", 1, { url: "http://127.0.0.1:4719/" }), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "unknown_outcome", effectStarted: true });
    expect(state.operations).toEqual(["open"]);
  }),
);

it.effect("a refused close on a browser that then went away is not reported closed", () =>
  Effect.gen(function* () {
    const { broker } = refusingBrowser("refuse", refused(), { hostGone: true });
    const host = yield* makePreviewTargetHost(broker);
    const result = yield* host
      .dispatch(call("open_tab", 1, { url: "http://127.0.0.1:4719/" }), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "downstream_failure", effectStarted: true });
    expect(result.message).toContain("refused is still open");
    // The open recorded its claim, so turn cleanup owns the tab.
    expect(result.nextStep).toContain("turn cleanup");
  }),
);

it.effect(
  "a selector that matched several elements fails unsent as ambiguous, saying how many",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      fixture.state.failure = new PreviewAutomationInvalidSelectorError({
        ...actionErrorContext,
        operation: "click",
        remoteTag: "PreviewAutomationInvalidSelectorError",
        matchCount: 2,
      });
      const reply = yield* fixture.dispatch("click", { selector: ".row" });
      expect(reply?.error).toMatchObject({ code: "target_ambiguous", effectStarted: false });
      expect(reply?.error?.message).toContain("matches 2 elements");
    }),
);

it.effect("a tab observe carries its host time, with and without a screenshot", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    for (const args of [{}, { screenshot: true }]) {
      const observed = yield* fixture.observe(args);
      expect(observed.ms).toBeTypeOf("number");
      expect(Object.keys(observed.phases ?? {})).toEqual([
        "driverMs",
        "parseMs",
        "renderMs",
        "bridgeMs",
      ]);
    }
  }),
);

it.effect("a double click a dialog cut short after its first press is never confirmed", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    fixture.state.clickResult = { effect: "confirmed", evidence: ["dialog"], pressesCompleted: 1 };
    const reply = yield* fixture.dispatch("click", { selector: "#b", count: 2 });
    expect(reply).toMatchObject({ outcome: "ok", category: "unverifiable" });
    // The object call form returns this value as is, so it carries no confirmed effect either.
    expect(reply?.value).toMatchObject({ effect: "unverifiable", pressesCompleted: 1 });
  }),
);
it.effect(
  "a fetch that failed in the page for an unknown reason changed nothing and does not ask to observe the tab",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      fixture.state.failure = new PreviewAutomationExecutionError({
        ...actionErrorContext,
        operation: "fetch",
        reason: "Fetching https://other.example/ failed: Failed to fetch",
      });
      const reply = yield* fixture.dispatch("fetch_tab", { url: "https://other.example/" });
      expect(reply?.error).toMatchObject({ code: "downstream_failure", effectStarted: false });
      expect(reply?.error?.nextStep).not.toContain("Observe the tab");
    }),
);
