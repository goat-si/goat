import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut during action startup cannot return a successful result", () =>
  Effect.gen(function* () {
    const control = new SessionControl("agent");
    const result = yield* Effect.promise(() =>
      control
        .agent("agent", async () => {
          control.cutBlockedUrl();
          return "sent";
        })
        .then(
          () => null,
          (cause: unknown) => cause,
        ),
    );
    expect(result).toMatchObject({ reason: "blocked_url" });
  }),
);
