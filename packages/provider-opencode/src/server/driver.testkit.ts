import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

export const serverStarts: Array<string> = [];
export const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );

export const noHttp = HttpClient.make(() =>
  Effect.die("A local binary must not be probed over HTTP"),
);
