import type { PairingDiagnosis, PairingDiagnosticStepId } from "@goat/client-runtime/connection";

export function pairingDiagnosticStepTitle(id: PairingDiagnosticStepId, tailnet: boolean) {
  switch (id) {
    case "network":
      return tailnet ? "Tailscale" : "Network";
    case "hub":
      return "Hub responds";
    case "token":
      return "Pairing code";
  }
}

export function pairingDiagnosticsCopy(diagnosis: PairingDiagnosis, errorMessage: string) {
  switch (diagnosis.failedStep) {
    case "network":
      if (diagnosis.offline) {
        return "This phone is offline. Connect to Wi‑Fi or cellular, then try again.";
      }
      return diagnosis.tailnet
        ? "Can't reach the hub over Tailscale. Open Tailscale on this phone, turn it on, and sign in to the same tailnet as the hub. If it is on, check the hub is awake."
        : "Can't reach this address. Check the phone is on the same network as the hub, or use the hub's Tailscale QR code.";
    case "hub":
      return "The address answered, but not as a GOAT hub this app can use. Check the address and that GOAT on the hub is up to date.";
    case "token":
      return "The hub rejected the pairing code. It may be used or expired. Show a new QR code on the hub and scan again.";
    case null:
      return errorMessage;
  }
}
