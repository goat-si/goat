import type { Detach, Health } from "./detachModel.ts";

const WHERE = " in Settings → Hub on web or desktop";
const leave = (inPen: boolean) =>
  inPen
    ? " It stays a Pen member, with the owner's authority on every member, and keeps its slot until a person removes it with pen revoke."
    : " It has left Pen.";
/** An open record out of Pen still holds its slot, until its cleanup ends or a person forgets it. */
const held = (inPen: boolean, recovering: boolean) =>
  inPen
    ? ""
    : recovering
      ? " It has left Pen; this record keeps its slot until that cleanup ends."
      : " It has left Pen; this record keeps its slot until the detach ends.";
const forget = (linkId: string | null) =>
  linkId === null
    ? ""
    : " If it is gone for good, a person on this hub runs ocx link recover --forget --link-id " +
      linkId +
      " --yes (refused from an agent).";
const resolve = (operationId: string) =>
  "ocx link operations resolve --operation-id " + operationId + " --yes";

interface Stop {
  readonly text: (operationId: string, outcome: string | undefined) => string;
  readonly next: string;
}
const FORCE_NEXT = "A person forces the detach" + WHERE + ".";
const CHECK_NEXT =
  "A person checks the machine, then detaches again or forces the detach" + WHERE + ".";
const RESOLVE_NEXT =
  "A person checks the machine, resolves the operation on the hub, then forces the detach" +
  WHERE +
  ".";
