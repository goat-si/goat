import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { formTab, runCells } from "./ScreenTargetPrelude.testkit.ts";

type Request = Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0];

/** A bound tab whose browser answers each input with answer(request) and records what it got. */
const tabBroker = (answer: (request: Request) => object) => {
  const sent: Request[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>(request: Request) => {
      if (request.operation !== "status" && request.operation !== "claim") sent.push(request);
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
        ...answer(request),
      } as A);
    },
  };
  return { broker, sent };
};

it.live(
  "a tab click sends a wanted checked state and app-named keys as browser modifiers, refusing malformed ones unsent",
  () => {
    const { broker, sent } = tabBroker(() => ({ effect: "confirmed", evidence: ["input"] }));
    return runCells(broker, [
      `const tab = await screen.tab({tabId: 'form'});
      await tab.claim();
      const done = await tab.click('#terms', { checked: true, modifiers: ['cmd', 'shift'] });
      const refused = [];
      for (const options of [{ checked: 'yes' }, { modifiers: ['super'] }, { checked: true, button: 'right' }, { checked: true, count: 2 }])
        try { await tab.click('#terms', options); } catch (error) { refused.push([error.code, error.nothingSent]); }
      return { done, refused };`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: {
            status: "completed",
            value: {
              done: { ok: true, verdict: "confirmed" },
              refused: Array.from({ length: 4 }, () => ["invalid_argument", true]),
            },
          },
        });
        expect(sent.map((request) => [request.operation, request.input])).toEqual([
          [
            "click",
            {
              locator: "#terms",
              checked: true,
              modifiers: ["Meta", "Shift"],
              timeoutMs: expect.any(Number),
            },
          ],
        ]);
      }),
    );
  },
);

it.live(
  "a checked tab click that found the state already held is confirmed and says nothing was sent",
  () => {
    const { broker } = tabBroker(() => ({ pressed: false, checked: true }));
    return runCells(broker, [
      `const tab = await screen.tab({tabId: 'form'});
    await tab.claim();
    return await tab.click('#terms', { checked: true });`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: {
            status: "completed",
            value: {
              ok: true,
              verdict: "confirmed",
              note: "already in that state; nothing was sent",
            },
          },
        });
      }),
    );
  },
);

it.live(
  "a tab wait sends a url with * as a glob and a plain one as the substring any host reads, and returns a download",
  () => {
    const file = { fileName: "report.csv", path: "/artifacts/report.csv", sizeBytes: 3 };
    const { broker, sent } = tabBroker((request) =>
      request.operation === "waitFor" && (request.input as { download?: true }).download
        ? { download: file }
        : {},
    );
    return runCells(broker, [
      `const tab = await screen.tab({tabId: 'form'});
    const url = await tab.waitFor({ url: '**/done' });
    const plain = await tab.waitFor({ url: '/done' });
    const saved = await tab.waitFor({ download: true });
    let refused;
    try { await tab.waitFor({ download: 'yes' }); } catch (error) { refused = [error.code, error.nothingSent]; }
    return { url: url.met && plain.met, saved: saved.download, refused };`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: {
            status: "completed",
            value: { url: true, saved: file, refused: ["invalid_argument", true] },
          },
        });
        expect(sent.map((request) => request.input)).toEqual([
          { urlGlob: "**/done" },
          { urlIncludes: "/done" },
          { download: true },
        ]);
      }),
    );
  },
);

it.live(
  "a tab click a held key's dialog stopped before it was sent reads unverifiable, not confirmed",
  () => {
    const { broker } = tabBroker(() => ({
      effect: "confirmed",
      evidence: ["dialog"],
      pressesCompleted: 0,
    }));
    return runCells(broker, [
      `const tab = await screen.tab({tabId: 'form'});
    await tab.claim();
    return await tab.click('#terms', { checked: true, modifiers: ['shift'] });`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: { status: "completed", value: { ok: true, verdict: "unverifiable" } },
        });
      }),
    );
  },
);
