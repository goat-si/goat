import { GOAT_RUNTIME_DRAIN_PATH, GOAT_RUNTIME_CONTROL_HEADER } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as RuntimeControl from "./runtimeControl.ts";
import * as RuntimeDrain from "./runtimeDrain.ts";
import * as ServerHttp from "./http.ts";

it.each([
  ["127.0.0.1", "secret", 200],
  ["::1", "secret", 200],
  ["::ffff:127.0.0.1", "secret", 200],
  ["192.0.2.10", "secret", 403],
  ["127.0.0.1", "bad", 403],
  ["127.0.0.1", undefined, 403],
  [undefined, "secret", 403],
] as const)("drain peer %s and token %s yields %i", async (peer, token, status) => {
  let calls = 0;
  const app = ServerHttp.layerRuntimeDrainRoute.pipe(
    Layer.provideMerge(
      Layer.succeed(RuntimeControl.RuntimeControl, { authenticate: (value) => value === "secret" }),
    ),
    Layer.provideMerge(
      Layer.succeed(RuntimeDrain.RuntimeDrain, {
        request: (input) =>
          Effect.sync(() => {
            calls++;
            expect(input.targetVersion).toBe("next");
            return { status: "drained", instanceId: "own", forced: false };
          }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, {
    disableLogger: true,
    middleware: (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* effect.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({ remoteAddress: Option.fromUndefinedOr(peer) }),
          ),
        );
      }),
  });
  try {
    const request = new Request(`http://127.0.0.1${GOAT_RUNTIME_DRAIN_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { [GOAT_RUNTIME_CONTROL_HEADER]: token }),
      },
      body: JSON.stringify({ expectedInstanceId: "own", targetVersion: "next" }),
    });
    const response = await handler(request, Context.empty());
    expect(response.status).toBe(status);
    expect(calls).toBe(status === 200 ? 1 : 0);
    if (status === 200)
      expect(await response.json()).toEqual({
        status: "drained",
        instanceId: "own",
        forced: false,
      });
    if (status === 200) {
      const invalid = await handler(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            expectedInstanceId: "own",
            targetVersion: "next",
            graceSeconds: 301,
          }),
        }),
        Context.empty(),
      );
      expect(invalid.status).toBe(400);
      expect(calls).toBe(1);
    }
  } finally {
    await dispose();
  }
});
