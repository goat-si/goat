import * as Schema from "effect/Schema";
import { ForwardCompatibleOptional, IsoDateTime } from "./baseSchemas.ts";

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

/**
 * What the provider's own probe found when it tried to run the instance's CLI: present when the
 * CLI answered, missing when its command was not found, none when this instance runs no local CLI.
 */
export const ServerProviderCli = Schema.Literals(["present", "missing", "none"]);
export type ServerProviderCli = typeof ServerProviderCli.Type;

/** Absent until a probe ran the CLI, and after one that could not tell; cliCheckedAt is that probe's checkedAt. */
export const serverProviderCliFields = {
  cli: ForwardCompatibleOptional(ServerProviderCli),
  cliCheckedAt: ForwardCompatibleOptional(IsoDateTime),
};
