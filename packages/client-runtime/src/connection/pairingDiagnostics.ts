import { isSharedAddressSpaceHost, isTailnetHost } from "@goat/shared/hostClassification";
import * as Schema from "effect/Schema";

import { ConnectionBlockedError, ConnectionTransientError, type NetworkStatus } from "./model.ts";

/** The three checks a failed pairing walks through, in order: reach, hub, pairing code. */
export type PairingDiagnosticStepId = "network" | "hub" | "token";
export type PairingDiagnosticStepState = "passed" | "failed" | "unchecked";

export interface PairingDiagnosis {
  /** First failing check, or null when the failure does not say which check failed. */
  readonly failedStep: PairingDiagnosticStepId | null;
  readonly steps: ReadonlyArray<{
    readonly id: PairingDiagnosticStepId;
    readonly state: PairingDiagnosticStepState;
  }>;
  /** The hub address only resolves or routes through Tailscale. */
  readonly tailnet: boolean;
  readonly offline: boolean;
}

const STEP_ORDER: ReadonlyArray<PairingDiagnosticStepId> = ["network", "hub", "token"];
const isTransientError = Schema.is(ConnectionTransientError);
const isBlockedError = Schema.is(ConnectionBlockedError);

function failedStepFor(error: unknown): PairingDiagnosticStepId | null {
  if (isTransientError(error)) {
    switch (error.reason) {
      case "network":
      case "timeout":
      case "transport":
      case "host-unreachable":
      case "endpoint-unavailable":
        return "network";
      case "remote-unavailable":
      case "relay-unavailable":
        return "hub";
    }
  }
  if (isBlockedError(error)) {
    switch (error.reason) {
      // An incompatible protocol is only known after the hub answered.
      case "unsupported":
        return "hub";
      case "authentication":
      case "permission":
        return "token";
      // Raised both while parsing the address locally and after the hub answered, so it
      // proves nothing about reach.
      case "configuration":
        return null;
    }
  }
  return null;
}

function hostnameOf(host: string): string {
  const trimmed = host.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

/**
 * Explains a failed pairing as the first of three checks that failed. Tailscale being off
 * shows up as a network failure to a tailnet address: its MagicDNS name stops resolving and
 * 100.64.0.0/10 stops routing, so pairing never reaches the hub.
 */
export function diagnosePairingFailure(input: {
  readonly host: string;
  readonly error: unknown;
  readonly networkStatus?: NetworkStatus;
}): PairingDiagnosis {
  const hostname = hostnameOf(input.host);
  const tailnet = isTailnetHost(hostname) || isSharedAddressSpaceHost(hostname);
  const offline = input.networkStatus === "offline";
  const failedStep = offline ? "network" : failedStepFor(input.error);
  const failedIndex = failedStep === null ? -1 : STEP_ORDER.indexOf(failedStep);
  return {
    failedStep,
    steps: STEP_ORDER.map((id, index) => ({
      id,
      state:
        failedIndex === -1 || index > failedIndex
          ? "unchecked"
          : index === failedIndex
            ? "failed"
            : "passed",
    })),
    tailnet,
    offline,
  };
}
