import type { Detach, Health } from "./detachModel.ts";

const WHERE = " in Settings → Hub on web or desktop";
const leave = (inPen: boolean) =>
  inPen
    ? " It stays a Pen member with the owner's authority, and keeps its slot, until a person runs pen revoke."
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
// Forgetting leaves a pending removal's receipt behind, so a pending answer does not offer it.
const forgetUnlessPending = (linkId: string | null, detach: Detach | undefined) =>
  detach?.outcome === "link_retirement_pending" ? "" : forget(linkId);
const resolve = (operationId: string) =>
  "ocx link operations resolve --operation-id " + operationId + " --yes";

interface Stop {
  readonly text: (
    operationId: string,
    outcome: string | undefined,
    detach: Detach,
    linkId: string,
  ) => string;
  readonly next: string | ((outcome: string | undefined, operationId: string) => string);
  readonly bare?: true;
}
/** A revoke OpenCodex left open, or never recorded, goes again under its id after a detach. */
const REPEATS = new Set(["open", "not_found", "unreadable"]);
const REPEAT_NEXT =
  "A person fixes what stopped the revoke on the hub, then detaches again" + WHERE + ".";
const FORCE_NEXT = "A person forces the detach" + WHERE + ".";
const CHECK_NEXT =
  "A person checks the machine, then detaches again or forces the detach" + WHERE + ".";
const RESOLVE_NEXT =
  "A person checks the machine, resolves the operation on the hub, then forces the detach" +
  WHERE +
  ".";
/** OpenCodex's order for an unknown revoke (cli/link.ts): the same id first, resolve only after. */
const REPEAT_FIRST_NEXT =
  "A person fixes what stopped it on the hub and forces the detach" +
  WHERE +
  ", which repeats it first; resolve it only if it still reads unknown.";
const unknownRevoke = (operationId: string) =>
  operationId.includes(".force.")
    ? "that forced revoke reads unknown. A person fixes what stopped it and forces the detach again" +
      WHERE +
      ": GOAT repeats it first. If it stays unknown, they check the machine, run " +
      resolve(operationId) +
      ", and force again."
    : "OpenCodex could not tell what the revoke " +
      operationId +
      " did to the Child, even after GOAT repeated it. A person checks the machine and forces the detach" +
      WHERE +
      ": GOAT repeats the revoke if it still holds the link and resolves it once the force is done.";
