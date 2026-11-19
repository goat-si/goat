import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";

const MAX_WAKE_FRAMES = 128;
const MAX_WAKE_CHARACTERS = 4 * 1024 * 1024;
const encodeWakeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type WakeFrameKind = "result" | "thought" | "other";

function frameKind(
  notification: AcpSchema.SessionNotification,
  resultBearing: boolean,
): WakeFrameKind {
  if (resultBearing) return "result";
  const { sessionUpdate } = notification.update;
  return sessionUpdate === "agent_thought_chunk" || sessionUpdate === "agent_thought"
    ? "thought"
    : "other";
}

export function makeAcpWakeBuffer() {
  const frames: Array<{
    notification: AcpSchema.SessionNotification;
    characters: number;
    kind: WakeFrameKind;
  }> = [];
  let totalCharacters = 0;
  const clear = () => {
    frames.length = 0;
    totalCharacters = 0;
  };
  return {
    length: Effect.sync(() => frames.length),
    clear: Effect.sync(clear),
    append: (notification: AcpSchema.SessionNotification, resultBearing: boolean) =>
      Effect.sync(() => {
        const characters = encodeWakeFrame(notification).length;
        if (characters > MAX_WAKE_CHARACTERS) return false;
        const kind = frameKind(notification, resultBearing);
        while (
          frames.length >= MAX_WAKE_FRAMES ||
          totalCharacters + characters > MAX_WAKE_CHARACTERS
        ) {
          const firstThought = frames.findIndex((frame) => frame.kind === "thought");
          const evictionIndex =
            firstThought >= 0 || kind === "thought"
              ? firstThought
              : frames.findIndex((frame) => frame.kind === "other");
          if (evictionIndex < 0) return false;
          const [evicted] = frames.splice(evictionIndex, 1);
          totalCharacters -= evicted?.characters ?? 0;
        }
        frames.push({ notification, characters, kind });
        totalCharacters += characters;
        return true;
      }),
    some: (matches: (notification: AcpSchema.SessionNotification) => boolean) =>
      Effect.sync(() => frames.some(({ notification }) => matches(notification))),
    take: (sessionId: string) =>
      Effect.sync(() => {
        const result = frames.flatMap(({ notification }) =>
          notification.sessionId === sessionId ? [notification] : [],
        );
        clear();
        return result;
      }),
  };
}
