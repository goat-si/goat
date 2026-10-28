// @effect-diagnostics nodeBuiltinImport:off -- The standalone Linux helper uses a Promise API.
import * as NodeChildProcess from "node:child_process";

const MAX_IN_FLIGHT_PROBES = 32;

export function makeGnomeShellVersionReader() {
  const flights = new Map<string, Promise<string | null>>();
  return (environment: NodeJS.ProcessEnv): Promise<string | null> => {
    const key = JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
    const active = flights.get(key);
    if (active) return active;
    if (flights.size >= MAX_IN_FLIGHT_PROBES) {
      return Promise.reject(new Error("GNOME version probe admission is full."));
    }
    const result = new Promise<string | null>((resolve) => {
      NodeChildProcess.execFile(
        "gnome-shell",
        ["--version"],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 64 * 1024,
          env: environment,
          killSignal: "SIGKILL",
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    }).catch(() => null);
    flights.set(key, result);
    void result.finally(() => {
      if (flights.get(key) === result) flights.delete(key);
    });
    return result;
  };
}
