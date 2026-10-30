import { assert, describe, it } from "@effect/vitest";
import {
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
  type ComputerUsePrimitiveRequest,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/http";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LEASE_END_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import { active, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { postReservation, type ReservationPost } from "./ComputerUseLeaseProxyReservation.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const decodeCall = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerUseCallReservation));
const encodeAdmission = Schema.encodeSync(Schema.fromJsonString(ComputerUseCallAdmission));

const READS = new Set(["list_apps", "get_window_state"]);
const admit = (call: ComputerUseCallReservation): ComputerUseCallAdmission =>
  call.action === "reserve"
    ? { status: "admitted", reservationId: READS.has(call.name) ? null : `ticket:${call.callId}` }
    : call.action === "validate"
      ? {
          status: "admitted",
          reservationId: call.reservationId,
          permissions: { validUntilMillis: 1_800_000 },
        }
      : { status: "released" };

interface Held {
  readonly call: ComputerUseCallReservation;
  readonly answer: (status: number, admission?: ComputerUseCallAdmission) => void;
}

/**
 * The lease route's calls endpoint over the proxy CLI's own reservation client. It answers at
 * once until `slow` is set; then reserve requests wait in `held` for the test to answer.
 */
const server = Effect.fn(function* () {
  const held = yield* Queue.unbounded<Held>();
  const state = { slow: false };
  const post: ReservationPost = (body, signal) =>
    new Promise((resolve, reject) => {
      const call = decodeCall(body);
      signal.addEventListener("abort", () => reject(signal.reason));
      const answer = (status: number, admission?: ComputerUseCallAdmission) =>
        resolve(
          new Response(admission === undefined ? null : encodeAdmission(admission), { status }),
        );
      if (state.slow && call.action === "reserve") Queue.offerUnsafe(held, { call, answer });
      else answer(200, admit(call));
    });
  return { state, held: Queue.take(held), post };
});

const primitive = (
  requestId: string,
  connectionGeneration: string,
  deadlineMillis: number,
  tool: string,
  args: ComputerUsePrimitiveRequest["args"],
): ComputerUsePrimitiveRequest => ({
  state: "primitive-request",
  requestId,
  registrationId: "registration:one",
  controlId: "control:one",
  connectionGeneration,
  runId: "run:one",
  turnId: "cell:two",
  callId: 0,
  deadlineMillis,
  tool,
  args,
});
const WINDOW = { pid: 42, window_id: 7 };

/** A click the first driver never answers, past its 3 s cap: GOAT replaces that driver. */
const replaced = Effect.fn(function* () {
  const goat = yield* server();
  const h = yield* harness({
    humanInput: true,
    reservation: (call) => postReservation(goat.post, call),
  });
  yield* h.push(active());
  const first = yield* h.driverStarted;
  yield* h.sendPrimitive(primitive("click:stuck", first.connectionId, 3_000, "click", WINDOW));
  yield* h.nextToDriver;
  yield* TestClock.adjust(4_000);
  const cutOff = yield* h.primitiveReply;
  const second = yield* h.driverStarted;
  goat.state.slow = true;
  /** The next call's outcome: what the driver was sent, or the proxy's answer if it was not. */
  const outcome = Effect.raceFirst(
    h.nextToDriver.pipe(Effect.map((sent) => ({ sent }) as const)),
    h.primitiveReply.pipe(Effect.map((reply) => ({ reply }) as const)),
  );
  return { h, goat, cutOff, second, outcome };
});

const structured = (reply: { readonly result?: unknown }) =>
  (reply.result as { structuredContent: Record<string, unknown>; content: [{ text: string }] })
    .structuredContent;
const text = (reply: { readonly result?: unknown }) =>
  (reply.result as { content: ReadonlyArray<{ text: string }> }).content[0]?.text ?? "";

