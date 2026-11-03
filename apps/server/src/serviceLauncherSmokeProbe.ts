// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeHttp from "node:http";

import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { guardErrors } from "@goat/shared/errorGuards";
import {
  compareRuntimeProtocols,
  type RuntimeProtocolRanges,
} from "@goat/shared/sshRuntimeProtocol";

export const SMOKE_TIMEOUT_MS = 30_000;

/** A wildcard listener answers on loopback of its family; a specific address only on itself. */
export function smokeProbeHostname(host: string | undefined): string {
  if (host === undefined || host === "0.0.0.0" || host === "localhost") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

export function smokeProbe(
  port: number,
  host: string | undefined,
  targetVersion: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const finish = (reason?: string) => {
      clearTimeout(timeout);
      request.destroy();
      resolve(reason);
    };
    const request = guardErrors(
      NodeHttp.get(
        { hostname: smokeProbeHostname(host), port, path: GOAT_ENVIRONMENT_PATH, agent: false },
        (response) => {
          if (response.statusCode !== 200) {
            finish(`http-${response.statusCode}`);
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("error", () => finish("response-error"));
          response.on("end", () => {
            try {
              const descriptor = JSON.parse(body) as {
                serverVersion?: unknown;
                protocol?: RuntimeProtocolRanges;
              } | null;
              if (descriptor?.serverVersion !== targetVersion) return finish("version");
              const protocol = descriptor.protocol;
              // Compare the advertised ranges with themselves: smoke requires valid ranges,
              // not compatibility with the old build embedded in this surviving launcher.
              if (
                protocol === undefined ||
                compareRuntimeProtocols(protocol, { protocol }) !== "compatible"
              ) {
                return finish("protocol");
              }
              finish();
            } catch {
              finish("descriptor");
            }
          });
        },
      ),
      () => finish("request-error"),
    );
    // One deadline covers connection, headers and the entire JSON body, even a trickle.
    const timeout = setTimeout(() => finish("timeout"), SMOKE_TIMEOUT_MS);
  });
}
