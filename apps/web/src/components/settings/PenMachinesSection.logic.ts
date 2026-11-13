import type { PenMemberStatus } from "@goat/client-runtime/connection";
import type { ClientCapabilities } from "@goat/client-runtime/platform";
import type { PenRouteRefusal } from "@goat/contracts";

const INSTALL_SSH_CONFIG =
  "Run `pen ssh-config --install` on this computer so GOAT can reach your Pen machines.";

function penRefusalText(reason: PenRouteRefusal): string {
  switch (reason) {
    case "not-in-pen-config":
      return "Pen has not written an ssh host for this machine yet.";
    case "not-pen-route":
    case "node-mismatch":
      return "Its ssh host is not the one Pen writes, so GOAT does not use it.";
    case "known-hosts-not-pen":
    case "global-known-hosts":
    case "marker-lines":
      return "ssh would accept a host key Pen did not record for it, so GOAT does not use it.";
    case "no-recorded-key":
      return "It has published no ssh host key. Run `pen ls` on it to see why.";
    case "key-mismatch":
      return "Its Pen key changed. Waiting for Pen to update its ssh host.";
    case "unreadable":
      return "GOAT could not read Pen's ssh settings for it.";
  }
}

export function penMemberText(member: PenMemberStatus): string {
  switch (member.state) {
    case "connected":
      return "Connected";
    case "yours":
      return "You added this machine yourself; GOAT leaves your connection as it is.";
    case "connecting":
      return "Connecting…";
    case "offline":
      return "Offline";
    case "not-set-up":
      return "Pen member, GOAT not set up. Set up installs GOAT there.";
    case "needs-update":
      return "Its GOAT is too old to sign this computer in. Update GOAT on that machine.";
    case "key-rejected":
      return "It refused this computer's ssh key.";
    case "refused":
      return member.refusal === undefined
        ? "Pen does not vouch for its ssh host."
        : penRefusalText(member.refusal);
    case "failed":
      return member.detail ?? "Could not connect.";
  }
}

/** One line above the list when the list itself cannot say what to do next. */
export function penGuidance(
  state: ClientCapabilities.PenMembersInput | undefined,
  statuses: ReadonlyArray<PenMemberStatus>,
): string | null {
  if (state === undefined) return "Looking for your Pen machines…";
  switch (state.kind) {
    case "disabled":
      return null;
    case "not-member":
      return "This computer is not in a Pen mesh.";
    case "unavailable":
      return state.reason === "no-pen"
        ? "Pen is not installed on this computer."
        : state.reason === "daemon-down"
          ? "Pen is not running on this computer. Start it with `pen up`."
          : "Pen's machine list is not available right now.";
    case "ready":
      if (state.members.length === 0) return "No other machine is in this Pen mesh yet.";
      return statuses.length > 0 &&
        statuses.every((member) => member.refusal === "not-in-pen-config")
        ? INSTALL_SSH_CONFIG
        : null;
  }
}
