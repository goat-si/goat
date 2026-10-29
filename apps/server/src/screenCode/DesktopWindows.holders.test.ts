import { expect, it } from "@effect/vitest";
import type { ScreenHostCall, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { AppHolder } from "../cua/ComputerUseAppLeases.ts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";

const other = "thread-other" as ThreadId;
const EDITOR = "org.example.Editor";
const appRows = [
  { pid: 42, name: "Editor", bundle_id: EDITOR },
  { pid: 44, name: "Editor", bundle_id: EDITOR },
  { pid: 50, name: "Notes", bundle_id: "org.example.Notes" },
];
const windowRows = [
  { pid: 42, window_id: 7, title: "Document" },
  { pid: 44, window_id: 8, title: "Second process" },
  { pid: 50, window_id: 9, title: "Notes" },
];
const held = { inUse: true, holderThreadId: other };
const at = (deadlineMillis: number, each: ScreenHostCall): ScreenHostCall => ({
  ...each,
  deadlineMillis,
});

const discoverWith = (
  holders: ReadonlyArray<AppHolder> | undefined,
  answers: Record<string, unknown> = {},
) => {
  const base = fixture({
    list_apps: { apps: appRows },
    list_windows: { windows: windowRows },
    ...answers,
  });
  const host = createDesktopTargetHost({
    primitiveChannel: base.channel,
    leases: {
      ...base.leases,
      ...(holders === undefined ? {} : { appHolders: () => Effect.succeed(holders) }),
    },
    platform: "darwin",
  });
  return { host, sent: base.sent };
};

it.effect("discover marks the apps and windows another thread uses, by process or by app id", () =>
  Effect.gen(function* () {
    const { host, sent } = discoverWith([{ holderThreadId: other, pids: [42], app: EDITOR }]);
    const listedApps = yield* host.discover(at(10_000, call("list_apps")), context);
    expect(listedApps.value).toEqual({
      apps: [{ ...appRows[0], ...held }, { ...appRows[1], ...held }, appRows[2]],
    });
    const before = sent.length;
    const listedWindows = yield* host.discover(at(10_000, call("list_windows")), context);
    expect(listedWindows.value).toEqual({
      windows: [{ ...windowRows[0], ...held }, { ...windowRows[1], ...held }, windowRows[2]],
    });
    // The window of a second process of the held app needs the app list to be known as held.
    expect(sent.slice(before).map((each) => each.tool)).toEqual(["list_windows", "list_apps"]);
  }),
);

it.effect(
  "discover with no other holder returns the driver's rows untouched with no extra call",
  () =>
    Effect.gen(function* () {
      const { host, sent } = discoverWith([]);
      expect((yield* host.discover(at(10_000, call("list_windows")), context)).value).toEqual({
        windows: windowRows,
      });
      expect(sent.map((each) => each.tool)).toEqual(["list_windows"]);
    }),
);

it.effect("discover says holders are unknown whenever it cannot tell a row's app", () =>
  Effect.gen(function* () {
    // A lease service that cannot answer.
    const unanswered = discoverWith(undefined);
    expect((yield* unanswered.host.discover(at(10_000, call("list_apps")), context)).value).toEqual(
      {
        apps: appRows,
        holdersUnknown: true,
      },
    );
    const holders = [{ holderThreadId: other, pids: [42], app: EDITOR }];
    // An app list cut at the channel cap maps no window to its app; the held process still shows.
    const cut = discoverWith(holders, {
      list_apps: { message: "Driver reply exceeded the primitive channel limit." },
    });
    expect((yield* cut.host.discover(at(10_000, call("list_windows")), context)).value).toEqual({
      windows: [{ ...windowRows[0], ...held }, windowRows[1], windowRows[2]],
      holdersUnknown: true,
    });
    // A process listed without an id may be the held app.
    const anonymous = discoverWith(holders, {
      list_apps: { apps: [...appRows, { pid: 60, name: "Editor helper" }] },
    });
    expect(
      (yield* anonymous.host.discover(at(10_000, call("list_apps")), context)).value,
    ).toMatchObject({ holdersUnknown: true });
    // Too little of the cell is left to read the app list: windows stay unresolved.
    const late = discoverWith(holders);
    expect((yield* late.host.discover(call("list_windows"), context)).value).toMatchObject({
      holdersUnknown: true,
    });
    expect(late.sent.map((each) => each.tool)).toEqual(["list_windows"]);
  }),
);

it.effect(
  "discover keeps the driver's rows when the marks would not fit the cell's return budget",
  () =>
    Effect.gen(function* () {
      const { host } = discoverWith([{ holderThreadId: other, pids: [42, 44, 50] }]);
      const raw = JSON.stringify({ windows: windowRows }).length;
      const tight = { ...context, limits: { ...context.limits, returnBytes: raw + 30 } };
      expect((yield* host.discover(at(10_000, call("list_windows")), tight)).value).toEqual({
        windows: windowRows,
        holdersUnknown: true,
      });
    }),
);
