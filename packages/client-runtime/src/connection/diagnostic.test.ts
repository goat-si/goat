import { describe, expect, it } from "@effect/vitest";

import { formatConnectionDiagnostic } from "./diagnostic.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "./model.ts";
import { presentConnectionState } from "./presentation.ts";

describe("connection diagnostic", () => {
  it("copies the public connection state and the existing runtime diagnostic", () => {
    const connection = presentConnectionState({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "backoff",
      lastFailure: new ConnectionTransientError({
        reason: "host-unreachable",
        detail: "Cannot reach mbp over SSH (Operation timed out).",
        traceId: "trace-123",
      }),
      retryAt: 60_000,
    });
    expect(
      formatConnectionDiagnostic({
        label: "My laptop",
        hostAlias: "mbp",
        connection,
        diagnosticTail: "ssh: connect to host mbp port 22: Operation timed out",
        appVersion: "0.1.0",
      }),
    ).toBe(
      [
        "Environment: My laptop",
        "Host: mbp",
        "Connection phase: reconnecting",
        "Classified reason: retrying (host-unreachable)",
        "Last failure: Cannot reach mbp over SSH (Operation timed out).",
        "Retry time: 1970-01-01T00:01:00.000Z",
        "Trace ID: trace-123",
        "App version: 0.1.0",
        "Public diagnostic tail:",
        "ssh: connect to host mbp port 22: Operation timed out",
      ].join("\n"),
    );
  });

  it("retains blocked classifications, including while retrying the attempt", () => {
    for (const phase of ["blocked", "connecting"] as const) {
      const connection = presentConnectionState({
        ...AVAILABLE_CONNECTION_STATE,
        phase,
        lastFailure: new ConnectionBlockedError({
          reason: "authentication",
          detail: "The SSH host rejected the login.",
        }),
      });
      const text = formatConnectionDiagnostic({ label: "host", connection });
      expect(text).toContain("Classified reason: blocked (authentication)");
      expect(text).toContain("Retry time: none");
      expect(text).not.toContain("Trace ID:");
      expect(text).not.toContain("App version:");
    }
  });

  it.each([
    ["Enter passphrase for key 'id_ed25519':\nalice@host's password:\nhunter2", "hunter2"],
    ["SSH_ASKPASS=/tmp/x\nPassword:\nhunter2", "hunter2"],
    ["Password for alice@mac-studio: hunter2", "hunter2"],
    ["Password for alice@mac-studio:\nhunter2", "hunter2"],
    ["[sudo] password for alice: hunter2", "hunter2"],
    ["passphrase=opaque-key-phrase", "opaque-key-phrase"],
    ["wsTicket=opaque-websocket-ticket", "opaque-websocket-ticket"],
    ['"ticket": "opaque-ticket"', "opaque-ticket"],
    ["pairingCode=opaque-pairing-code", "opaque-pairing-code"],
    ["pairing_code=opaque-pairing-code", "opaque-pairing-code"],
    ["pairing-code=opaque-pairing-code", "opaque-pairing-code"],
    ["IdentityFile=keys/private/id_ed25519", "keys/private/"],
    ['IdentityFile="keys/private dir/id_ed25519"', "keys/private dir/"],
    ["askpass prompt: What is the secret?\nresponse-without-a-label", "response-without-a-label"],
    ["Enter passphrase for key '/Users/alice/.ssh/id_ed25519':\nkey-password", "key-password"],
    ["alice@host's password: hunter2", "hunter2"],
    [
      '{"access_token": "opaque-access-token", "refreshToken": "opaque-refresh-token"}',
      "opaque-access-token",
    ],
    ["token='secret with spaces'", "secret with spaces"],
    ["--token opaque-argument-token", "opaque-argument-token"],
    ["pairingToken=opaque-pairing-token", "opaque-pairing-token"],
    ["Cookie: goat_session=session-cookie; session=other-cookie", "session-cookie"],
    ['"cookie": "json-cookie-value"', "json-cookie-value"],
    ["Authorization: Bearer header-credential", "header-credential"],
    ["Bearer inline-credential", "inline-credential"],
    ["https://user:url-password@host/pair#opaque-pairing-fragment", "opaque-pairing-fragment"],
    ["http://localhost/?token=opaque-pairing-query", "opaque-pairing-query"],
    ["IdentityFile /Users/alice/private/keys/id_ed25519", "/Users/alice/private/keys/"],
    ["identity C:\\Users\\alice\\private\\id_rsa", "C:\\Users\\alice\\private\\"],
    ["key ~/.ssh/id_ed25519", "~/.ssh/"],
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-bytes\n-----END OPENSSH PRIVATE KEY-----",
      "private-key-bytes",
    ],
    ["api_key=sk-private-provider-key", "sk-private-provider-key"],
    ["Password: simple-password", "simple-password"],
    ["Password:\nseparate-password-response", "separate-password-response"],
    [
      "IdentityFile '/Users/Alice Smith/private keys/id_ed25519'",
      "/Users/Alice Smith/private keys/",
    ],
    ["goat://pair/opaque-deep-link", "opaque-deep-link"],
    ["IdentityFile keys/private/id_ed25519", "keys/private/"],
    ["Load key './keys/id_rsa': Permission denied", "./keys/"],
    ["key /id_ed25519", "/id_ed25519"],
    ["eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZSJ9.opaque-signature", "opaque-signature"],
  ])("redacts credentials from every free-text field: %s", (detail, secret) => {
    const connection = presentConnectionState({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({
        reason: "authentication",
        detail,
        traceId: detail,
      }),
    });
    const text = formatConnectionDiagnostic({
      label: detail,
      hostAlias: detail,
      appVersion: detail,
      connection,
      diagnosticTail: detail,
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("opaque-refresh-token");
    expect(text).not.toContain("other-cookie");
    expect(text).not.toContain("url-password");
  });

  it("bounds the public tail to eight lines and 4000 characters after redaction", () => {
    const connection = presentConnectionState(AVAILABLE_CONNECTION_STATE);
    const format = (diagnosticTail: string) =>
      formatConnectionDiagnostic({ label: "host", connection, diagnosticTail });
    const text = format(Array.from({ length: 12 }, (_, n) => `line ${n}`).join("\n"));
    expect(text.split("Public diagnostic tail:\n")[1]).toBe(
      Array.from({ length: 8 }, (_, n) => `line ${n + 4}`).join("\n"),
    );
    expect(format("x".repeat(10_000)).split("Public diagnostic tail:\n")[1]).toHaveLength(4_000);
    expect(format(`token=${"s".repeat(10_000)}`)).not.toContain("sss");
    expect(format("\x1b[31mConnection refused\x1b[0m")).toContain("Connection refused");
    expect(format("\x1b[31mConnection refused\x1b[0m")).not.toContain("\x1b");
  });

  it.each([
    "SSH password prompt expired. Try connecting again.",
    "The token expired. Try connecting again.",
    "The secret could not be loaded.",
    "The credential was rejected.",
    "A passphrase is required to unlock this key.",
  ])("preserves public explanatory prose: %s", (detail) => {
    const text = formatConnectionDiagnostic({
      label: detail,
      connection: presentConnectionState(AVAILABLE_CONNECTION_STATE),
      diagnosticTail: detail,
    });
    expect(text).toContain(`Environment: ${detail}`);
    expect(text.split("Public diagnostic tail:\n")[1]).toBe(detail);
  });

  it("handles an unconnected environment with no evidence", () => {
    expect(
      formatConnectionDiagnostic({
        label: "host",
        connection: presentConnectionState(AVAILABLE_CONNECTION_STATE),
      }),
    ).toBe(
      [
        "Environment: host",
        "Connection phase: available",
        "Classified reason: none",
        "Last failure: none",
        "Retry time: none",
      ].join("\n"),
    );
  });

  it("keeps the last failure available to copy while this device is offline", () => {
    const connection = presentConnectionState({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "offline",
      lastFailure: new ConnectionTransientError({
        reason: "timeout",
        detail: "Host timed out.",
        traceId: "trace-offline",
      }),
    });
    expect(connection.error).toBeNull();
    const text = formatConnectionDiagnostic({ label: "host", connection });
    expect(text).toContain("Connection phase: offline");
    expect(text).toContain("Classified reason: retrying (timeout)");
    expect(text).toContain("Last failure: Host timed out.");
    expect(text).toContain("Trace ID: trace-offline");
  });
});
