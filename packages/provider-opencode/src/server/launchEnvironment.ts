import type { ProviderInstanceEnvironment } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const LaunchEnvironment = Context.Reference<NodeJS.ProcessEnv | undefined>(
  "@goat/provider-opencode/LaunchEnvironment",
  { defaultValue: () => undefined },
);

export const currentLaunchEnvironment = Effect.fn("OpenCode.currentLaunchEnvironment")(function* (
  fallback: Effect.Effect<NodeJS.ProcessEnv>,
) {
  const environment = yield* LaunchEnvironment;
  if (environment !== undefined) return environment;
  return yield* fallback;
});

export const makeCurrentLaunchEnvironment = (
  environment: ProviderInstanceEnvironment,
  host: NodeJS.ProcessEnv,
  home: string,
) =>
  currentLaunchEnvironment(
    Effect.suspend(() => mergeProviderInstanceEnvironment(environment, host)).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.map((env) => ({ ...env })),
    ),
  );
