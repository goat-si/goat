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
}

/**
 * A Home's link revoke, recover and operation journal as OpenCodex v2.100.3 answers them
 * (structure/remote-link.md): a purge needs the Child, which answers remote_disconnect_failed when
 * it is silent or refuses with a hint; a forced revoke leaves a tombstone that recover settles once
 * the machine answers; a person's forget drops it. Installs itself on the enrollment fake's ocx.
 */
export const fakeDetachHome = (host: ReturnType<typeof fakeEnrollHost>) => {
  const revokes = new Map<string, RevokeEntry>();
  const tombstones = new Set<string>();
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const control = {
    /** The Child answers ssh; false is a machine that is off or gone. */
    machineAnswers: true,
    /** The Child refuses a purge with this hint. */
    childRefusal: undefined as string | undefined,
    /** Recover answers this refusal while the machine answers. */
    recoverRefusal: undefined as string | undefined,
    /** A forced revoke is refused, as OpenCodex does at 256 waiting tombstones. */
    tombstoneLimit: false,
    /** The next journal read fails, as a lost answer would. */
    loseRead: 0,
    revokes,
    tombstones,
    /** A person forgets a tombstone on the Home. */
    forget: (linkId: string) => tombstones.delete(linkId),
    sent: [] as Array<string>,
  };
  const refused = (code: number, refusal: OcxRefusal): OcxOutput => ({ code, stdout: "", refusal });
  const option = (args: ReadonlyArray<string>, name: string) => args[args.indexOf(name) + 1] ?? "";
  const revoke = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    const operationId = option(args, "--operation-id");
    const force = args.includes("--force");
    control.sent.push(operationId);
    const known = revokes.get(operationId);
    if (known?.state === "committed") return { code: 0, stdout: json({ linkId, operationId }) };
    if (!host.control.links.has(linkId)) return refused(4, { code: "link_not_found" });
    const entry: RevokeEntry = { operationId, linkId, force, state: "open" };
    revokes.set(operationId, entry);
    if (force) {
      if (control.tombstoneLimit) {
        entry.state = "failed_clean";
        entry.code = "tombstone_limit";
        return refused(5, { code: "tombstone_limit" });
      }
      tombstones.add(linkId);
      host.control.links.delete(linkId);
      entry.state = "committed";
      return { code: 0, stdout: json({ linkId, operationId, outcome: "committed" }) };
    }
    if (!control.machineAnswers || control.childRefusal !== undefined) {
      entry.state = "failed_clean";
      entry.code = "remote_disconnect_failed";
      return refused(1, {
        code: "remote_disconnect_failed",
        outcome: "failed_clean",
        ...(control.machineAnswers && control.childRefusal !== undefined
          ? { hint: control.childRefusal }
          : {}),
      });
    }
    host.control.links.delete(linkId);
    entry.state = "committed";
    entry.purged = true;
    return { code: 0, stdout: json({ linkId, operationId, outcome: "committed", purged: true }) };
  };
  const recover = (args: ReadonlyArray<string>): OcxOutput => {
    const linkId = option(args, "--link-id");
    if (host.control.links.has(linkId)) return refused(5, { code: "link_present" });
    if (!tombstones.has(linkId)) return refused(4, { code: "tombstone_not_found" });
    if (!control.machineAnswers)
      return refused(1, { code: "remote_recover_failed", hint: "ssh_failed" });
    if (control.recoverRefusal !== undefined) return refused(5, { code: control.recoverRefusal });
    tombstones.delete(linkId);
    return { code: 0, stdout: json({ linkId, outcome: "clean", purged: true }) };
  };
  host.control.extraOcx = (args) => {
    if (args[0] !== "link") return undefined;
    if (args[1] === "revoke") return revoke(args);
    if (args[1] === "recover") return recover(args);
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
        }),
      };
    }
    return undefined;
  };
  return control;
};
