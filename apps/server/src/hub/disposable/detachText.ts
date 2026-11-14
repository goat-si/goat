import type { Detach, Health } from "./detachModel.ts";

const LEAVE =
  " It stays a Pen member, with the owner's authority on every member, until a person removes it with pen revoke.";
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
  revoke_child_disconnect_pending:
    "the Child has an unfinished disconnect it cannot tie to this link. A person can force the detach.",
  revoke_expect_link_unsupported:
    "the machine runs an ocx-child too old to check which link it belongs to. A person can force the detach.",
  revoke_binary_in_use:
    "another home's relay on the machine runs from the planted ocx-child, so OpenCodex kept the link. Stop that relay, or a person can force the detach.",
  revoke_refused: "OpenCodex refused the revoke and kept the link. A person can force the detach.",
  revoke_unsettled:
    "OpenCodex could not tell what the revoke did to the Child. Check the machine, then a person on this hub runs ocx link operations resolve for the operation below, and forces the detach.",
  link_unsettled:
    "OpenCodex could not tell what the machine's last link operation left, so GOAT does not remove a link it cannot name. A person resolves it with ocx link operations on this hub.",
  tombstone_limit:
    "too many links removed without their machines wait for cleanup on this hub; recover or forget some (ocx link recover --list), then GOAT goes on.",
};
/** What recover's refusal means while GOAT keeps trying it every 30 minutes. */
const RECOVER_WAITS: Record<string, string> = {
  alias_linked:
    "another link of this hub uses the machine's alias, so GOAT leaves the machine until that link is removed.",
  child_recover_unsupported:
    "the planted ocx-child is too old to check which link it belongs to, so GOAT cannot clean it.",
  child_residual: "the machine keeps records GOAT cannot restore; it was left as it is.",
  child_conflict: "the machine's records belong to another link or home; it was left as it is.",
};

export interface DetachView {
  readonly state: string;
  readonly name: string;
  readonly linkId: string | null;
  readonly detach: Detach | undefined;
  readonly health: Health | undefined;
  readonly linkKeyMoved: boolean;
}

/** The message for a record GOAT is detaching, retired, returned or purged, or a linked one it checks. */
export const detachMessage = (
  view: DetachView,
): { readonly message: string; readonly nextAction: string | null } | undefined => {
  const { name, linkId, detach } = view;
  const operation =
    detach?.operationId === undefined ? "" : " Revoke operation " + detach.operationId + ".";
  switch (view.state) {
    case "linked":
      if (view.linkKeyMoved)
        return {
          message:
            name +
            " is linked, but its OpenCodex link names this hub's machine key at a path that no longer holds it: GOAT's home moved. Move it back to bring the link back.",
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
          nextAction: "Force the detach as a person, or check the machine and detach again.",
        };
      if (detach?.step === "settle")
        return {
          message:
            name +
            " is detaching: GOAT is reading what its last link operation left before it removes the link.",
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
          LEAVE,
        nextAction: "Detach it to end the record.",
      };
    case "purged":
      return {
        message:
          name +
          (detach?.outcome === "forgotten"
            ? " is detached: its OpenCodex link is gone, and a person forgot its cleanup on this hub, so the machine may still hold the lightweight Child."
            : " is detached: its OpenCodex link and lightweight Child are gone.") +
          LEAVE,
        nextAction: null,
      };
    default:
      return undefined;
  }
};
