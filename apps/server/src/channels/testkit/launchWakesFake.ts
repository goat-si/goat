import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ChannelLaunchWakes, type LaunchWakeWatch } from "../channelLaunchedResults.ts";

const byWorld = new WeakMap<object, Map<string, LaunchWakeWatch>>();

/** One harness's launch watches by launched thread; a thread with none has no wake coming. */
export const launchWatchesOf = (world: object) => {
  const known = byWorld.get(world);
  if (known !== undefined) return known;
  const watches = new Map<string, LaunchWakeWatch>();
  byWorld.set(world, watches);
  return watches;
};

export const fakeLaunchWakes = (world: object) =>
  Layer.succeed(
    ChannelLaunchWakes,
    ChannelLaunchWakes.of({
      watch: (_launcher, threadId) => Effect.succeed(launchWatchesOf(world).get(threadId) ?? null),
    }),
  );
