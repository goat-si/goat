import {
  isSshHostUnreachable,
  sshAuthenticationFailure,
  isSshRuntimeAcquisitionFailure,
  sshLocalProxyFailure,
} from "@goat/shared/sshFailure";
import {
  ConnectionBlockedError,
  ConnectionAttemptSuperseded,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

const HOST_KEY_FAILURE_RE =
  /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for \S+ has changed|Managed SSH host key changed|No \S+ host key is known for .+ and you have requested strict checking/iu;
// The desktop's own prompt endings (DesktopSshPasswordPrompts): dismissed,
// timed out, expired, the window closed, or the prompt service stopped; also
// runSshCommand's authentication-stage timeout. Retrying would reopen the prompt.
const CANCELLED_RE =
  /^SSH (?:authentication|setup)(?: was)? cancel|^SSH authentication timed out for |^SSH password prompt (?:service stopped|expired)/iu;
// The remote runtime refused this client and will keep refusing until someone
// updates this app or stops the remote server (see the launch script in
// @goat/ssh/tunnel). Retrying on a timer cannot fix it.
const RUNTIME_REFUSAL_RE =
  /runs a newer GOAT|Remote runtime is newer than this app|is incompatible; it was left running|cannot be ordered against this app|was started by an older app that cannot hand over ownership without draining|can only be replaced by a GOAT release|Cannot verify remote version ordering/u;

function cleanMessage(cause: unknown): string {
  const raw =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : String(cause);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^(?:(?:Ssh[A-Za-z]*Error|Error):\s*)+/u, "")
    .trim();
}

/**
 * Classifies a failure from preparing a desktop SSH connection. The bridge
 * carries only the message across IPC, so this reads the sentences
 * `@goat/ssh` writes.
 *
 * - An unreachable host (asleep, off the network, VPN down) is
 *   `host-unreachable`. It retries quietly on the normal backoff.
 * - Rejected credentials, an unverifiable host key, and a runtime that refuses
 *   this client are blocked. They wait for the user, a wake, or a network change
 *   instead of retrying on a timer.
 * - Local proxy configuration failures are marked for a quiet periodic check.
 * - Anything else is a transient failure of the remote side.
 */
export function sshPreparationFailure(cause: unknown): ConnectionAttemptError {
  const message = cleanMessage(cause);
  if (
    (typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "SshEnsureSupersededError") ||
    message === "SSH preparation superseded by a newer connection intent." ||
    message === "SSH connection was cancelled."
  ) {
    return new ConnectionAttemptSuperseded({ reason: "superseded", detail: message });
  }
  if (message === "SSH runtime preparation exceeded its 15-minute limit.") {
    return new ConnectionTransientError({
      reason: "timeout",
      detail: message,
      sshPreparationTimedOut: true,
    });
  }
  if (CANCELLED_RE.test(message)) {
    return new ConnectionBlockedError({ reason: "authentication", detail: message });
  }
  const acquisition = isSshRuntimeAcquisitionFailure(message);
  const proxy = sshLocalProxyFailure(message);
  if (proxy !== undefined) {
    return new ConnectionBlockedError({
      reason: "configuration",
      localProxyUnavailable: true,
      detail: `${proxy.fix} (${message})`,
    });
  }
  if (!acquisition && HOST_KEY_FAILURE_RE.test(message)) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail: `SSH could not verify this host's key. Forget the host and add it again to review its fingerprint. (${message})`,
    });
  }
  if (sshAuthenticationFailure(message) !== undefined) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: `The SSH host rejected the login. Check your SSH key or ssh-agent, then reconnect. (${message})`,
    });
  }
  // The tunnel opened but the server answered too late; say so instead of
  // reading like a stopped server.
  if (message.includes("(high latency)")) {
    return new ConnectionTransientError({
      reason: "network",
      detail:
        "The SSH host is reachable, but the network to it is too slow (high latency) for GOAT to finish connecting. Retrying.",
    });
  }
  if (isSshHostUnreachable(message)) {
    return new ConnectionTransientError({ reason: "host-unreachable", detail: message });
  }
  if (RUNTIME_REFUSAL_RE.test(message)) {
    return new ConnectionBlockedError({ reason: "configuration", detail: message });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}
