import type { EnvironmentConnectionPresentation } from "./presentation.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

function publicText(text: string): string {
  let redactResponse = false;
  return (
    text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
        "[redacted]",
      )
      // Consecutive prompts must keep the pending response secret until a non-prompt arrives.
      .split(/\r?\n/u)
      .map((line) => {
        const prompt =
          /askpass|\b(?:password|passphrase)\s*:|\b(?:password|passphrase)\s+for\b[^:]*:|\benter\s+(?:password|passphrase)\b|[\w@.'-]+['’]s\s+(?:password|passphrase)\b/iu.test(
            line,
          );
        if (prompt) {
          redactResponse = true;
          return "[redacted]";
        }
        if (redactResponse && line.trim()) {
          redactResponse = false;
          return "[redacted]";
        }
        return line;
      })
      .join("\n")
      .replace(/^.*\b(?:set-cookie|cookie|authorization)\s*["']?\s*[:=].*$/gimu, "[redacted]")
      // Pairing/login URLs carry credentials in both query strings and fragments.
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu, "[redacted URL]")
      .replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
      .replace(
        /((?:[\w-]*(?:token|password|secret|credential|passphrase|ticket)|pairing[_-]?code|api[_-]?key|askpass[\w-]*)[\s"']*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/giu,
        "$1[redacted]",
      )
      .replace(
        /(--?(?:[\w-]*(?:token|password|secret|credential)|api[_-]?key)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/giu,
        "$1[redacted]",
      )
      .replace(/\b(?:sk-|gh[opusr]_|github_pat_)[A-Za-z0-9_-]+/gu, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
      // Keep only filenames, including for identity paths outside ~/.ssh.
      .replace(
        /((?:IdentityFile|Load key|private key(?: file)?|identity file|-i)(?:[=:]\s*|\s+))(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)/giu,
        (match, prefix: string) =>
          prefix +
          match
            .slice(prefix.length)
            .replace(/.*[\\/]/u, "")
            .replace(/["']/gu, ""),
      )
      .replace(
        /(^|[\s"'=:])(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}[\\/]|\.ssh[\\/])(?:[^\r\n"'<>()[\]\\/]+[\\/])*([^\s"'<>()[\]\\/]+)/gmu,
        "$1$2",
      )
      .trim()
  );
}

export function formatConnectionDiagnostic(input: {
  readonly label: string;
  readonly hostAlias?: string | undefined;
  readonly connection: EnvironmentConnectionPresentation;
  readonly diagnosticTail?: string | undefined;
  readonly appVersion?: string | undefined;
}): string {
  const { connection } = input;
  const detail = connection.failure?.detail ?? connection.error;
  const traceId = connection.failure?.traceId ?? connection.traceId;
  const field = (value: string) => publicText(value).replace(/\s+/gu, " ").slice(0, 2_000);
  const retryAt = connection.retryAt == null ? Option.none() : DateTime.make(connection.retryAt);
  const tail = publicText(input.diagnosticTail ?? "")
    .split(/\r?\n/u)
    .slice(-8)
    .join("\n")
    .slice(-4_000);
  return [
    `Environment: ${field(input.label)}`,
    ...(input.hostAlias ? [`Host: ${field(input.hostAlias)}`] : []),
    `Connection phase: ${connection.phase}`,
    `Classified reason: ${connection.failure ? `${connection.failure.kind} (${connection.failure.reason})` : "none"}`,
    `Last failure: ${detail ? field(detail) : "none"}`,
    `Retry time: ${Option.isSome(retryAt) ? DateTime.formatIso(retryAt.value) : "none"}`,
    ...(traceId ? [`Trace ID: ${field(traceId)}`] : []),
    ...(input.appVersion ? [`App version: ${field(input.appVersion)}`] : []),
    ...(tail ? [`Public diagnostic tail:\n${tail}`] : []),
  ].join("\n");
}
