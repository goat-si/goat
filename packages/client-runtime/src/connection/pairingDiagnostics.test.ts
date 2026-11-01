import { describe, expect, it } from "vite-plus/test";

import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import { diagnosePairingFailure } from "./pairingDiagnostics.ts";

const states = (diagnosis: ReturnType<typeof diagnosePairingFailure>) =>
  diagnosis.steps.map((step) => step.state);

describe("diagnosePairingFailure", () => {
  it("stops at the network step when a tailnet hub cannot be reached", () => {
    const diagnosis = diagnosePairingFailure({
      host: "https://hub.tail1234.ts.net/",
      error: new ConnectionTransientError({ reason: "network", detail: "fetch failed" }),
      networkStatus: "online",
    });

    expect(diagnosis.failedStep).toBe("network");
    expect(states(diagnosis)).toEqual(["failed", "unchecked", "unchecked"]);
    expect(diagnosis.tailnet).toBe(true);
  });

  it("treats a timeout to a Tailscale IPv4 address as unreachable over Tailscale", () => {
    const diagnosis = diagnosePairingFailure({
      host: "100.101.102.103:3773",
      error: new ConnectionTransientError({ reason: "timeout", detail: "deadline" }),
    });

    expect(diagnosis.failedStep).toBe("network");
    expect(diagnosis.tailnet).toBe(true);
  });

  it("marks a LAN address that cannot be reached as a network failure off the tailnet", () => {
    const diagnosis = diagnosePairingFailure({
      host: "192.168.1.5:3773",
      error: new ConnectionTransientError({ reason: "network", detail: "fetch failed" }),
    });

    expect(diagnosis.failedStep).toBe("network");
    expect(diagnosis.tailnet).toBe(false);
  });

  it("reports an offline phone before anything the hub said", () => {
    const diagnosis = diagnosePairingFailure({
      host: "https://hub.tail1234.ts.net",
      error: new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      networkStatus: "offline",
    });

    expect(diagnosis.failedStep).toBe("network");
    expect(diagnosis.offline).toBe(true);
  });

  it("passes the network step when the hub answered but failed", () => {
    for (const error of [
      new ConnectionTransientError({ reason: "remote-unavailable", detail: "500" }),
      new ConnectionBlockedError({ reason: "unsupported", detail: "protocol" }),
    ]) {
      const diagnosis = diagnosePairingFailure({ host: "hub.tail1234.ts.net", error });
      expect(states(diagnosis)).toEqual(["passed", "failed", "unchecked"]);
    }
  });

  it("blames the pairing code when the hub rejects the credential", () => {
    const diagnosis = diagnosePairingFailure({
      host: "hub.tail1234.ts.net",
      error: new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
    });

    expect(diagnosis.failedStep).toBe("token");
    expect(states(diagnosis)).toEqual(["passed", "passed", "failed"]);
  });

  it("claims nothing for configuration errors or unknown failures", () => {
    for (const error of [
      new ConnectionBlockedError({ reason: "configuration", detail: "bad address" }),
      new Error("boom"),
    ]) {
      const diagnosis = diagnosePairingFailure({ host: "not a url", error });
      expect(diagnosis.failedStep).toBeNull();
      expect(states(diagnosis)).toEqual(["unchecked", "unchecked", "unchecked"]);
    }
  });
});
