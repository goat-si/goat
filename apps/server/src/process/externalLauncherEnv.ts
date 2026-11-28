import * as HostProcess from "@goat/shared/HostProcess";
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

const BrowserLaunchEnvConfig = Config.all({
  SYSTEMROOT: Config.String("SYSTEMROOT").pipe(Config.option),
  windir: Config.String("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.String("WSL_INTEROP").pipe(Config.option),
  SSH_CONNECTION: Config.String("SSH_CONNECTION").pipe(Config.option),
  SSH_TTY: Config.String("SSH_TTY").pipe(Config.option),
  container: Config.String("container").pipe(Config.option),
  DISPLAY: Config.String("DISPLAY").pipe(Config.option),
  WAYLAND_DISPLAY: Config.String("WAYLAND_DISPLAY").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const CommandLookupEnvConfig = Config.all({
  PATH: Config.String("PATH").pipe(Config.option),
  Path: Config.String("Path").pipe(Config.option),
  path: Config.String("path").pipe(Config.option),
  PATHEXT: Config.String("PATHEXT").pipe(Config.option),
  HOME: Config.String("HOME").pipe(Config.option),
  LOCALAPPDATA: Config.String("LOCALAPPDATA").pipe(Config.option),
  ProgramFiles: Config.String("ProgramFiles").pipe(Config.option),
  ProgramW6432: Config.String("ProgramW6432").pipe(Config.option),
  XDG_DATA_HOME: Config.String("XDG_DATA_HOME").pipe(Config.option),
  "ProgramFiles(x86)": Config.String("ProgramFiles(x86)").pipe(Config.option),
}).pipe(Config.map(compactEnv));

export const readBrowserLaunchEnv = BrowserLaunchEnvConfig.pipe(Effect.orElseSucceed(() => ({})));
export const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

// External Electron apps must start as applications even when GOAT's server runs in Electron's Node mode.
export const readExternalLaunchEnv = HostProcess.Environment.pipe(
  Effect.map(({ ELECTRON_RUN_AS_NODE: _runAsNode, ...env }) => env),
);
