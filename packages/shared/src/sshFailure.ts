// These sentences cross desktop IPC and are also used for runtime status.
// Keep transport diagnostics browser-safe so both consumers use the same rules.
// Mirrors isSshAuthFailure in @goat/ssh/auth, which is Node-only, plus the
// sentence @goat/ssh/tunnel writes when a key-only (agent) login is rejected.
const AUTH_FAILURE_RE =
  /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)|authentication failed|too many authentication failures|Key-based login failed for /iu;
const UNREACHABLE_RE =
  /SSH connection to .+ timed out after \d+ms before authentication began|Connection closed by UNKNOWN port 65535|(?:kex_exchange_identification|ssh_exchange_identification): (?:read: )?Connection (?:closed|reset) by (?:remote host|peer)|(?:Dial\([^\n]+|dial tcp: lookup [^\n]+): no such host|\bCannot reach .+ over SSH \(|ssh: connect to host \S+ port \d+: |ssh: Could not resolve hostname |Connection timed out during banner exchange|Connection to \S+ port \d+ timed out/u;
const RUNTIME_ACQUISITION_RE =
  /Local gh (?:release download failed \(exit |SSH runtime download timed out)|Public HTTPS (?:release download|SSH runtime archive)/u;
const PROXY_CLOSED_RE =
  /Connection closed by UNKNOWN port 65535|(?:kex_exchange_identification|ssh_exchange_identification):/iu;
const TAILSCALE_STOPPED_RE =
  /^(?:.*?: )?failed to connect to local Tailscale(?:d| daemon)\b|^(?:Tailscale proxy status: )?Tailscale is (?:stopped|not running)\.?$|^is Tailscale running\?/iu;
const TAILSCALE_LOGGED_OUT_RE =
  /^(?:Tailscale proxy status: |tailscale: )?(?:logged out\.|not logged in\.|NeedsLogin)$/iu;
const TAILSCALE_APPROVAL_RE =
  /^Tailscale proxy status: Machine is not yet approved by tailnet admin\.$/u;
const PROXY_SPAWN_RE = /^posix_spawn(?:p)?: No such file or directory$/iu;
const PROXY_SHELL_RE =
  /^(?:(?:\S*\/)?(?:ba|da|z|k|c|fi)?sh): ?(?:(?:line )?\d+: ?)?(?:[^:\r\n]+: (?:command not found|not found|No such file or directory)|no such file or directory: [^\r\n]+)$/iu;
const TIMEOUT_HEADLINE_RE =
  /^(?:SSH authentication timed out for .+ after \d+ms\.|SSH connection to .+ timed out after \d+ms before authentication began\.|(?:Remote SSH command|GOAT runtime (?:install\/download|launch)|GOAT pairing) on .+ timed out after \d+ms\.)/u;

export const isSshRuntimeAcquisitionFailure = (message: string): boolean =>
  RUNTIME_ACQUISITION_RE.test(message);

export function sshAuthenticationFailure(message: string) {
  if (isSshRuntimeAcquisitionFailure(message)) return undefined;
  return message.split(/\r?\n/u).find((line) => AUTH_FAILURE_RE.test(line));
}

export const isSshHostUnreachable = (message: string): boolean =>
  !isSshRuntimeAcquisitionFailure(message) && UNREACHABLE_RE.test(message);

export function sshLocalProxyFailure(message: string) {
  if (isSshRuntimeAcquisitionFailure(message)) return undefined;
  const lines = message.split(/\r?\n/u);
  const loggedOut = lines.find((line) => TAILSCALE_LOGGED_OUT_RE.test(line));
  const approval = lines.find((line) => TAILSCALE_APPROVAL_RE.test(line));
  const stopped = lines.find((line) => TAILSCALE_STOPPED_RE.test(line));
  // A login-shell profile can print the same shell error after successful SSH
  // authentication. Only a proxy closure establishes a local execution failure.
  const missing =
    lines.find((line) => PROXY_SPAWN_RE.test(line)) ??
    (PROXY_CLOSED_RE.test(message) ? lines.find((line) => PROXY_SHELL_RE.test(line)) : undefined);
  const diagnostic = loggedOut ?? approval ?? stopped ?? missing;
  if (diagnostic === undefined) return undefined;
  const fix =
    loggedOut !== undefined
      ? "Sign in to Tailscale on this machine, then reconnect."
      : approval !== undefined
        ? "Ask your Tailscale administrator to approve this machine, then reconnect."
        : stopped !== undefined
          ? "Tailscale is not running on this machine. Start Tailscale, then reconnect."
          : "The local SSH ProxyCommand could not start. Install its executable or fix its path in SSH configuration, then reconnect.";
  return { diagnostic, fix };
}

export function sshFailureDiagnostic(message: string, stderr: string) {
  const headline = message.split(/\r?\n/u)[0] ?? "";
  if (TIMEOUT_HEADLINE_RE.test(headline)) return headline;
  return (
    sshLocalProxyFailure(stderr)?.diagnostic ??
    sshAuthenticationFailure(stderr) ??
    stderr
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ??
    message
  );
}
