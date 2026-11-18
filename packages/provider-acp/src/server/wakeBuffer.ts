import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";

const MAX_WAKE_FRAMES = 128;
const MAX_WAKE_CHARACTERS = 4 * 1024 * 1024;

export function makeAcpWakeBuffer() {
  const frames: Array<{ notification: AcpSchema.SessionNotification; characters: number }> = [];
  let totalCharacters = 0;
  const clear = () => {
    frames.length = 0;
    totalCharacters = 0;
  };
  return {
    length: Effect.sync(() => frames.length),
    clear: Effect.sync(clear),
    append: (notification: AcpSchema.SessionNotification) =>
      Effect.sync(() => {
        const characters = JSON.stringify(notification).length;
        if (characters > MAX_WAKE_CHARACTERS) return false;
        while (
          frames.length >= MAX_WAKE_FRAMES ||
          totalCharacters + characters > MAX_WAKE_CHARACTERS
        ) {
          totalCharacters -= frames.shift()?.characters ?? 0;
        }
        frames.push({ notification, characters });
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
