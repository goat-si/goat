import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { HttpClientRequest } from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest of bytes already read.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import { readAttachmentExactly } from "../fleet/admission/PlacementDigest.ts";
import type { PlacementArgument } from "../fleet/admission/PlacementKey.ts";
import type { ChatFileAttachment, ChatImageAttachment } from "@goat/contracts";
import { PLACEMENT_UNSUPPORTED, SshRemoteDispatchError } from "./dispatchFailure.ts";

export type { PlacementArgument };

/**
 * A placed launch over SSH dispatch: the remote admits it itself, and every retry of the key is
 * one launch. It is sent only when the launching session's own fresh listing declares placement.
 */
const decodeRemoteThread = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: ThreadId, runId: Schema.optional(Schema.NullOr(Schema.String)) }),
);

/** Never the cached declarations: they prove nothing about the session this launch uses. */
export const refuseUndeclared = (
  placement: PlacementArgument | undefined,
  fresh: { readonly declared: ReadonlySet<string> } | null | undefined,
  alias: string,
) =>
  placement === undefined || fresh?.declared.has("placement") === true
    ? Effect.void
    : Effect.fail(
        new SshRemoteDispatchError({
          reason: "remote_refused",
          remoteClassification: PLACEMENT_UNSUPPORTED,
          launchMayHaveStarted: false,
          message: `GOAT on ${alias} does not admit placed launches, so this work is not placed there.`,
        }),
      );

export const launchArguments = (placement: PlacementArgument | undefined) =>
  placement === undefined ? {} : { placement };

/** The launch acknowledgement; a placed launch must also say the remote admitted it. */
export const decodeLaunched = (
  raw: unknown,
  placement: PlacementArgument | undefined,
  alias: string,
) =>
  decodeRemoteThread(raw).pipe(
    Effect.mapError(
      () =>
        new SshRemoteDispatchError({
          reason: "remote_refused",
          launchMayHaveStarted: true,
          message:
            "The remote launch returned no thread acknowledgement; inspect its threads before retrying.",
        }),
    ),
    Effect.filterOrFail(
      () =>
        placement === undefined ||
        (raw as { readonly placement?: { readonly outcome?: unknown } } | null)?.placement
          ?.outcome === "started",
      () =>
        new SshRemoteDispatchError({
          reason: "remote_refused",
          launchMayHaveStarted: true,
          message: `GOAT on ${alias} answered a placed launch without admitting it; its outcome is unknown.`,
        }),
    ),
  );

/**
 * The upload body. A placed attempt uploads exactly the bytes its key was frozen with: they are read
 * once, checked against the frozen digest, and sent from memory, so the file cannot change between.
 */
export const attachmentBody = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attachment: ChatImageAttachment | ChatFileAttachment,
  expectedSha256: string | undefined,
) =>
  expectedSha256 === undefined
    ? Effect.succeed(
        HttpClientRequest.bodyStream(fileSystem.stream(path), {
          contentType: attachment.mimeType,
          contentLength: attachment.sizeBytes,
        }),
      )
    : readAttachmentExactly(fileSystem, path, attachment).pipe(
        Effect.flatMap((bytes) =>
          bytes !== null &&
          NodeCrypto.createHash("sha256").update(bytes).digest("hex") === expectedSha256
            ? Effect.succeed(HttpClientRequest.bodyUint8Array(bytes, attachment.mimeType))
            : Effect.fail(
                new SshRemoteDispatchError({
                  reason: "invalid_request",
                  launchMayHaveStarted: false,
                  message: `Attachment '${attachment.name}' changed since this placement was made, so nothing was sent.`,
                }),
              ),
        ),
      );
