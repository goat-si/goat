import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { desktopSession } from "../preview/PreviewSessions.ts";
import type { ComputerUseControl, ComputerUseControlState } from "./ComputerUseControl.ts";
import { makeStoppedCards } from "./ComputerUseStoppedCards.ts";

const base = { environmentId: EnvironmentId.make("env"), host: "pc", platform: "windows" } as const;
const detected = { humanInput: true, privateMode: true, frames: true } as const;
const threadId = ThreadId.make("thread-a");
const expiresAt = DateTime.makeUnsafe("2030-01-01T00:00:00.000Z");
const active = (apps: ReadonlyArray<string>) =>
  ({
    _tag: "active",
    expiresAt,
    apps,
    wakeAt: 0,
    interruptions: { count: 0, last: "human_input" },
  }) as const;

/** The cards a person sees for the thread, after the stopped-card merge and the list's filter. */
const visible = (current: ComputerUseControl, state: ComputerUseControlState) => {
  const cards = makeStoppedCards();
  cards.replaced({
    controlId: "control:stopped",
    threadId,
    expiresAt,
    acted: true,
    ended: "stopped",
  });
  return cards.merge([{ control: current, state }]).flatMap(({ control, state }) => {
    const session = desktopSession(base, control, state, detected);
    return session === undefined ? [] : [`${control.controlId}:${session.status}`];
  });
};

// A thread's kept stopped card must not give way to a newer control the list does not show,
// or the thread has no card at all (#1555 review, round 1).
describe("a stopped thread keeps exactly one card", () => {
  const fresh = { controlId: "control:new", threadId, expiresAt } satisfies ComputerUseControl;
  it.each([
    ["holds a new approval", active(["fixture.exe"])],
    ["is paused by a person", { _tag: "paused", reason: "human_input" }],
    ["is ended by Stop all", { _tag: "ended", reason: "stopped_all" }],
  ] as const)("while a newer control that has not acted %s", (_, state) => {
    expect(visible(fresh, state)).toEqual(["control:stopped:stopped"]);
  });

  it("and that card is the newer control once its agent acts", () => {
    expect(visible({ ...fresh, acted: true }, active(["fixture.exe"]))).toEqual([
      "control:new:acting",
    ]);
  });

  it("through a Stop all of a newer control that never acted, and the control after it", () => {
    const cards = makeStoppedCards();
    cards.replaced({
      controlId: "control:stopped",
      threadId,
      expiresAt,
      acted: true,
      ended: "stopped",
    });
    // A newer control the agent never acted through is ended by Stop all, then replaced in turn.
    cards.replaced({ ...fresh, ended: "stopped_all" });
    const next = { controlId: "control:next", threadId, expiresAt } satisfies ComputerUseControl;
    const seen = cards
      .merge([{ control: next, state: active([]) }])
      .flatMap(({ control, state }) => {
        const session = desktopSession(base, control, state, detected);
        return session === undefined ? [] : [`${control.controlId}:${session.status}`];
      });
    expect(seen).toEqual(["control:stopped:stopped"]);
  });
});
