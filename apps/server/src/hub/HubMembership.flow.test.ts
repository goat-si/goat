import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PINNED, scope, setup } from "./HubMembership.testkit.ts";

it.effect("a refused link add reports OpenCodex's own message", () =>
  Effect.gen(function* () {
    const message = "Remote Link failed during Child restart preflight";
    const hub = yield* setup({ pin: PINNED, addExit: { code: 1, message } });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("failed");
    expect(result.message).toBe(`OpenCodex: ${message}`);
    expect(result.steps.find(({ step }) => step === "link_add")?.detail).toBe(
      `OpenCodex: ${message}`,
    );
  }),
);

it.effect("a refused Child restart names OpenCodex's reason in the leave step", () =>
  Effect.gen(function* () {
    const reason =
      "Restart not performed; the running client runtime was kept. Its background service owns it: run `ocx service restart`.";
    const hub = yield* setup({
      linked: ["mini"],
      deviceExit: { restart: 1 },
      deviceMessage: { restart: reason },
      reportedRole: "client",
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result.steps.find(({ step }) => step === "restart")?.detail).toBe(
      `ocx restart exited 1: ${reason}`,
    );
  }),
);
