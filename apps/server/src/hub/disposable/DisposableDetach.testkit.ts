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
    /** Recover answers this refusal while the machine answers. */
    recoverRefusal: undefined as string | undefined,
    /** A forced revoke is refused, as OpenCodex does at 256 waiting tombstones. */
    tombstoneLimit: false,
    /** The next forced revokes are refused before the journal (another operation holds the link). */
    busy: 0,
    /** The next journal reads fail, as a lost answer would. */
    loseRead: 0,
    revokes,
    tombstones,
    resolved: [] as Array<string>,
    /** A person forgets a tombstone on the Home. */
    forget: (linkId: string) => tombstones.delete(linkId),
    sent: [] as Array<string>,
  };
  const refused = (code: number, refusal: OcxRefusal): OcxOutput => ({ code, stdout: "", refusal });
  const option = (args: ReadonlyArray<string>, name: string) => args[args.indexOf(name) + 1] ?? "";
  const answer = (entry: RevokeEntry): OcxOutput => {
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
      ...(entry.state === "failed_clean" &&
      control.childRefusal !== undefined &&
      code === "remote_disconnect_failed"
        ? { hint: control.childRefusal }
        : {}),
    });
  };
  const revoke = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    const operationId = option(args, "--operation-id");
    const force = args.includes("--force");
    control.sent.push(operationId);
    const known = revokes.get(operationId);
    // A purge id replays; a forced one resumes unless it settled.
    if (
      known !== undefined &&
      (!force || known.state === "committed" || known.state === "failed_clean") &&
      !(force && known.code === "tombstone_limit")
    )
      return answer(known);
    if (force && control.busy > 0) {
      control.busy -= 1;
      return refused(5, { code: "link_operation_in_progress" });
    }
    if (!host.control.links.has(linkId)) return refused(4, { code: "link_not_found" });
    const entry: RevokeEntry = known ?? { operationId, linkId, force, state: "open" };
    revokes.set(operationId, entry);
    if (force) {
      if (control.tombstoneLimit) {
        entry.state = "failed_clean";
        entry.code = "tombstone_limit";
        return answer(entry);
      }
      tombstones.add(linkId);
      host.control.links.delete(linkId);
      entry.state = "committed";
      delete entry.code;
      return answer(entry);
    }
    if (!control.machineAnswers) {
      entry.state = "unknown";
      entry.code = "remote_disconnect_failed";
      return answer(entry);
    }
    if (control.childRefusal !== undefined || control.childMissing) {
      entry.state = "failed_clean";
      entry.code = "remote_disconnect_failed";
      return answer(entry);
    }
    host.control.links.delete(linkId);
    entry.state = "committed";
    entry.purged = true;
    return answer(entry);
  };
  const recover = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    if (host.control.links.has(linkId)) return refused(5, { code: "link_present" });
    if (!tombstones.has(linkId)) return refused(4, { code: "tombstone_not_found" });
    if (!control.machineAnswers)
      return refused(1, { code: "remote_recover_failed", hint: "ssh_failed" });
    if (control.childMissing)
      return refused(1, { code: "remote_recover_failed", hint: "managed_child_missing" });
    if (control.recoverRefusal !== undefined) return refused(5, { code: control.recoverRefusal });
    tombstones.delete(linkId);
    return { code: 0, stdout: json({ linkId, outcome: "clean", purged: true }) };
  };
  const resolve = (operationId: string): OcxOutput => {
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
