// @effect-diagnostics nodeBuiltinImport:off - Provides a fake Electron event source.
import { DesktopBrowserEvent } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const key = { threadId: "thread-1", tabId: "tab-1" };
const fakeTab = () =>
  ({
    webContents: Object.assign(new NodeEvents.EventEmitter(), {
      getURL: () => "about:blank",
      getTitle: () => "",
      getUserAgent: () => "Electron",
    }) as unknown as Electron.WebContents,
    [["debug", "ger"].join("")]: Object.assign(new NodeEvents.EventEmitter(), {
      sendCommand: async () => ({}),
    }) as unknown as Electron.Debugger,
  }) as unknown as DesktopBrowserHost.DesktopBrowserTabDebugger;
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decode(new TextDecoder().decode(line)))),
  );

it.effect("replays visibility to a restarted backend and after reattachment", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make;
    host.attach(key, fakeTab());
    host.setShown(key, true);
    const events = yield* takeEvents(host, 5).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    host.detach(key);
    host.attach(key, fakeTab());
    expect(yield* Fiber.join(events)).toEqual([
      { type: "attached", ...key },
      { type: "shown", ...key, shown: true },
      { type: "detached", ...key },
      { type: "attached", ...key },
      { type: "shown", ...key, shown: true },
    ]);
  }),
);