describe("ComputerUseLeaseProxy after a driver replacement while GOAT answers slowly", () => {
  it.effect(
    "regression: the next cell's read and write run on the new driver when their reservations are answered 5 s late",
    () =>
      Effect.gen(function* () {
        const { h, goat, cutOff, second, outcome } = yield* replaced();
        assert.equal(cutOff.status, "unknown_outcome");
        assert.equal(structured(cutOff).detail, "helper_restarted");
        assert.include(structured(cutOff).safety as object, { possibleCommit: true });

        yield* h.sendPrimitive(
          primitive("read:next", second.connectionId, 60_000, "get_window_state", WINDOW),
        );
        const read = yield* goat.held;
        yield* TestClock.adjust(5_000);
        read.answer(200, admit(read.call));
        const readOutcome = yield* outcome;
        if ("reply" in readOutcome)
          return assert.fail(`read refused: ${String(structured(readOutcome.reply).detail)}`);
        assert.deepEqual(readOutcome.sent.params, { name: "get_window_state", arguments: WINDOW });
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: readOutcome.sent.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");

        yield* h.sendPrimitive(
          primitive("click:next", second.connectionId, 60_000, "click", WINDOW),
        );
        const write = yield* goat.held;
        yield* TestClock.adjust(5_000);
        write.answer(200, admit(write.call));
        const writeOutcome = yield* outcome;
        if ("reply" in writeOutcome)
          return assert.fail(`write refused: ${String(structured(writeOutcome.reply).detail)}`);
        assert.deepEqual(writeOutcome.sent.params, { name: "click", arguments: WINDOW });
        assert.equal(h.drivers.length, 2);
      }),
  );

  it.effect(
    "a reservation GOAT never answers is refused as reconnecting with its cause, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { h, goat, second, outcome } = yield* replaced();
        yield* h.sendPrimitive(
          primitive("read:next", second.connectionId, 60_000, "get_window_state", WINDOW),
        );
        yield* goat.held;
        yield* TestClock.adjust(30_000);
        const answered = yield* outcome;
        if (!("reply" in answered)) return assert.fail("the read reached the driver");
        assert.equal(answered.reply.status, "not_started");
        assert.equal(structured(answered.reply).detail, "reconnecting");
        assert.include(text(answered.reply), "did not answer");
        assert.include(text(answered.reply), "nothing was sent");
      }),
  );

  it.effect("a session GOAT no longer accepts is refused as unauthorized and says so", () =>
    Effect.gen(function* () {
      const { h, goat, second, outcome } = yield* replaced();
      yield* h.sendPrimitive(
        primitive("read:next", second.connectionId, 60_000, "get_window_state", WINDOW),
      );
      (yield* goat.held).answer(401);
      const answered = yield* outcome;
      if (!("reply" in answered)) return assert.fail("the read reached the driver");
      assert.equal(structured(answered.reply).detail, "unauthorized");
      assert.equal(text(answered.reply), LEASE_END_MESSAGES.unauthorized);
    }),
  );

  it.effect(
    "a reservation the server cannot judge answers 503, which the proxy reports as unanswered",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:one");
        const invocation: McpThreadInvocationScope = {
          environmentId: EnvironmentId.make("environment:test"),
          capabilities: new Set(),
          issuedAt: 0,
          requestNamespace: "test",
          client: undefined,
          thread: {
            threadId,
            providerSessionId: "provider:test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        };
        const routes = LeaseRoute.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.ServerSettingsService.layerTest({}),
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(token === "fixture" ? invocation : undefined),
              }),
              Layer.mock(ComputerUseLeases.ComputerUseLeases)({
                foregroundApprovalEpoch: Effect.die("unused"),
                proxy: undefined,
                callReservation: () =>
                  Effect.fail(new ComputerUseLeases.ComputerUseLeaseError({ cause: "db busy" })),
              }),
            ),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) => Effect.promise(() => web.dispose()),
        );
        const call: ComputerUseCallReservation = {
          action: "reserve",
          controlId: "control:one",
          connectionId: "driver:1",
          callId: "one",
          name: "get_window_state",
          args: WINDOW,
          interruptions: 0,
          idleEpoch: 0,
        };
        const decision = yield* postReservation(
          (body, signal) =>
            app.handler(
              new Request("http://goat.test/api/computer-use/lease/calls", {
                method: "POST",
                body,
                signal,
                headers: { "content-type": "application/json", authorization: "Bearer fixture" },
              }),
            ),
          call,
        );
        assert.deepEqual(decision, { status: "refused", detail: "reconnecting" });
      }).pipe(Effect.scoped),
  );
});
