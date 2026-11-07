import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ChannelLaunchWakes } from "../channels/channelLaunchedResults.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";

/** Channel tasks read their launched threads' watches through this, never the store itself. */
export const layer = Layer.effect(
  ChannelLaunchWakes,
  Effect.gen(function* () {
    const watches = yield* LaunchWatchService.LaunchWatchService;
    return ChannelLaunchWakes.of({
      watch: Effect.fn("ChannelLaunchWakes.watch")(function* (launcherThreadId, threadId) {
        const watch = yield* watches
          .find({ launcherThreadId, host: null, threadId })
          .pipe(Effect.orElseSucceed(() => "unreadable" as const));
        return watch === null || watch === "unreadable"
          ? watch
          : {
              detached: watch.detached === true,
              skippedRuns: watch.skippedRuns,
              reportedEnds: watch.reportedEnds,
            };
      }),
    });
  }),
);
