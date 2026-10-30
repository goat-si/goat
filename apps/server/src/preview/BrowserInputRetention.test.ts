import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";
import { makeBrowserHistoryRecordAction } from "./BrowserHistoryRecordAction.ts";
import { makeBrowserInputRetention } from "./BrowserInputRetention.ts";
import { startBrowserInputEvidence } from "./BrowserInputEvidence.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

it.live("records trusted normal typing only with consent outside secret protection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const requests = yield* Queue.unbounded<{
        effect: ReturnType<typeof recordBrowserAction>;
        resolve: () => void;
        reject: (cause: unknown) => void;
      }>();
      yield* Queue.take(requests).pipe(
        Effect.flatMap(({ effect, resolve, reject }) =>
          effect.pipe(Effect.match({ onFailure: reject, onSuccess: resolve })),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const run = (effect: ReturnType<typeof recordBrowserAction>) =>
        new Promise<void>((resolve, reject) => {
          Queue.offerUnsafe(requests, { effect, resolve, reject });
        });
      const record = makeBrowserHistoryRecordAction(history, run);
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
          await page.setContent(
            '<input id="normal"><input id="password" type="password"><div id="edit" contenteditable="true"></div>',
          );
          const type = async (selector: string, consent: boolean, safe: boolean) => {
            const retention = makeBrowserInputRetention(
              () => startBrowserInputEvidence(page),
              async () => consent,
              () => safe,
            );
            await record(
              tab,
              "type",
              () =>
                ServerBrowserPage.type(page, { selector, text: "hello" }, undefined, {
                  onHistoryFocus: retention.onFocus,
                }),
              { typedText: "hello", finishRetention: retention.finish },
            );
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
        (yield* history.listForThread("thread:retention")).map((row) => row.typedText),
      ).toEqual([null, null, "hello", null, null, "hello"]);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
