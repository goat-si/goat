import { describe, expect, it } from "@effect/vitest";

import { sshPreparationFailure } from "./sshFailure.ts";

const IPC = "Error invoking remote method 'desktop:ensure-ssh-environment': ";

describe("sshPreparationFailure", () => {
  it.each([
    "Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out). Check the network or VPN connection to that host.",
    "Cannot reach mbp over SSH (could not resolve mbp.local: nodename nor servname provided, or not known). Check the network or VPN connection to that host.",
    "Cannot reach mbp over SSH (Connection timed out during banner exchange). Check the network or VPN connection to that host.",
    // The tunnel step passes ssh's own stderr through.
    "ssh: connect to host 192.168.1.20 port 22: Operation timed out",
    "ssh: Could not resolve hostname mbp.local: nodename nor servname provided, or not known",
    "Connection closed by UNKNOWN port 65535",
    "kex_exchange_identification: Connection closed by remote host",
    "ssh_exchange_identification: Connection closed by remote host",
    "kex_exchange_identification: read: Connection reset by peer",
    "dial tcp: lookup fixture.invalid: no such host",
    // A host whose name happens to contain "cancel".
    "Cannot reach cancel-mbp over SSH (192.168.1.20:22: Operation timed out). Check the network or VPN connection to that host.",
  ])("treats a host ssh never reached as unreachable: %s", (message) => {
    const error = sshPreparationFailure(new Error(`${IPC}SshCommandError: ${message}`));
    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "host-unreachable",
      detail: message,
    });
  });

  it.each([
    "julius@100.65.180.100: Permission denied (publickey,password).",
    "Key-based login failed for goat-mbp; agents use only SSH keys or ssh-agent.",
  ])("blocks a rejected login instead of retrying it on a timer: %s", (message) => {
    const error = sshPreparationFailure(new Error(`${IPC}${message}`));
    expect(error._tag).toBe("ConnectionBlockedError");
    expect(error.reason).toBe("authentication");
    expect(error.detail).toContain(message);
  });

  it.each([
    "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
    "Managed SSH host key changed.",
    "No ED25519 host key is known for mbp and you have requested strict checking.",
    "No RSA host key is known for mbp and you have requested strict checking.",
    "Offending ED25519 key in /tmp/SSH runtime archive/known_hosts:3\nHost key verification failed.",
  ])("blocks a host key that no longer verifies: %s", (message) => {
    const error = sshPreparationFailure(new Error(message));
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
    expect(error.detail).toContain("Forget the host");
  });

  it.each([
    "mbp runs a newer GOAT (0.3.0). Update this app from the update button above Settings.",
    "Live GOAT PID=812 port=3773 is incompatible; it was left running. Upgrade with the owning client or reconnect.",
    "Remote runtime GOAT 0.1.0-dev.abc cannot be ordered against this app (GOAT 0.1.0-dev.def); it was left running. Stop it on the remote host when its work is done, then reconnect.",
    "Cannot verify remote version ordering; process was preserved.",
    "Live GOAT PID=812 port=3773 was started by an older app that cannot hand over ownership without draining; it was left running.",
    "Live GOAT PID=812 port=3773 is incompatible; it was left running because it cannot drain for a replacement and this app cannot attach to it.",
  ])("blocks a runtime that refuses this client without disabling it: %s", (message) => {
    // "unsupported" would switch the environment off; this needs a person instead.
    expect(sshPreparationFailure(new Error(message))).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      detail: message,
    });
  });

  it.each([
    "SSH authentication cancelled for jun@mbp.",
    "SSH authentication was cancelled because the app window closed.",
    "SSH authentication timed out for jun@mbp.",
    "SSH password prompt service stopped.",
    "SSH password prompt expired. Try connecting again.",
  ])("keeps a cancelled login blocked until the user reconnects: %s", (message) => {
    expect(sshPreparationFailure(new Error(`${IPC}${message}`))).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
    });
  });

  it("explains a slow tunnel as high latency", () => {
    const error = sshPreparationFailure(
      new Error(
        `${IPC}The SSH tunnel is open, but the GOAT server answered none of 9 checks within 5000ms. The network to this host is too slow (high latency); GOAT will keep retrying.`,
      ),
    );
    expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "network" });
  });

  it("retries other failures as a remote problem, without the IPC prefix", () => {
    // The launch script prints these both for a real identity disagreement and
    // for a live server whose descriptor answered too slowly, so they retry.
    for (const message of [
      "Cannot verify live GOAT PID=812 port=3773: descriptor unavailable or persisted identity disagrees; it may predate GOAT SSH runtime protocol metadata. It was left running, and the runner and ownership files were preserved. If this is your earlier GOAT server, stop it on the remote host (kill 812) and reconnect.",
      "GOAT ownership could not be verified; process and ownership files were preserved.",
      "Live GOAT PID=812 port=3773 cannot drain for a replacement and this app cannot attach to it; it was left running.",
    ]) {
      expect(sshPreparationFailure(new Error(message))).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "remote-unavailable",
      });
    }
    const gh =
      "Local gh release download failed (exit 1; goat 0.3.0 darwin-arm64). Check gh auth status and that the release contains both assets. stderr (last 400 sanitized characters): authentication failed";
    // gh's login, after the SSH login succeeded: not an SSH key problem, bare
    // or inside the launch's wrappers (tunnel.ts).
    for (const message of [
      gh,
      `Cannot prepare GOAT 0.3.0 on mbp: Public HTTPS release download failed and local gh acquisition failed: ${gh} The existing runner and server have been left unchanged.`,
      `Cannot prepare GOAT 0.1.0 on mbp: Public HTTPS release is not published and local gh acquisition failed: ${gh} The existing runner and server have been left unchanged. Supply the requested runtime archive in the local SSH runtime archive directory or a release mirror, then retry.`,
    ]) {
      expect(sshPreparationFailure(new Error(`${IPC}${message}`))).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "remote-unavailable",
        detail: `Could not prepare the SSH environment: ${message}`,
      });
    }
    expect(sshPreparationFailure(new Error(`${IPC}mkdir: Permission denied`))).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "remote-unavailable",
      detail: "Could not prepare the SSH environment: mkdir: Permission denied",
    });
  });
});

