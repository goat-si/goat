import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initialGoatBotEnsure,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
} from "./goatBotEnsure";

const bot = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };
const confirmed = { kind: "confirmed", bot } as const;

describe("goat bot ensure", () => {
  it("confirms the answer to the pending request", () => {
    const synced = syncGoatBotEnsure(initialGoatBotEnsure, "env:1:true");
    const { machine, token } = startGoatBotEnsure(synced);
    expect(machine.ensure).toEqual({ state: "pending" });
    expect(settleGoatBotEnsure(machine, token, confirmed).ensure).toEqual({
      state: "confirmed",
      bot,
    });
  });

  it("starts over at once when the connection changes, ignoring the old answer", () => {
    const { machine, token } = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, "env:1:true"),
    );
    const settledOnce = settleGoatBotEnsure(machine, token, confirmed);
    const reconnected = syncGoatBotEnsure(settledOnce, "env:2:true");
    expect(reconnected.ensure).toEqual({ state: "idle" });
    expect(syncGoatBotEnsure(reconnected, "env:2:true")).toBe(reconnected);
  });

  it("drops an answer from before a reconnect even when it arrives last", () => {
    const first = startGoatBotEnsure(syncGoatBotEnsure(initialGoatBotEnsure, "env:1:true"));
    const second = startGoatBotEnsure(syncGoatBotEnsure(first.machine, "env:2:true"));
    const answered = settleGoatBotEnsure(second.machine, second.token, {
      kind: "legacy_active",
    });
    expect(settleGoatBotEnsure(answered, first.token, confirmed).ensure).toEqual({
      state: "legacy_active",
    });
  });

  it("ignores an answer to a request retried before it settled", () => {
    const first = startGoatBotEnsure(syncGoatBotEnsure(initialGoatBotEnsure, "env:1:true"));
    const retried = retryGoatBotEnsure(first.machine);
    expect(settleGoatBotEnsure(retried, first.token, confirmed).ensure).toEqual({ state: "idle" });
  });

  it("applies only the first answer to one request", () => {
    const { machine, token } = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, "env:1:true"),
    );
    const settled = settleGoatBotEnsure(machine, token, { kind: "failed", message: "boom" });
    expect(settleGoatBotEnsure(settled, token, confirmed).ensure).toEqual({
      state: "failed",
      message: "boom",
    });
  });
});
