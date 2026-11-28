import {
  AcpRegistryOperationError,
  type AcpRegistryProbeAuthMethod,
  type AcpRegistryUrlAuthAction,
} from "@goat/contracts";
import { isMissingProbeToolResult } from "@goat/provider-core/server/snapshotProbe";
import type * as EffectAcpErrors from "effect-acp/errors";

export const MAX_ID_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1_024;

export const boundedText = (value: string, maximumLength: number): string =>
  value.trim().slice(0, maximumLength);

export const boundedOpaqueValue = (value: string, maximumLength: number): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= maximumLength ? value : undefined;

export function normalizeAcpRegistryWebUrl(value: string): string | undefined {
  if (value.length > 2_048 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

export function acpRegistryProbeFailure(
  error: EffectAcpErrors.AcpError,
  authMethods: ReadonlyArray<AcpRegistryProbeAuthMethod> = [],
  authAction?: AcpRegistryUrlAuthAction,
): AcpRegistryOperationError {
  if (
    error._tag === "AcpProcessExitedError" &&
    isMissingProbeToolResult({ code: error.code ?? 1, stdout: "", stderr: error.stderr ?? "" })
  ) {
    return new AcpRegistryOperationError({
      reason: "runner_unavailable",
      message: "The ACP agent executable is not installed or not available.",
      cause: error,
    });
  }
  const detail = error._tag === "AcpTransportError" && error.detail ? error.detail : error.message;
  const authenticationFailed =
    (error._tag === "AcpRequestError" && error.code === -32000) ||
    /\b(?:authenticat(?:e|ed|es|ing|ion)|credentials?|log(?:[\s-]+)?in)\b/iu.test(detail);
  return new AcpRegistryOperationError({
    reason: authenticationFailed ? "authentication_failed" : "probe_failed",
    message: authenticationFailed
      ? "The ACP agent could not complete authentication."
      : "The ACP agent could not create a test session.",
    cause: error,
    ...(authMethods.length > 0 ? { authMethods } : {}),
    ...(authAction === undefined ? {} : { authAction }),
  });
}