/** Why a detach waits for a person: a Child's refusal of the purge, or an operation OpenCodex left unsettled. */
const STOPS: Record<string, Stop> = {
  revoke_child_residual: {
    text: () =>
      "the lightweight Child keeps records it cannot restore, so OpenCodex kept the link. A person can force the detach" +
      WHERE +
      ", which removes the link without the machine.",
    next: FORCE_NEXT,
  },
  revoke_child_link_mismatch: {
    text: () =>
      "the Child refused: it belongs to another link, or a connect of this one is still running there. A person checks it with connect status of its planted ocx-child, then detaches again or forces the detach" +
      WHERE +
      ".",
    next: CHECK_NEXT,
  },
  revoke_child_disconnect_pending: {
    text: () =>
      "the Child has an unfinished disconnect not tied to this link. A person checks its planted ocx-child's connect status: only with no connection, they finish it there with disconnect and detach again; else they force the detach" +
      WHERE +
      ".",
    next: CHECK_NEXT,
  },
  revoke_answered: {
    text: (operationId) =>
      "the machine answers, yet OpenCodex could not tell whether the purge removed its lightweight Child. A person checks the machine, runs " +
      resolve(operationId) +
      " on this hub, then forces the detach" +
      WHERE +
      ".",
    next: RESOLVE_NEXT,
  },
  revoke_expect_link_unsupported: {
    text: () =>
      "the machine runs an ocx-child too old to check which link it belongs to. A person can force the detach" +
      WHERE +
      ".",
    next: FORCE_NEXT,
  },
  revoke_child_missing: {
    text: () =>
      "the machine has no planted ocx-child, so OpenCodex could not clean it and kept the link. A person can force the detach" +
      WHERE +
      "; its cleanup then waits for a person to check the machine and forget it on this hub.",
    next: FORCE_NEXT,
  },
  revoke_refused: {
    text: () =>
      "OpenCodex refused the revoke and kept the link. A person can force the detach" + WHERE + ".",
    next: FORCE_NEXT,
  },
  revoke_unsettled: {
    text: (operationId, outcome) =>
      outcome === "open"
        ? "OpenCodex still lists the revoke " +
          operationId +
          " as running. A person fixes what stopped it on this hub (ocx link operations --operation-id " +
          operationId +
          "), then forces the detach" +
          WHERE +
          "."
        : "OpenCodex could not tell what the revoke did to the Child. A person checks the machine, runs " +
          resolve(operationId) +
          " on this hub, then forces the detach" +
          WHERE +
          ".",
    next: RESOLVE_NEXT,
  },
  link_unsettled: {
    text: (operationId) =>
      "OpenCodex could not tell what the machine's last link operation left. A person runs " +
      resolve(operationId) +
      " on this hub and detaches again, or forces the detach" +
      WHERE +
      ", removing the link OpenCodex lists.",
    next:
      "A person resolves the operation on the hub and detaches again, or forces the detach" +
      WHERE +
      ".",
  },
  link_lost: {
    text: (operationId) =>
      "OpenCodex has no record of the machine's last link operation " +
      operationId +
      ", so GOAT does not remove a link it cannot name. A person can force the detach" +
      WHERE +
      ", which removes the link OpenCodex lists for this machine.",
    next: FORCE_NEXT,
  },
  link_open: {
    text: (operationId) =>
      "OpenCodex still lists the machine's last link operation " +
      operationId +
      " as running after 10 quiet minutes. A person can force the detach" +
      WHERE +
      ", which removes the link OpenCodex lists for this machine.",
    next: FORCE_NEXT,
  },
  tombstone_limit: {
    text: () =>
      "too many links removed without their machines wait for cleanup on this hub; a person recovers or forgets some (ocx link recover --list), then forces the detach again" +
      WHERE +
      ".",
    next:
      "A person recovers or forgets waiting cleanups on the hub, then forces the detach" +
      WHERE +
      ".",
  },
};
const stopOf = (detach: Detach, stop: string) => {
  const known = STOPS[stop] ?? STOPS.revoke_refused;
  const operationId = detach.operationId ?? "";
  const text = known?.text(operationId, detach.outcome) ?? "";
  return {
    text:
      operationId === "" || text.includes(operationId)
        ? text
        : text + " Operation " + operationId + ".",
    next: known?.next ?? FORCE_NEXT,
  };
};
/** What recover's refusal means while GOAT keeps trying it every 30 minutes. */
const RECOVER_WAITS: Record<string, string> = {
  alias_linked:
    "another link of this hub uses its alias, so GOAT leaves the machine until that link goes.",
  child_recover_unsupported:
    "its planted ocx-child is too old to check which link it belongs to, so GOAT cannot clean it.",
  child_residual: "the machine keeps records GOAT cannot restore; it was left as it is.",
  child_conflict: "the machine's records belong to another link or home; it was left as it is.",
  host_key_changed:
    "it presents another SSH host key than its link pinned, so GOAT sends it nothing.",
  managed_child_missing:
    "the machine has no planted ocx-child, so only a person can confirm its cleanup.",
};
const waits = (detach: Detach | undefined) =>
  detach?.outcome !== undefined && RECOVER_WAITS[detach.outcome] !== undefined
    ? "; " + RECOVER_WAITS[detach.outcome]
    : ".";

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
  // A changed host key stops every step for the record; a person's force passes it.
  if (
    view.stop === "host_key_changed" &&
    detach?.force !== true &&
    (view.state === "linked" || view.state === "detaching" || view.state === "retired")
  )
    return {
      message:
        name +
        " presented another SSH host key than its link pinned, so GOAT stopped every step for it and sent it nothing. A person can force the detach" +
        WHERE +
        ", which removes the link without contacting the machine, and remove the machine from Pen with pen revoke." +
        held(view.inPen, false),
      nextAction:
        "A person forces the detach" +
        WHERE +
        ", and removes the machine from Pen with pen revoke.",
    };
  switch (view.state) {
    case "linked":
      if (detach?.force === true && detach.stop !== undefined) {
        const stop = stopOf(detach, detach.stop);
        return {
          message:
            name +
            " did not answer for 24 hours, but GOAT's removal of its link without it stopped: " +
            stop.text,
          nextAction: stop.next,
        };
      }
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
            " checks. After 24 hours without an answer, counted while this hub's Pen answers its member list, GOAT removes its link without the machine and cleans the machine once it answers.",
          nextAction: null,
        };
      return undefined;
    case "detaching": {
      if (detach?.stop !== undefined) {
        const stop = stopOf(detach, detach.stop);
        return {
          message: name + " is detaching, but " + stop.text + held(view.inPen, false),
          nextAction: stop.next,
        };
      }
      if (detach?.step === "settle")
        return {
          message:
            name +
            " is detaching: GOAT is reading what its last link operation left before it removes the link." +
            held(view.inPen, false),
          nextAction: null,
        };
      if (detach?.step === "recover")
        return {
          message:
            name +
            (detach.elsewhere === true
              ? " is detaching: its link was removed outside GOAT, and GOAT asks OpenCodex every 30 minutes whether a cleanup of the machine waits"
              : " is detaching: its link is gone, and GOAT cleans the lightweight Child once the machine answers, trying every 30 minutes") +
            waits(detach) +
            forget(linkId) +
            held(view.inPen, true),
          nextAction: null,
        };
      if (detach?.outcome === "unreachable")
        return {
          message:
            name +
            " is detaching, but it does not answer, so OpenCodex keeps its link. GOAT tries again every 30 minutes; after 24 hours without an answer it removes the link without the machine. A person can force that now" +
            WHERE +
            "." +
            operation +
            held(view.inPen, false),
          nextAction: "A person may force the detach" + WHERE + " to remove the link now.",
        };
      return {
        message:
          name +
          " is detaching: GOAT is removing its OpenCodex link and the lightweight Child." +
          operation +
          held(view.inPen, false),
        nextAction: null,
      };
    }
    case "retired":
      if (detach?.step === "revoke")
        return {
          message:
            name +
            " did not answer for 24 hours, and GOAT is finishing the removal of its OpenCodex link without it." +
            operation +
            held(view.inPen, false),
          nextAction: null,
        };
      return {
        message:
          name +
          " did not answer for 24 hours, so GOAT removed its link without it and cleans the machine once it answers, trying every 30 minutes" +
          waits(detach) +
          forget(linkId) +
          held(view.inPen, true),
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
              "'s attach was released by a person and its slot is free: Pen's member list did not hold its key when it was released.",
            nextAction: null,
          }
        : undefined;
    default:
      return undefined;
  }
};
