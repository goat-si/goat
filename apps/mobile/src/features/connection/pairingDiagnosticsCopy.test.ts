import {
  ConnectionBlockedError,
  ConnectionTransientError,
  diagnosePairingFailure,
} from "@goat/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";
import { pairingDiagnosticsCopy, pairingDiagnosticStepTitle } from "./pairingDiagnosticsCopy";

const networkError = new ConnectionTransientError({
  reason: "network",
  detail: "Network unreachable",
});

describe("pairing diagnostics copy", () => {
  it.each(["https://hub.tail0000.ts.net", "http://100.64.1.2:3773"])(
    "directs a tailnet failure at %s to Tailscale",
    (host) => {
      const diagnosis = diagnosePairingFailure({ host, error: networkError });
      expect(pairingDiagnosticStepTitle("network", diagnosis.tailnet)).toBe("Tailscale");
      expect(pairingDiagnosticsCopy(diagnosis, networkError.message)).toBe(
        "Can't reach the hub over Tailscale. Open Tailscale on this phone, turn it on, and sign in to the same tailnet as the hub. If it is on, check the hub is awake.",
      );
      expect(diagnosis.steps.map((step) => step.state)).toEqual([
        "failed",
        "unchecked",
        "unchecked",
      ]);
    },
  );

  it("shows network advice for a LAN address", () => {
    const diagnosis = diagnosePairingFailure({
      host: "http://192.168.1.10:3773",
      error: networkError,
    });
    expect(pairingDiagnosticStepTitle("network", diagnosis.tailnet)).toBe("Network");
    expect(pairingDiagnosticsCopy(diagnosis, networkError.message)).toBe(
      "Can't reach this address. Check the phone is on the same network as the hub, or use the hub's Tailscale QR code.",
    );
  });

  it("prioritizes phone offline advice over tailnet advice", () => {
    const diagnosis = diagnosePairingFailure({
      host: "hub.tail0000.ts.net",
      error: networkError,
      networkStatus: "offline",
    });
    expect(pairingDiagnosticsCopy(diagnosis, networkError.message)).toBe(
      "This phone is offline. Connect to Wi‑Fi or cellular, then try again.",
    );
  });

  it("uses the hub step for an incompatible response", () => {
    const diagnosis = diagnosePairingFailure({
      host: "hub.local",
      error: new ConnectionBlockedError({ reason: "unsupported", detail: "Wrong protocol" }),
    });
    expect(pairingDiagnosticStepTitle("hub", false)).toBe("Hub responds");
    expect(pairingDiagnosticsCopy(diagnosis, "Wrong protocol")).toBe(
      "The address answered, but not as a GOAT hub this app can use. Check the address and that GOAT on the hub is up to date.",
    );
  });

  it("directs a rejected pairing code to a fresh QR code", () => {
    const diagnosis = diagnosePairingFailure({
      host: "hub.local",
      error: new ConnectionBlockedError({ reason: "authentication", detail: "Used token" }),
    });
    expect(pairingDiagnosticStepTitle("token", true)).toBe("Pairing code");
    expect(pairingDiagnosticsCopy(diagnosis, "Used token")).toBe(
      "The hub rejected the pairing code. It may be used or expired. Show a new QR code on the hub and scan again.",
    );
    expect(diagnosis.steps.map((step) => step.state)).toEqual(["passed", "passed", "failed"]);
  });

  it("leaves unobserved steps unchecked and falls back to the error detail", () => {
    const diagnosis = diagnosePairingFailure({
      host: "bad address",
      error: new ConnectionBlockedError({ reason: "configuration", detail: "Invalid address" }),
    });
    expect(diagnosis.steps.map((step) => step.state)).toEqual([
      "unchecked",
      "unchecked",
      "unchecked",
    ]);
    expect(pairingDiagnosticsCopy(diagnosis, "Invalid address")).toBe("Invalid address");
  });
});
