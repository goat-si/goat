// @effect-diagnostics preferSchemaOverJson:off -- The test posts the proxy's raw JSON body.
import { assert, describe, it } from "@effect/vitest";
import { COMPUTER_USE_LEASE_ROUTE, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { HttpMiddleware, HttpRouter } from "effect/http";

import { untracedRequest } from "../http.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ComputerUseAgentConnections from "./ComputerUseAgentConnections.ts";
import { reportLayer } from "./ComputerUseLeaseRoute.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:bot");
const outcomes = {
  "control:paused": "paused",
  "control:agents": "agents",
  "control:old": "refused",
} as const;

describe("ComputerUseLeaseRoute reports", () => {
  it.effect("bearer-only primitive GET and ready, cutoff, and reply POSTs are refused", () =>
    Effect.gen(function* () {
      const services = Context.make(McpSessionRegistry.McpSessionRegistry, {
        resolve: (token: string) =>
          Effect.succeed(token === "good" ? { thread: { threadId } } : undefined),
      } as unknown as McpSessionRegistry.McpSessionRegistry["Service"]).pipe(
        Context.add(
          ComputerUseLeases.ComputerUseLeases,
          {} as unknown as ComputerUseLeases.ComputerUseLeases["Service"],
        ),
        Context.add(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel, {
          authenticate: () => Effect.void,
        } as unknown as ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel["Service"]),
        Context.add(
          ServerSettings.ServerSettingsService,
          {} as unknown as ServerSettings.ServerSettingsService["Service"],
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(LeaseRoute.layer, {
        disableLogger: true,
      });
      yield* Effect.promise(async () => {
        const get = await handler(
          new Request(
            `http://goat.test${COMPUTER_USE_LEASE_ROUTE}?control=one&primitive=1&instance=proxy`,
            { headers: { authorization: "Bearer good" } },
          ),
          services,
        );
        assert.equal(get.status, 401);
        for (const [path, body] of [
          [
            "primitive-control-ready",
            {
              registrationId: "registration:one",
              controlId: "one",
              connectionId: "driver:one",
              driverGeneration: 0,
            },
          ],
          [
            "primitive-control-cutoff",
            {
              registrationId: "registration:one",
              controlId: "one",
              connectionId: "driver:one",
              driverGeneration: 0,
            },
          ],
          [
            "primitive-replies",
            {
              requestId: "request:one",
              registrationId: "registration:one",
              controlId: "one",
              connectionGeneration: "driver:one",
              runId: "run:one",
              turnId: "cell:one",
              callId: 0,
              status: "not_started",
            },
          ],
        ] as const) {
          const response = await handler(
            new Request(`http://goat.test${COMPUTER_USE_LEASE_ROUTE}/${path}`, {
              method: "POST",
              headers: { authorization: "Bearer good" },
              body: JSON.stringify(body),
            }),
            services,
          );
          assert.equal(response.status, 401);
        }
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
  );

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
        assert.equal(
          yield* post(
            "control:paused",
            "good",
            Array.from({ length: 4097 }, () => ({ ...one })),
          ),
          400,
        );
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
  );

  it.effect("a person's input reports, sent many times a second, open no trace spans", () =>
    Effect.gen(function* () {
      const spans: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      const services = Context.make(McpSessionRegistry.McpSessionRegistry, {
        resolve: () =>
          Effect.succeed({ thread: { threadId } }).pipe(
            Effect.withSpan("McpSessionRegistry.resolve"),
          ),
      } as unknown as McpSessionRegistry.McpSessionRegistry["Service"]).pipe(
        Context.add(ComputerUseLeases.ComputerUseLeases, {
          humanInput: () =>
            Effect.succeed("agents" as const).pipe(Effect.withSpan("ComputerUseLeases.humanInput")),
        } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]),
        Context.add(Tracer.Tracer, tracer),
        Context.add(HttpMiddleware.TracerDisabledWhen, untracedRequest),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(reportLayer, { disableLogger: true });
      const status = yield* Effect.promise(async () => {
        const response = await handler(
          new Request("http://127.0.0.1" + COMPUTER_USE_LEASE_ROUTE, {
            method: "POST",
            headers: { authorization: "Bearer good" },
            body: JSON.stringify({ controlId: "one", humanInput: { source: "pointer", at: 0 } }),
          }),
          services,
        );
        return response.status;
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
      assert.equal(status, 202);
      assert.deepEqual(spans, []);
    }),
  );

  it.effect("a proxy's driver ending and first answer reach the host's connection record", () =>
    Effect.gen(function* () {
      const connections = yield* ComputerUseAgentConnections.make;
      const services = Context.make(McpSessionRegistry.McpSessionRegistry, {
        resolve: (token: string) =>
          Effect.succeed(token === "good" ? { thread: { threadId } } : undefined),
      } as unknown as McpSessionRegistry.McpSessionRegistry["Service"]).pipe(
        Context.add(
          ComputerUseLeases.ComputerUseLeases,
          {} as unknown as ComputerUseLeases.ComputerUseLeases["Service"],
        ),
        Context.add(ComputerUseAgentConnections.ComputerUseAgentConnections, connections),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(reportLayer, { disableLogger: true });
      const post = (driverEnded: unknown, token = "good") =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://127.0.0.1" + COMPUTER_USE_LEASE_ROUTE, {
              method: "POST",
              headers: { authorization: "Bearer " + token },
              body: JSON.stringify({ driverEnded }),
            }),
            services,
          );
          return response.status;
        });
      yield* Effect.gen(function* () {
        const refused = { reason: "helper_refused", exitCode: 77 };
        assert.equal(yield* post(refused, "stolen"), 401);
        assert.equal(yield* post({ reason: "not_a_reason" }), 400);
        for (let ending = 0; ending < ComputerUseAgentConnections.FAILING_AFTER; ending++)
          assert.equal(yield* post(refused), 204);
        assert.equal((yield* connections.failure)?.reason, "helper_refused");
        assert.equal(yield* post(false), 204);
        assert.isUndefined(yield* connections.failure);
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
  );
});
