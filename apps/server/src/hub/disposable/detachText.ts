import type { Detach, Health } from "./detachModel.ts";

const leave = (inPen: boolean) =>
  inPen
    ? " It stays a Pen member, with the owner's authority on every member, and keeps its slot until a person removes it with pen revoke."
    : " It has left Pen.";
const forget = (linkId: string | null) =>
  linkId === null
    ? ""
    : " If the machine is gone for good, a person on this hub runs ocx link recover --forget --link-id " +
      linkId +
      " --yes (OpenCodex refuses it from an agent).";

/** Why a detach waits for a person: a Child's refusal of the purge, or a revoke OpenCodex left unsettled. */
const STOPS: Record<string, string> = {
  revoke_child_residual:
    "the lightweight Child keeps records it cannot restore, so OpenCodex kept the link. Check the machine; a person can force the detach, which removes the link without the machine.",
  revoke_child_link_mismatch:
    "the Child refused: it belongs to another link, or a connect of this one is still running there. Check it with connect status of its planted ocx-child; a person can force the detach.",
  revoke_expect_link_unsupported:
    "the machine runs an ocx-child too old to check which link it belongs to. A person can force the detach.",
  revoke_child_missing:
    "the machine has no planted ocx-child, so OpenCodex could not clean it and kept the link. A person can force the detach; its cleanup then waits for a person to check the machine and forget it on this hub.",
  revoke_refused: "OpenCodex refused the revoke and kept the link. A person can force the detach.",
  revoke_unsettled:
    "OpenCodex could not tell what the revoke did to the Child. Check the machine; a person on this hub resolves the operation below with ocx link operations resolve, then forces the detach.",
  link_unsettled:
    "OpenCodex could not tell what the machine's last link operation left, so GOAT does not remove a link it cannot name. A person resolves the operation below with ocx link operations resolve and detaches again, or forces the detach: GOAT then removes whatever link OpenCodex lists for the machine.",
  link_open:
    "OpenCodex still lists the machine's last link operation as running after 10 quiet minutes, so GOAT does not remove a link it cannot name. A person can force the detach: GOAT then removes whatever link OpenCodex lists for the machine.",
  tombstone_limit:
    "too many links removed without their machines wait for cleanup on this hub; recover or forget some (ocx link recover --list), then force the detach again.",
};
/** What recover's refusal means while GOAT keeps trying it every 30 minutes. */
const RECOVER_WAITS: Record<string, string> = {
  alias_linked:
    "another link of this hub uses the machine's alias, so GOAT leaves the machine until that link is removed.",
  child_recover_unsupported:
    "the planted ocx-child is too old to check which link it belongs to, so GOAT cannot clean it.",
  child_residual: "the machine keeps records GOAT cannot restore; it was left as it is.",
  child_conflict: "the machine's records belong to another link or home; it was left as it is.",
  host_key_changed:
    "the machine presents another SSH host key than its link pinned, so GOAT sends it nothing.",
  managed_child_missing:
    "the machine has no planted ocx-child, so recover cannot confirm its cleanup.",
};

export interface DetachView {
  readonly state: string;
  readonly name: string;
  readonly linkId: string | null;
  readonly detach: Detach | undefined;
  readonly health: Health | undefined;
  readonly linkKeyMoved: boolean;
  /** The admitted key is still in the hub's Pen view. */
  readonly inPen: boolean;
  /** Why enrollment or a check stopped the record (enroll.stop). */
  readonly stop: string | undefined;
}

