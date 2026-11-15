import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.String("PATH").pipe(Config.option),
  Path: Config.String("Path").pipe(Config.option),
  path: Config.String("path").pipe(Config.option),
  PATHEXT: Config.String("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

export const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));
