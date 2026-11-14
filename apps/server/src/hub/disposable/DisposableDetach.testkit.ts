import * as Schema from "effect/Schema";

import type { OcxOutput } from "../HubOcx.ts";
import type { OcxRefusal } from "../ocxRefusal.ts";
import type { fakeEnrollHost } from "./DisposableEnroll.testkit.ts";

interface RevokeEntry {
  readonly operationId: string;
  readonly linkId: string;
  readonly force: boolean;
  state: string;
  code?: string;
  purged?: true;
  resolvedAt?: string;
  /**
   * A revoke that claimed its link's retirement receipt and failed at commit (unknown) owns that removal
   * until a repeat of its id finishes it or a person's plain --force takes it over.
   */
  ownsReceipt?: true;
}

/**
 * A Home's link revoke, recover and journal as OpenCodex v2.100.3 answers them for an ephemeral
 * Child with an explicit route (remote-plant.ts purgeDisconnectRemote, link-routes.ts, link.ts);
 * each answer it gives is listed on its control fields. Installs itself on the enrollment fake.
 */
export const fakeDetachHome = (host: ReturnType<typeof fakeEnrollHost>) => {
  const revokes = new Map<string, RevokeEntry>();
  const tombstones = new Set<string>();
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const control = {
    /** The Child answers ssh; false is a machine that is off or gone. */
    machineAnswers: true,
    /** The Child refuses a purge with this hint (link-bound refusals). */
    childRefusal: undefined as string | undefined,
    /** The machine has no planted ocx-child (managed_child_missing). */
    childMissing: false,
    /**
     * The machine answers, but its purge kept or did not report removing the planted ocx-child
     * (binary_in_use, purge_incomplete): unknown with remote_disconnect_failed, and the CLI line
     * carries no hint for either.
     */
    purgeIncomplete: false,
    /** A purge refused failed_clean with this code (the Child changed nothing). */
    purgeRefusal: undefined as string | undefined,
    /**
     * The Home cannot settle a purge (its journal's disk is full): the entry stays open. A repeat of
     * an open id then recovers it as recoverRevoke does: unknown, operation_interrupted, as the
     * cleanup was intended.
     */
    purgeOpen: false,
    /** The Home cannot settle a forced revoke either: the entry stays open, as for purgeOpen. */
    forceOpen: false,
    /** The next revokes are refused before the journal (operation_journal_full): never recorded. */
    journalRefuses: 0,
    /** The next resolves fail, as an unreadable journal would. */
    resolveFails: 0,
    /** Recover answers this refusal while the machine answers. */
    recoverRefusal: undefined as string | undefined,
    /** A forced revoke is refused, as OpenCodex does at 256 waiting tombstones. */
    tombstoneLimit: false,
    /**
     * The next revokes that reach their commit fail there (key_revoke_failed) after claiming the link's
     * retirement receipt: unknown, owning the removal. A repeat of that id resumes it and fails again
     * while this count lasts; a new journalled id is refused link_retirement_owned (foreignRetirement).
     */
    commitFails: 0,
    /**
     * Recover answers link_retirement_pending until a repeat of the committed forced revoke clears
     * its receipt; while pendingFault holds (a full disk), a repeat does not clear it.
     */
    pendingReceipt: false,
    pendingFault: false,
    /** The next forced revokes are refused before the journal (another operation holds the link). */
    busy: 0,
    /** The next journal reads fail, as a lost answer would. */
    loseRead: 0,
    /** The next revokes never reach the Home (GOAT stopped while sending): no answer, nothing recorded. */
    dropSends: 0,
    revokes,
    tombstones,
    resolved: [] as Array<string>,
    /** A person forgets a tombstone on the Home. */
    forget: (linkId: string) => tombstones.delete(linkId),
    /**
     * A person's ocx link revoke --force --yes without an operation id: it takes over any unfinished
     * removal, removes the link with a tombstone, and leaves each owner with its recorded outcome.
     */
    plainForce: (linkId: string) => {
      for (const entry of revokes.values()) if (entry.linkId === linkId) delete entry.ownsReceipt;
      if (!host.control.links.has(linkId)) return;
      remember(linkId);
      tombstones.add(linkId);
      host.control.links.delete(linkId);
    },
    /** A journalled revoke GOAT did not start failed at commit and owns the link's removal. */
    outsideOwner: (linkId: string) =>
      revokes.set("outside.1", {
        operationId: "outside.1",
        linkId,
        force: false,
        state: "unknown",
        code: "key_revoke_failed",
        ownsReceipt: true,
      }),
    sent: [] as Array<string>,
  };
  const refused = (code: number, refusal: OcxRefusal): OcxOutput => ({ code, stdout: "", refusal });
  const option = (args: ReadonlyArray<string>, name: string) => args[args.indexOf(name) + 1] ?? "";
  // Each link's alias, kept past its removal so recover knows which machine it reaches.
  const aliases = new Map<string, string>();
  const remember = (linkId: string) => {
    const alias = host.control.links.get(linkId)?.alias;
    if (typeof alias === "string") aliases.set(linkId, alias);
  };
  const nodeOf = (linkId: string) => (aliases.get(linkId) ?? "").replace(/^pen-/u, "");
  const answers = (linkId: string) => control.machineAnswers && host.control.inPen(nodeOf(linkId));
  host.control.silent = () => !control.machineAnswers;
  /** The CLI line prints a bound hint only on the answer that recorded it; a replay has none. */
  const answer = (entry: RevokeEntry, hint?: string): OcxOutput => {
    if (entry.state === "committed")
      return {
        code: 0,
        stdout: json({
          linkId: entry.linkId,
          operationId: entry.operationId,
          outcome: "committed",
          ...(entry.purged === true ? { purged: true } : {}),
        }),
      };
    const code = entry.code ?? "failed";
    return refused(code === "tombstone_limit" ? 5 : 1, {
      code,
      ...(entry.code === "tombstone_limit" ? {} : { outcome: entry.state }),
      ...(hint === undefined ? {} : { hint }),
    });
  };
  const revoke = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    const operationId = option(args, "--operation-id");
    const force = args.includes("--force");
    if (control.dropSends > 0) {
      control.dropSends -= 1;
      return { code: 1, stdout: "" };
    }
    control.sent.push(operationId);
    const known = revokes.get(operationId);
    // A repeat of an open entry recovers it (link-operation.ts replayOperation, recoverRevoke).
    if (known !== undefined && known.state === "open") {
      if (known.force ? control.forceOpen : control.purgeOpen)
        return refused(1, { code: "operation_journal_failed" });
      known.state = "unknown";
      known.code = "operation_interrupted";
      return answer(known);
    }
    // An id that owns its removal resumes it: reopened, then committed, or unknown again
    // (resumedRevokeJournal, settleResumedRevoke); a force whose record is still listed writes its
    // tombstone again.
    if (known !== undefined && known.ownsReceipt === true) {
      delete known.resolvedAt;
      if (control.commitFails > 0 || (known.force && control.tombstoneLimit)) {
        known.state = "unknown";
        if (control.commitFails > 0) {
          control.commitFails -= 1;
          known.code = "key_revoke_failed";
        } else known.code = "tombstone_limit";
        return answer(known);
      }
      if (known.force) tombstones.add(linkId);
      host.control.links.delete(linkId);
      known.state = "committed";
      delete known.code;
      delete known.ownsReceipt;
      return answer(known);
    }
    // Any other recorded id replays its answer, whatever its state.
    if (known !== undefined) {
      if (force && known.state === "committed" && !control.pendingFault)
        control.pendingReceipt = false;
      return answer(known);
    }
    if (force && control.busy > 0) {
      control.busy -= 1;
      return refused(5, { code: "link_operation_in_progress" });
    }
    if (control.journalRefuses > 0) {
      control.journalRefuses -= 1;
      return refused(5, { code: "operation_journal_full" });
    }
    // An open revoke of this link refuses every other revoke of it (openRevokeConflict).
    if ([...revokes.values()].some((entry) => entry.linkId === linkId && entry.state === "open"))
      return refused(5, { code: "link_operation_open" });
    // Another revoke of this link owns its retirement receipt: a new journalled id is refused.
    if (
      [...revokes.values()].some((entry) => entry.linkId === linkId && entry.ownsReceipt === true)
    )
      return refused(5, { code: "link_retirement_owned" });
    if (!host.control.links.has(linkId)) return refused(4, { code: "link_not_found" });
    remember(linkId);
    const entry: RevokeEntry = { operationId, linkId, force, state: "open" };
    revokes.set(operationId, entry);
    if (force) {
      if (control.tombstoneLimit) {
        entry.state = "failed_clean";
        entry.code = "tombstone_limit";
        return answer(entry);
      }
      if (control.forceOpen) return refused(1, { code: "operation_journal_failed" });
      if (control.commitFails > 0) return commitFailed(entry);
      tombstones.add(linkId);
      host.control.links.delete(linkId);
      entry.state = "committed";
      return answer(entry);
    }
    if (control.purgeOpen) {
      entry.state = "open";
      return refused(1, { code: "operation_journal_failed" });
    }
    if (control.purgeRefusal !== undefined) {
      entry.state = "failed_clean";
      entry.code = control.purgeRefusal;
      return answer(entry);
    }
    if (!answers(linkId) || control.purgeIncomplete) {
      entry.state = "unknown";
      entry.code = "remote_disconnect_failed";
      return answer(entry);
    }
    if (control.childRefusal !== undefined || control.childMissing) {
      entry.state = "failed_clean";
      entry.code = "remote_disconnect_failed";
      return answer(entry, control.childRefusal);
    }
    entry.purged = true;
    if (control.commitFails > 0) return commitFailed(entry);
    host.control.links.delete(linkId);
    entry.state = "committed";
    return answer(entry);
  };
  /** The commit after the claim fails: the link stays (a force's own tombstone goes), unknown. */
  const commitFailed = (entry: RevokeEntry): OcxOutput => {
    control.commitFails -= 1;
    entry.state = "unknown";
    entry.code = "key_revoke_failed";
    entry.ownsReceipt = true;
    return answer(entry);
  };
  const recover = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    if (host.control.links.has(linkId)) return refused(5, { code: "link_present" });
    if (!tombstones.has(linkId)) return refused(4, { code: "tombstone_not_found" });
    if (!answers(linkId)) return refused(1, { code: "remote_recover_failed", hint: "ssh_failed" });
    if (control.childMissing)
      return refused(1, { code: "remote_recover_failed", hint: "managed_child_missing" });
    if (control.recoverRefusal !== undefined) return refused(5, { code: control.recoverRefusal });
    if (control.pendingReceipt) return refused(5, { code: "link_retirement_pending" });
    tombstones.delete(linkId);
    return { code: 0, stdout: json({ linkId, outcome: "clean", purged: true }) };
  };
  const resolve = (operationId: string): OcxOutput => {
    if (control.resolveFails > 0) {
      control.resolveFails -= 1;
      return { code: 1, stdout: "" };
    }
    const entry = revokes.get(operationId);
    if (entry === undefined) return refused(4, { code: "operation_not_found" });
    if (entry.state !== "unknown" && entry.state !== "residual")
      return refused(5, { code: "operation_not_resolvable" });
    entry.resolvedAt ??= "2026-11-15T00:00:00.000Z";
    control.resolved.push(operationId);
    return {
      code: 0,
      stdout: json({ operationId, state: entry.state, resolvedAt: entry.resolvedAt }),
    };
  };
  host.control.extraOcx = (args) => {
    if (args[0] !== "link") return undefined;
    if (args[1] === "revoke") return revoke(args);
    if (args[1] === "recover") return recover(args);
    if (args[1] === "operations" && args[2] === "resolve")
      return resolve(option(args, "--operation-id"));
    if (args[1] === "operations") {
      const entry = revokes.get(option(args, "--operation-id"));
      if (entry === undefined) return undefined;
      if (control.loseRead > 0) {
        control.loseRead -= 1;
        return { code: 1, stdout: "" };
      }
      return {
        code: 0,
        stdout: json({
          operationId: entry.operationId,
          kind: "revoke",
          alias: "pen-x",
          state: entry.state,
          linkId: entry.linkId,
          effects: [],
          ...(entry.code === undefined ? {} : { error: { code: entry.code, status: 502 } }),
          ...(entry.purged === undefined
            ? {}
            : { receipt: { purged: true, linkId: entry.linkId } }),
          ...(entry.resolvedAt === undefined ? {} : { resolvedAt: entry.resolvedAt }),
        }),
      };
    }
    return undefined;
  };
  return control;
};
