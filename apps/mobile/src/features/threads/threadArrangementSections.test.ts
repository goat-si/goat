import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { goatBotObservationThreadKeys } from "@goat/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { threadArrangementSections } from "./threadArrangementSections";

const environmentId = EnvironmentId.make("environment-1");
const SESSION = "goat-bot-session:conversation";

const thread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id, ...overrides });

const threads = [
  thread("pinned", { pinnedAt: "2026-06-01T00:00:00.000Z", pinOrderKey: "a" }),
  thread("active"),
  thread("snoozed", { snoozedUntil: "2026-06-03T00:00:00.000Z" }),
  thread("settled", { settledOverride: "settled" }),
  thread(SESSION, { pinnedAt: "2026-06-01T00:00:00.000Z", pinOrderKey: "b" }),
  thread("goat-bot-session:snoozed", { snoozedUntil: "2026-06-03T00:00:00.000Z" }),
  thread("goat-bot-session:settled", { settledOverride: "settled" }),
];

function sections(hiddenBotThreadKeys: ReadonlySet<string>) {
  const environments = new Set([environmentId]);
  const result = threadArrangementSections({
    threads,
    now: "2026-06-02T00:00:00.000Z",
    queuedThreadKeys: new Set(),
    pendingOrder: null,
    settlementEnvironmentIds: environments,
    snoozeEnvironmentIds: environments,
    hiddenBotThreadKeys,
    workingShelfEnabled: false,
  });
  const ids = (rows: readonly EnvironmentThreadShell[]) => rows.map((row) => String(row.id));
  return {
    pinned: ids(result.pinned),
    active: ids(result.active),
    snoozed: ids(result.snoozed),
    settled: ids(result.settled),
  };
}

describe("thread arrangement sections with GOAT Bot threads", () => {
  it("leaves hidden GOAT Bot threads out of every section, Snoozed and Settled included", () => {
    expect(sections(goatBotObservationThreadKeys({ threads }))).toEqual({
      pinned: ["pinned"],
      active: ["active"],
      snoozed: ["snoozed"],
      settled: ["settled"],
    });
  });

  it("arranges them with the rest while this device shows them", () => {
    const shown = sections(new Set());
    expect(shown.pinned).toEqual(["pinned", SESSION]);
    expect(shown.snoozed.toSorted()).toEqual(["goat-bot-session:snoozed", "snoozed"]);
    expect(shown.settled.toSorted()).toEqual(["goat-bot-session:settled", "settled"]);
  });
});