/** An unfinished removal holds the link (link_retirement_owned): the owner's way out on the Home. */
const ownerWayOut = (linkId: string) =>
  "A person on this hub repeats the revoke that owns it (see ocx link operations --json) or runs ocx link revoke --link-id " +
  linkId +
  " --force --yes";
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
    text: (operationId, outcome, detach) =>
      outcome === "open"
        ? "OpenCodex still lists the revoke " +
          operationId +
          " as running. A person fixes what stopped it on this hub (ocx link operations shows it), then detaches again" +
          WHERE +
          ": GOAT repeats the revoke under that id."
        : outcome === "not_found" || outcome === "unreadable"
          ? "OpenCodex " +
            (outcome === "not_found" ? "never recorded" : "gave no readable answer for") +
            " the revoke " +
            operationId +
            (detach.refusal === undefined ? "" : " (it answered " + detach.refusal + ")") +
            ". A person fixes what stopped it on this hub, then detaches again" +
            WHERE +
            ": GOAT sends it again."
          : unknownRevoke(operationId),
    next: (outcome, operationId) =>
      outcome !== undefined && REPEATS.has(outcome)
        ? REPEAT_NEXT
        : operationId.includes(".force.")
          ? REPEAT_FIRST_NEXT
          : "A person checks the machine, then forces the detach" + WHERE + ".",
  },
  link_retirement_owned: {
    text: (_operationId, _outcome, detach, linkId) =>
      "an unfinished removal holds its link (link_retirement_owned)" +
      (detach.owner === undefined
        ? ""
        : " and GOAT's repeat of its earlier revoke did not end it") +
      ". " +
      ownerWayOut(linkId) +
      ", then detaches again" +
      WHERE +
      ".",
    // The refused id was never recorded, so it names nothing a person can look up.
    bare: true,
    next:
      "A person finishes the removal that holds the link on the hub, then detaches again" +
      WHERE +
      ".",
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
  link_foreign: {
    text: (_operationId, _outcome, detach) =>
      "OpenCodex lists link " +
      (detach.foreignLinkId ?? "") +
      " under this machine's alias, which GOAT cannot tie to this attach, so GOAT leaves it. A person can force the detach" +
      WHERE +
      ", which ends this record and leaves that link as it is.",
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
const stopOf = (detach: Detach, stop: string, linkId: string) => {
  const known = STOPS[stop] ?? STOPS.revoke_refused;
  const operationId = detach.operationId ?? "";
  const text = known?.text(operationId, detach.outcome, detach, linkId) ?? "";
  const next = known?.next ?? FORCE_NEXT;
  return {
    text:
      operationId === "" || text.includes(operationId) || known?.bare === true
        ? text
        : text + " Operation " + operationId + ".",
    next: typeof next === "string" ? next : next(detach.outcome, operationId),
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
  link_retirement_pending:
    "OpenCodex still holds an unfinished removal of its link; GOAT repeated it once. Once its fault is fixed, a person detaches it again in Settings → Hub on web or desktop, which repeats it once more at GOAT's next try, within 30 minutes.",
};
const waits = (detach: Detach | undefined) =>
  detach?.outcome !== undefined && RECOVER_WAITS[detach.outcome] !== undefined
    ? "; " + RECOVER_WAITS[detach.outcome]
    : ".";
/** A forced removal waits on the resolve of the purge it replaced before recover runs. */
const resolveOwed = (name: string, detach: Detach | undefined, inPen: boolean) =>
  detach?.outcome === "resolve_owed" && detach.supersedes !== undefined
    ? {
        message:
          name +
          "'s link is gone, and GOAT is marking the purge it replaced resolved before it cleans the machine; it tries every 30 minutes, or a person runs " +
          resolve(detach.supersedes) +
          " on this hub." +
          held(inPen, true),
        nextAction: "A person may run the resolve command above on the hub.",
      }
    : undefined;

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

/**
 * A linked record whose retirement force stopped: a linked row offers Detach, which goes on with
 * that removal. Once the machine answers, only a removal OpenCodex left open or unsettled stays.
 */
const retirementStopped = (name: string, detach: Detach, failing: boolean, linkId: string) => {
  const operationId = detach.operationId ?? "";
  const detachIt = " detaches it" + WHERE;
  const outcome = detach.outcome;
  // An unknown entry may own its removal: the same id first, resolved only if it stays unknown.
  const repeatFirst =
    "A person fixes what stopped it, then" +
    detachIt +
    ", which repeats it first; if it stays unknown, they check the machine, run " +
    resolve(operationId) +
    " on this hub, then detach it again.";
  const repeatFirstNext =
    "A person fixes what stopped that removal on the hub, then" +
    detachIt +
    "; if it stays unknown, they resolve it on the hub and detach it again.";
  if (!failing) {
    if (outcome === "open")
      return {
        message:
          name +
          " answers again, but GOAT's earlier removal of its link without it is still open in OpenCodex (operation " +
          operationId +
          "). A person fixes what stopped it on this hub, then" +
          detachIt +
          ", which repeats it first.",
        nextAction: "A person fixes what stopped that removal on the hub, then" + detachIt + ".",
      };
    if (outcome === "unsettled")
      return {
        message:
          name +
          " answers again, but GOAT's earlier removal of its link without it reads unknown in OpenCodex. " +
          repeatFirst,
        nextAction: repeatFirstNext,
      };
    // The read-back could not read the journal: nothing is known to be owed yet.
    return {
      message:
        name +
        " answers again; GOAT could not yet read its earlier removal of the link without it (operation " +
        operationId +
        ") and reads it again within 30 minutes. A person's Detach" +
        WHERE +
        " reads it first: it repeats that removal if OpenCodex still holds it, and otherwise removes the link together with the machine.",
      nextAction:
        "A person may detach it, which repeats that removal if OpenCodex still holds it and otherwise removes the link together with the machine.",
    };
  }
  const code = detach.refusal ?? (detach.stop === "revoke_refused" ? outcome : undefined);
  const why =
    detach.stop === "tombstone_limit"
      ? "too many links removed without their machines wait for cleanup on this hub (operation " +
        operationId +
        "). A person recovers or forgets some (ocx link recover --list), then" +
        detachIt +
        ", which repeats that removal."
      : detach.stop === "link_retirement_owned"
        ? "an unfinished removal holds its link in OpenCodex (link_retirement_owned). " +
          ownerWayOut(linkId) +
          ", then" +
          detachIt +
          "."
        : outcome === "unsettled"
          ? "it reads unknown in OpenCodex. " + repeatFirst
          : "OpenCodex refused, never recorded or never finished operation " +
            operationId +
            (code === undefined ? "" : " (it answered " + code + ")") +
            ". A person fixes what stopped it on this hub, then" +
            detachIt +
            ", which repeats that removal.";
  return {
    message:
      name +
      " did not answer for 24 hours, but GOAT's removal of its link without it stopped: " +
      why,
    nextAction:
      detach.stop === "tombstone_limit"
        ? "A person recovers or forgets waiting cleanups on the hub, then" + detachIt + "."
        : detach.stop === "link_retirement_owned"
          ? "A person finishes the removal that holds the link on the hub, then" + detachIt + "."
          : outcome === "unsettled"
            ? repeatFirstNext
            : "A person fixes what stopped that removal on the hub, then" + detachIt + ".",
  };
};

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
        " presented another SSH host key than its link pinned, so GOAT stopped every step for it and sent it nothing. A person first forces the detach" +
        WHERE +
        ", which removes the link without contacting the machine, then removes the machine from Pen with pen revoke." +
        held(view.inPen, false),
      nextAction:
        "A person first forces the detach" +
        WHERE +
        ", then removes the machine from Pen with pen revoke.",
    };
  switch (view.state) {
    case "linked":
      if (detach?.force === true && detach.stop !== undefined)
        return retirementStopped(name, detach, (view.health?.failures ?? 0) > 0, linkId ?? "");
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
        const stop = stopOf(detach, detach.stop, linkId ?? "");
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
        return (
          resolveOwed(name, detach, view.inPen) ?? {
            message:
              name +
              (detach.elsewhere === true
                ? " is detaching: its link was removed outside GOAT, and GOAT asks OpenCodex every 30 minutes whether a cleanup of the machine waits"
                : " is detaching: its link is gone, and GOAT cleans the lightweight Child once the machine answers, trying every 30 minutes") +
              waits(detach) +
              forgetUnlessPending(linkId, detach) +
              held(view.inPen, true),
            nextAction: null,
          }
        );
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
      if (resolveOwed(name, detach, view.inPen) !== undefined)
        return resolveOwed(name, detach, view.inPen);
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
          forgetUnlessPending(linkId, detach) +
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
              ? " is detached: OpenCodex lists no link of this attach, but link operation " +
                (detach.operationId ?? "") +
                " never settled, so the machine may hold the planted Child (see ~/.cache/opencodex/bin/ocx-child connect status --json there)." +
                (detach.foreignLinkId === undefined
                  ? ""
                  : " Link " + detach.foreignLinkId + " under its alias is not GOAT's.")
              : detach?.outcome === "elsewhere"
                ? " is detached: its OpenCodex link was removed outside GOAT, so GOAT cannot tell whether the machine still holds the lightweight Child."
                : " is detached: its OpenCodex link and lightweight Child are gone.") +
          leave(view.inPen),
        nextAction:
          detach?.outcome === "unproven" && detach.operationId !== undefined
            ? "A person checks the machine, then runs " +
              resolve(detach.operationId) +
              " on this hub if the entry reads unknown or residual; an open entry cannot be resolved and is left as it is."
            : null,
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
