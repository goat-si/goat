import { expect, it } from "@effect/vitest";
import { makeFrameJoiner } from "@goat/shared/socketFrameParts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Socket from "effect/socket/Socket";
import { withSocketFrameParts } from "./socketFrameParts.ts";

it.effect("splits only negotiated server sockets while preserving complete messages", () =>
  Effect.gen(function* () {
    const message = JSON.stringify({ data: "hello😀".repeat(20_000) });
    for (const query of ["", "?frameParts=1"]) {
      const sent: Array<string | Uint8Array> = [];
      const socket = Socket.make({
        reader: Effect.die("not used"),
        writer: Effect.succeed({
          write: (part) =>
            Effect.sync(() => {
              if (typeof part === "string" || part instanceof Uint8Array) sent.push(part);
            }),
          writeAll: (parts) =>
            Effect.sync(() => {
              sent.push(...parts);
            }),
        }),
      });
      const original = HttpServerRequest.fromWeb(new Request(`http://example.test/ws${query}`));
      const request: HttpServerRequest.HttpServerRequest = Object.create(original, {
        upgrade: { value: Effect.succeed(socket) },
      });
      const program = Effect.gen(function* () {
        const active = yield* HttpServerRequest.HttpServerRequest;
        const upgraded = yield* active.upgrade;
        const writer = yield* upgraded.writer;
        yield* writer.write(message);
      });
      yield* withSocketFrameParts(request, program).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.scoped,
      );
      if (!query) expect(sent).toEqual([message]);
      else {
        expect(sent.length).toBeGreaterThan(1);
        const join = makeFrameJoiner();
        expect(sent.map(join).at(-1)).toBe(message);
      }
    }
  }),
);
