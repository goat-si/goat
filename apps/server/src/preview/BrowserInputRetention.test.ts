import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { awaitHistoryPrefix } from "../cua/ComputerUseHistoryBackground.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";
import {
  browserHistoryPrefix,
  makeBrowserHistoryFork,
  makeBrowserHistoryRecordAction,
} from "./BrowserHistoryRecordAction.ts";
import { makeBrowserInputRetention } from "./BrowserInputRetention.ts";
import { historyTestChannel } from "./BrowserHistoryTestChannel.testkit.ts";
import { startBrowserInputEvidence } from "./BrowserInputEvidence.ts";
import { browserHistoryTarget } from "./BrowserHistoryTarget.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

it.live("records trusted normal typing only with consent outside secret protection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const owner = yield* Effect.scope;
      const requests = yield* Queue.unbounded<{
        effect: ReturnType<typeof recordBrowserAction>;
        resolve: () => void;
        reject: (cause: unknown) => void;
      }>();
      yield* Queue.take(requests).pipe(
        Effect.flatMap(({ effect, resolve, reject }) =>
          effect.pipe(Effect.match({ onFailure: reject, onSuccess: resolve }), Effect.forkScoped),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const run = (effect: ReturnType<typeof recordBrowserAction>) =>
        new Promise<void>((resolve, reject) => {
          Queue.offerUnsafe(requests, { effect, resolve, reject });
        });
      const record = makeBrowserHistoryRecordAction(
        history,
        (effect) => {
          void run(effect);
        },
        owner,
      );
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await (await browser.newContext()).newPage();
          const tab = {
            threadId: "thread:retention",
            page,
            actionTimeline: [],
            diagnostics: { firstLine: (cause: unknown) => String(cause) },
          };
          await page.setContent('<button id="save" aria-label="Save">Save</button>');
          const targetLabel = await browserHistoryTarget(
            page,
            { selector: "#save" },
            await historyTestChannel(page),
          );
          const clickChannel = await historyTestChannel(page);
          const clickGate = Object.assign(async () => {}, { channel: clickChannel });
          await record(
            tab,
            "click",
            () => ServerBrowserPage.click(page, { selector: "#save" }, undefined, clickGate),
            targetLabel === undefined ? {} : { targetLabel },
          );
          await run(awaitHistoryPrefix(browserHistoryPrefix(tab.threadId)));
          await page.setContent(
            '<input id="normal"><input id="password" type="password" value="private-secret"><div id="edit" contenteditable="true"></div>',
          );
          const passwordLabel = await browserHistoryTarget(
            page,
            { selector: "#password" },
            await historyTestChannel(page),
          );
          expect(passwordLabel).toBe("textbox");
          expect(passwordLabel).not.toContain("private-secret");
          await page.locator("#password").fill("");
          const type = async (selector: string, consent: boolean, safe: boolean) => {
            const channel = await historyTestChannel(page);
            const gate = Object.assign(async () => {}, { channel });
            const retention = makeBrowserInputRetention(
              async () => startBrowserInputEvidence(page, channel),
              async () => consent,
              () => safe,
            );
            await record(
              tab,
              "type",
              () =>
                ServerBrowserPage.type(page, { selector, text: "hello" }, gate, {
                  onHistoryFocus: retention.onFocus,
                }),
              { typedText: "hello", finishRetention: retention.finish },
            );
            await run(awaitHistoryPrefix(browserHistoryPrefix(tab.threadId)));
          };
          await type("#normal", true, true);
          await type("#password", true, true);
          await type("#normal", false, true);
          await type("#edit", true, true);
          await type("#normal", true, false);
          await page.evaluate(
            'document.querySelector("#normal").addEventListener("beforeinput", () => document.querySelector("#password").focus()); document.querySelector("#password").addEventListener("input", () => document.querySelector("#normal").focus());',
          );
          await type("#normal", true, true);
          expect(await page.locator("#password").inputValue()).toBe("hellohello");
        } finally {
          await browser.close();
        }
      });
      expect(
        (yield* history.listForThread("thread:retention"))
          .filter((row) => row.method === "type")
          .map((row) => row.typedText),
      ).toEqual([null, null, "hello", null, null, "hello"]);
      expect(
        (yield* history.listForThread("thread:retention")).find((row) => row.method === "click")
          ?.targetLabel,
      ).toBe("button: Save");
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live("does not send evidence commands after a blocked-host cut during typing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const owner = yield* Effect.scope;
      const fork = yield* makeBrowserHistoryFork();
      const launches: Array<Fiber.Fiber<void, never>> = [];
      const record = makeBrowserHistoryRecordAction(
        history,
        (effect) => {
          launches.push(fork(effect));
        },
        owner,
      );
      const dispatched = yield* Deferred.make<void>();
      const finished = Promise.withResolvers<void>();
      const action = yield* Effect.promise(async () => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await (await browser.newContext()).newPage();
          await page.setContent('<input id="normal">');
          let fenced = false;
          const channel = await historyTestChannel(page, () => fenced);
          const context = page.context();
          const original = context.newCDPSession.bind(context);
          const spies: Array<{
            readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
          }> = [];
          const creation = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
            const session = await original(target);
            spies.push(vi.spyOn(session, "send"));
            return session;
          });
          const gate = Object.assign(async () => {}, { channel });
          const retention = makeBrowserInputRetention(
            () => startBrowserInputEvidence(page, channel),
            async () => true,
            () => true,
          );
          const tab = {
            threadId: "thread:cut",
            page,
            actionTimeline: [],
            diagnostics: { firstLine: (cause: unknown) => String(cause) },
          };
          let sentBeforeCut = 0;
          await record(
            tab,
            "type",
            async () => {
              const result = await ServerBrowserPage.type(
                page,
                { selector: "#normal", text: "hello" },
                gate,
                { onHistoryFocus: retention.onFocus },
              );
              sentBeforeCut = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
              fenced = true;
              return result;
            },
            { typedText: "hello", finishRetention: retention.finish },
          );
          Deferred.doneUnsafe(dispatched, Effect.void);
          await finished.promise;
          expect(spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))).toContain(
            "DOMDebugger.getEventListeners",
          );
          expect(
            spies
              .flatMap((spy) => spy.mock.calls)
              .some(
                (call) =>
                  call[0] === "Runtime.evaluate" &&
                  JSON.stringify(call[1]).includes("addEventListener"),
              ),
          ).toBe(true);
          expect(sentBeforeCut).toBeGreaterThan(0);
          expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(sentBeforeCut);
          creation.mockRestore();
        } finally {
          await browser.close();
        }
      }).pipe(Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* Effect.forEach(launches, Fiber.join, { discard: true });
      yield* awaitHistoryPrefix(browserHistoryPrefix("thread:cut"));
      finished.resolve();
      yield* Fiber.join(action);
      yield* awaitHistoryPrefix(browserHistoryPrefix("thread:cut"));
      const rows = yield* history.listForThread("thread:cut");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.typedLength).toBe(5);
      expect(rows[0]?.typedText).toBeNull();
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
