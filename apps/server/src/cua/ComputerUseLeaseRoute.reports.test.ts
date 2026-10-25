// @effect-diagnostics preferSchemaOverJson:off -- The test posts the proxy's raw JSON body.
import { assert, describe, it } from "@effect/vitest";
import { COMPUTER_USE_LEASE_ROUTE, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { reportLayer } from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const threadId = ThreadId.make("thread:bot");
const outcomes = {
  "control:paused": "paused",
  "control:agents": "agents",
  "control:old": "refused",
} as const;

describe("ComputerUseLeaseRoute reports", () => {
  it.effect("a person's input reports keep flowing while agents remain active", () =>
    Effect.gen(function* () {
      // The route's handler reads its services per request, from the context it is given.
      const services = Context.make(McpSessionRegistry.McpSessionRegistry, {
        resolve: (token: string) =>
          Effect.succeed(token === "good" ? { thread: { threadId } } : undefined),
      } as unknown as McpSessionRegistry.McpSessionRegistry["Service"]).pipe(
        Context.add(ComputerUseLeases.ComputerUseLeases, {
          humanInput: (_thread: ThreadId, controlId: keyof typeof outcomes) =>
            Effect.succeed(outcomes[controlId]),
        } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(reportLayer, { disableLogger: true });
      const one = { source: "keyboard", at: 0 };
      const post = (controlId: string, token = "good", humanInput: unknown = one) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://127.0.0.1" + COMPUTER_USE_LEASE_ROUTE, {
              method: "POST",
              headers: { authorization: "Bearer " + token },
              body: JSON.stringify({ controlId, humanInput }),
            }),
            services,
          );
          return response.status;
        });
      yield* Effect.gen(function* () {
        assert.equal(yield* post("control:paused"), 204);
        assert.equal(yield* post("control:agents"), 202);
        assert.equal(yield* post("control:old"), 409);
        assert.equal(yield* post("control:paused", "stolen"), 401);
        // A batch of what piled up behind the last report (#1488), up to its limit.
        assert.equal(yield* post("control:paused", "good", [one, one]), 204);
        assert.equal(yield* post("control:paused", "good", []), 400);
        assert.equal(yield* post("control:paused", "good", Array(4097).fill(one)), 400);
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
  );
});
