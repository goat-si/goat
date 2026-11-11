/**
 * OpenCodex's own words for a refused command, limited to sentences OpenCodex is known to print
 * (lidge-jun/opencodex origin/dev b114822057). Free text can carry a remote hint or a secret, so
 * only a recognized constant is returned, never the input.
 */
const PHASE_LABELS: ReadonlyArray<string> = [
  "remote port selection",
  "remote ocx-child planting",
  "local ocx-child binary resolution",
  "Child preflight",
  "Child port availability preflight",
  "Child Codex config ownership check",
  "Child restart preflight",
  "Child curl preflight",
  "Home setup",
  "Child enrollment",
  "Child restart",
  "Child relay verification",
  "Child runtime role verification",
  "remote platform verification",
  "remote OpenCodex discovery",
];
const RECOVERY: ReadonlyArray<string> = [
  "Run ocx disconnect and ocx restart on the Child before retrying.",
  "Run ~/.cache/opencodex/bin/ocx-child detach on the Child before retrying.",
];
const SENTENCES: ReadonlyArray<string> = [
  "The remote shell cannot run this Remote Link workflow. Update OpenCodex on Home and check PowerShell on the Child.",
  "The target port on the Child is already in use by another process; no Child files were modified.",
  "The Child's ocx config show --json output exceeded the Remote Link preflight limit; trim the Child's saved configuration and retry.",
  "The Child's ~/.codex/config.toml is already managed by another model provider or custom base URL; no Child files were modified.",
  "Refusing to restart because the running proxy identity could not be attested. Run `ocx status` to inspect the intended proxy.",
  "The running proxy predates process-bound restart support; no unsafe fallback was attempted.",
  "This CLI is older than the running proxy (or versions cannot be compared). Use the newer installation's ocx to restart; check `which -a ocx` and run `ocx status`. No changes were made.",
  "The proxy home or lifecycle ownership could not be verified. Run `ocx status`; if a service owns the proxy, use its installation's `ocx service restart`, otherwise use the owning app or supervisor. No changes were made.",
  "Restart not performed; the running client runtime was kept. Its background service owns it: run `ocx service restart`.",
  "Restart not performed; the running client runtime was kept. The OpenCodex desktop app owns it: restart it from the app.",
  "Proxy restart request could not be confirmed; no fallback stop/start was attempted. Run `ocx status` to inspect ownership and runtime state.",
  "Proxy restart was accepted, but no identity-verified replacement became healthy in time. Run `ocx status` to inspect the replacement.",
  "Proxy was not running and the fallback start did not become healthy. Run `ocx status` to inspect startup state.",
];
/** A sentence that ends in a variable part matches by its fixed start, which alone is returned. */
const PREFIXES: ReadonlyArray<string> = [
  "The proxy's package files are unsettled. Wait for the install to finish, then run `ocx restart`.",
];
const CODES: ReadonlySet<string> = new Set([
  "client_catalog_changed_during_disconnect",
  "client_catalog_ownership_changed",
  "client_connection_changed",
  "client_disconnect_catalog_context_missing",
  "client_disconnect_completed_owner_reappeared",
  "client_disconnect_expected_owner_changed",
  "client_disconnect_options_changed",
  "client_disconnect_owner_changed",
  "client_disconnect_receipt_changed",
  "client_disconnect_receipt_unsafe",
  "client_rotation_recovery_required",
  "client_sync_unavailable",
  "client_token_changed",
  "desktop_disconnect_after_state_changed",
  "desktop_lifecycle_recovery_required",
  "desktop_lifecycle_unsafe",
]);
const FAILED_DURING = "Remote Link failed during ";
// ocx sync --expect-link prints {"phase":"child_link_mismatch","reason":...} last; reasons are fixed.
const MISMATCH_REASONS: ReadonlySet<string> = new Set([
  "disconnected",
  "invalid_state",
  "disconnect_pending",
  "pending_operation",
  "hub_client",
  "link_client",
  "other_link",
  "other_key",
]);

const mismatch = (text: string): string | undefined => {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const { phase, reason } = value as { phase?: unknown; reason?: unknown };
    return phase === "child_link_mismatch" &&
      typeof reason === "string" &&
      MISMATCH_REASONS.has(reason)
      ? `This machine is not connected over that link (${reason}); nothing was changed.`
      : undefined;
  } catch {
    return undefined;
  }
};

const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u001f\u007f]/gu;

const recognize = (line: string): string | undefined => {
  const linked = mismatch(line.trim());
  if (linked !== undefined) return linked;
  const text = line.replace(/^(?:Error:|❌)\s*/u, "").trim();
  if (CODES.has(text) || SENTENCES.includes(text)) return text;
  const prefix = PREFIXES.find((fixed) => text.startsWith(fixed));
  if (prefix !== undefined) return prefix;
  if (!text.startsWith(FAILED_DURING)) return undefined;
  const rest = text.slice(FAILED_DURING.length);
  const label = PHASE_LABELS.find(
    (candidate) =>
      rest === candidate ||
      (/^[.:]/u.test(rest.slice(candidate.length)) && rest.startsWith(candidate)),
  );
  if (label === undefined) return undefined;
  const recovery = RECOVERY.find((sentence) => rest.endsWith(sentence));
  return `${FAILED_DURING}${label}${recovery === undefined ? "" : `. ${recovery}`}`;
};

export const ocxMessage = (stderr: string): string | undefined => {
  const lines = stderr.split(/\r?\n/u).map((line) => line.replace(ESCAPES, "").trim());
  for (const line of lines.toReversed()) {
    if (line === "") continue;
    const known = recognize(line);
    if (known !== undefined) return known;
  }
  return undefined;
};
