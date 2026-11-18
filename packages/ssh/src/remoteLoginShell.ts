import { shellSingleQuote } from "./remoteRuntime.ts";

export function remoteLoginLaunchArgs(stateKey: string) {
  const launch = `case "\${SHELL##*/}" in
  bash|zsh|ksh|fish|nu)
    case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *)
      exec "$SHELL" -l -c ${shellSingleQuote(`exec sh -s -- ${shellSingleQuote(stateKey)}`)}
    esac ;;
esac
exec "$@"`;
  return ["sh", "-ec", shellSingleQuote(launch), "sh", "sh", "-l", "-s", "--", stateKey];
}
