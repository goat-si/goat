// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const MAX_SSE_EVENT_SIZE = 8 * 1024 * 1024;

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let line = "";
  let dataLines: string[] = [];
  let eventSize = 0;
  let afterCR = false;
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    let start = 0;
    if (afterCR && text.length > 0) {
      if (text[0] === "\n") start = 1;
      afterCR = false;
    }
    while (start < text.length) {
      const next = text.slice(start).search(/[\r\n]/u);
      const end = next === -1 ? text.length : start + next;
      const length = end - start;
      eventSize += length;
      if (eventSize > MAX_SSE_EVENT_SIZE) throw new Error("SSE event exceeds the maximum size");
      line += text.slice(start, end);
      if (next === -1) break;
      if (line.length === 0) {
        const data = dataLines.join("\n");
        dataLines = [];
        eventSize = 0;
        if (data.length > 0) yield data;
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
      line = "";
      const isCR = text[end] === "\r";
      start = end + 1;
      if (isCR && start === text.length) afterCR = true;
      else if (isCR && text[start] === "\n") start += 1;
    }
  }
}

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const contentType = response.headers.get("content-type") ?? "";
  const separator = contentType.indexOf(";");
  const mediaType = (separator < 0 ? contentType : contentType.slice(0, separator)).trim();
  if (mediaType.toLowerCase() === "text/event-stream") {
    return Stream.fromAsyncIterable(sseDataLines(response), onError).pipe(
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })),
    );
  }
  return Stream.unwrap(
    Effect.tryPromise({ try: () => response.text(), catch: onError }).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: onError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}