/** The message for a record GOAT is detaching, retired, returned or purged, or a linked one it checks. */
export const detachMessage = (
  view: DetachView,
): { readonly message: string; readonly nextAction: string | null } | undefined => {
  const { name, linkId, detach } = view;
  const operation =
    detach?.operationId === undefined ? "" : " Operation " + detach.operationId + ".";
  // A changed host key stops every step for the record; only a person removes it from Pen.
  if (
    view.stop === "host_key_changed" &&
    detach?.force !== true &&
    (view.state === "linked" || view.state === "detaching" || view.state === "retired")
  )
    return {
      message:
        name +
        " presented another SSH host key than its link pinned, so GOAT stopped every step for it and sent it nothing. A person can force the detach, which removes the link without contacting the machine; remove the machine from Pen with pen revoke.",
      nextAction: "A person forces the detach, and removes the machine with pen revoke.",
    };
  switch (view.state) {
    case "linked":
      if (view.linkKeyMoved)
        return {
          message:
            name +
            " is linked, but its OpenCodex link names this hub's machine key at another path than GOAT's current one: GOAT's home moved. Move it back to bring the link back.",
          nextAction: null,
        };
      if ((view.health?.failures ?? 0) >= 2)
        return {
          message:
            name +
            " is linked but has not answered its last " +
            String(view.health?.failures ?? 0) +
            " checks. After 24 hours without an answer GOAT removes its link without the machine and cleans the machine once it answers.",
          nextAction: null,
        };
      return undefined;
    case "detaching": {
      if (detach?.stop !== undefined)
        return {
          message:
            name + " is detaching, but " + (STOPS[detach.stop] ?? STOPS.revoke_refused) + operation,
          nextAction:
            detach.stop === "revoke_unsettled"
              ? "Resolve the operation on the hub, then force the detach as a person."
              : detach.stop === "link_unsettled"
                ? "Resolve the operation on the hub and detach again, or force the detach as a person."
                : detach.stop === "link_open" || detach.stop === "tombstone_limit"
                  ? "Force the detach as a person."
                  : "Force the detach as a person, or check the machine and detach again.",
        };
      if (detach?.step === "settle")
        return {
          message:
            name +
            " is detaching: GOAT is reading what its last link operation left before it removes the link.",
          nextAction: null,
        };
      if (detach?.step === "recover" && detach.elsewhere === true)
        return {
          message:
            name +
            " is detaching: its OpenCodex link was removed outside GOAT, so GOAT asks OpenCodex whether a cleanup of the machine is waiting.",
          nextAction: null,
        };
      if (detach?.step === "recover")
        return {
          message:
            name +
            " is detaching: OpenCodex removed its link without reaching the machine, and GOAT cleans the lightweight Child there once the machine answers, trying every 30 minutes" +
            (detach.outcome !== undefined && RECOVER_WAITS[detach.outcome] !== undefined
              ? "; " + RECOVER_WAITS[detach.outcome]
              : ".") +
            forget(linkId),
          nextAction: null,
        };
      if (detach?.outcome === "unreachable")
        return {
          message:
            name +
            " is detaching, but it does not answer, so OpenCodex keeps its link. GOAT tries again every 30 minutes; after 24 hours without an answer it removes the link without the machine. A person can force that now." +
            operation,
          nextAction: "Force the detach as a person to remove the link now.",
        };
      return {
        message:
          name +
          " is detaching: GOAT is removing its OpenCodex link and the lightweight Child." +
          operation,
        nextAction: null,
      };
    }
    case "retired":
      if (detach?.step === "revoke")
        return {
          message:
            name +
            " did not answer for 24 hours, and GOAT is finishing the removal of its OpenCodex link without it." +
            operation,
          nextAction: null,
        };
      return {
        message:
          name +
          " did not answer for 24 hours, so GOAT removed its OpenCodex link without it. GOAT cleans the machine once it answers, trying every 30 minutes" +
          (detach?.outcome !== undefined && RECOVER_WAITS[detach.outcome] !== undefined
            ? "; " + RECOVER_WAITS[detach.outcome]
            : ".") +
          forget(linkId),
        nextAction: "Detach it to end the record once its cleanup is done.",
      };
    case "returned":
      return {
        message:
          name +
          " answered again after it was retired, and GOAT cleaned its lightweight Child. Detach it to end the record." +
          leave(view.inPen),
        nextAction: "Detach it to end the record.",
      };
    case "purged":
      return {
        message:
          name +
          (detach?.outcome === "forgotten"
            ? " is detached: its OpenCodex link is gone, and a person forgot its cleanup on this hub, so the machine may still hold the lightweight Child."
            : detach?.outcome === "unproven"
              ? " is detached: OpenCodex lists no link for it, but link operation " +
                (detach.operationId ?? "") +
                " never settled, so the machine may still hold the planted Child; check it there with ~/.cache/opencodex/bin/ocx-child connect status --json."
              : detach?.outcome === "elsewhere"
                ? " is detached: its OpenCodex link was removed outside GOAT, so GOAT cannot tell whether the machine still holds the lightweight Child."
                : " is detached: its OpenCodex link and lightweight Child are gone.") +
          leave(view.inPen),
        nextAction: null,
      };
    case "failed":
      return detach?.outcome === "released"
        ? {
            message:
              name +
              "'s attach was released by a person and its slot is free. Pen lost its invite or saved no admit, so GOAT cannot tell whether the machine joined; if it did, it stays a Pen member until a person removes it with pen revoke.",
            nextAction: null,
          }
        : undefined;
    default:
      return undefined;
  }
};
