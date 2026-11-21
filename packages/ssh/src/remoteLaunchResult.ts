import {
  SshRuntimePendingReplacementSchema,
  type SshRuntimePendingReplacement,
} from "@goat/contracts";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Schema from "effect/Schema";
import { decodeRemoteJsonOutput, shellSingleQuote } from "./remoteRuntime.ts";

const RemoteLaunchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    serverKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
    selectedVersion: Schema.String,
    refresh: Schema.optionalKey(Schema.Literal("replaced")),
    pending: Schema.optionalKey(SshRuntimePendingReplacementSchema),
  }),
  Schema.Struct({ status: Schema.Literal("pending"), pending: SshRuntimePendingReplacementSchema }),
]);

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));

export const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

export function buildRemoteContendedOutput(
  pending: Pick<SshRuntimePendingReplacement, "replacement" | "requestedVersion" | "liveVersion">,
) {
  const fields = JSON.stringify({ reason: "contended", ...pending }).slice(1, -1);
  return `lock_pending_fields=${shellSingleQuote(fields)}
if [ "$LOCK_DETAIL" = recovery-stale ]; then lock_pending_fields="$lock_pending_fields,"'"detail":"recovery-stale"'; fi
printf '{"status":"pending","pending":{%s}}\\n' "$lock_pending_fields"`;
}
