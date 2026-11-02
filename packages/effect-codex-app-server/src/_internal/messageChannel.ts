import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexError from "../errors.ts";

export interface CodexAppServerMessageChannel {
  readonly incoming: Stream.Stream<string, CodexError.CodexAppServerError>;
  readonly send: (message: string) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly closed: Effect.Effect<CodexError.CodexAppServerError>;
}

const platformError = (cause: CodexError.CodexAppServerError) =>
  PlatformError.badArgument({ module: "CodexAppServerMessageChannel", method: "transport", cause });

export const makeMessageChannelStdio = (channel: CodexAppServerMessageChannel): Stdio.Stdio => {
  const encoder = new TextEncoder();
  return Stdio.make({
    args: Effect.succeed([]),
    stdin: channel.incoming.pipe(
      Stream.mapEffect((message) =>
        message.includes("\n")
          ? Effect.fail(
              new CodexError.CodexAppServerTransportError({
                operation: "read-input-stream",
                cause: new Error("Message contains a raw newline."),
              }),
            )
          : Effect.succeed(encoder.encode(`${message}\n`)),
      ),
      Stream.mapError(platformError),
    ),
    stdout: () => {
      const decoder = new TextDecoder();
      let pending = "";
      return Sink.forEach((chunk: string | Uint8Array) =>
        Effect.gen(function* () {
          pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            yield* channel.send(line).pipe(Effect.mapError(platformError));
            newline = pending.indexOf("\n");
          }
        }),
      );
    },
    stderr: () => Sink.drain,
  });
};