describe("local SSH proxy failures", () => {
  it.each([
    ["failed to connect to local Tailscale daemon; is Tailscale running?", "Start Tailscale"],
    ["Tailscale is stopped.", "Start Tailscale"],
    ["failed to connect to local tailscaled; is it running?", "Start Tailscale"],
    ["tailscale: logged out.", "Sign in to Tailscale"],
    ["Tailscale proxy status: Machine is not yet approved by tailnet admin.", "approve"],
    ["/bin/sh: cloudflared: not found", "ProxyCommand"],
    ["posix_spawn: No such file or directory", "ProxyCommand"],
    ["zsh:1: no such file or directory: /nonexistent/goat-proxy", "ProxyCommand"],
    ["/bin/sh: tailscale: command not found", "ProxyCommand"],
    ["/bin/sh: line 1: tailscale: command not found", "ProxyCommand"],
    ["sh: tailscale: not found", "ProxyCommand"],
    ["/bin/bash: line 1: /missing/tailscale: No such file or directory", "ProxyCommand"],
  ])("blocks local proxy failure before generic closure: %s", (diagnostic, fix) => {
    const failure = sshPreparationFailure(`${diagnostic}\nConnection closed by UNKNOWN port 65535`);
    expect(failure).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      localProxyUnavailable: true,
    });
    expect(failure.detail).toContain(fix);
  });
  it("keeps runtime download errors out of SSH login classification", () => {
    expect(
      sshPreparationFailure("Local gh SSH runtime download timed out (fixture)."),
    ).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "remote-unavailable",
    });
  });
});

it.each([
  "cloudflared: unexpected status code 404: Not Found",
  "cloudflared: route not found",
  "cloudflared: peer not found",
  "tailscale: item not found in the data protection keychain",
  "connect to tailscale-mbp: Socket is not connected",
  "cloudflared: No such file or directory in remote response",
])("keeps remote proxy failures quiet: %s", (diagnostic) => {
  expect(
    sshPreparationFailure(
      `${diagnostic}\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535`,
    ),
  ).toMatchObject({
    _tag: "ConnectionTransientError",
    reason: "host-unreachable",
  });
});

describe("neutral SSH ownership and preparation deadlines", () => {
  it.each([
    "SSH preparation superseded by a newer connection intent.",
    "SSH connection was cancelled.",
  ])("normalizes exact neutral messages through IPC: %s", (message) => {
    for (const cause of [
      message,
      new Error(message),
      { message },
      new Error(`${IPC}SshEnsureSupersededError: ${message}`),
    ]) {
      expect(sshPreparationFailure(cause)).toMatchObject({
        _tag: "ConnectionAttemptSuperseded",
        reason: "superseded",
        detail: message,
      });
    }
  });
  it("recognizes the native tag without classifying incidental shell output as neutral", () => {
    expect(
      sshPreparationFailure({
        _tag: "SshEnsureSupersededError",
        message: "Attachment invalidated.",
      })._tag,
    ).toBe("ConnectionAttemptSuperseded");
    for (const message of [
      "script: SSH connection was cancelled.",
      "SSH connection was cancelled. stderr follows",
      "command output: SSH preparation superseded by a newer connection intent.",
    ]) {
      expect(sshPreparationFailure(message)._tag).toBe("ConnectionTransientError");
    }
  });
  it("identifies the native deadline independently of ordinary setup timeouts", () => {
    expect(
      sshPreparationFailure(
        new Error(
          `${IPC}SshPreparationTimeoutError: SSH runtime preparation exceeded its 15-minute limit.`,
        ),
      ),
    ).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "timeout",
      sshPreparationTimedOut: true,
    });
  });
});
