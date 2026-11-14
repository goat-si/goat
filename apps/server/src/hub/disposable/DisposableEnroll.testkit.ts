import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OcxOutput, PenExactRoute } from "../HubOcx.ts";
import type { PenNode } from "../penSshRoute.ts";
import { EnrollHost, KnownHostsError, type ReachAnswer } from "./EnrollHost.ts";
import { MachineKey } from "./machineKey.ts";
import type { KeyPathAnswer } from "./keyPath.ts";
import type { DisposableRoute } from "./routeContract.ts";

export const MACHINE_KEY_FILE = "/srv/goat/disposable/machine_ed25519";
export const MACHINE_KEY_LINE = "ssh-ed25519 " + "A".repeat(68) + " goat-disposable";
/** A key that exists once `identity` made it; `known` only reads. */
const fakeMachineKey = (control: { keysMade: number; keyFile: string }) =>
  MachineKey.of({
    identity: Effect.sync(() => {
      if (control.keysMade === 0) control.keysMade = 1;
      return { privateKeyFile: control.keyFile, publicLine: MACHINE_KEY_LINE };
    }),
    known: Effect.sync(() =>
      control.keysMade === 0
        ? undefined
        : { privateKeyFile: control.keyFile, publicLine: MACHINE_KEY_LINE },
    ),
  });

export const penRouteOf = (node: PenNode, hostKey = "ssh-ed25519 " + "K".repeat(68)) =>
  ({
    kind: "route",
    alias: "pen-" + node.nodeId,
    proxyCommand:
      "/opt/pen pipe --node " + node.nodeId + " --noise " + node.noisePub + " --home /srv/pen 22",
    user: "runner",
    hostKey,
    fingerprint: "SHA256:" + hostKey.slice(-12),
  }) satisfies PenExactRoute;

/** What a link add does, as OpenCodex's journal records it (structure/remote-link.md). */
export type AddScript =
  | "commit"
  /** Commits, but ocx exits nonzero, as a lost answer or a timed-out CLI does. */
  | "commit_lost"
  /** ocx never reached the Home: no journal entry. */
  | "not_journalled"
  | { readonly failedClean: string }
  | "residual"
  | "unknown"
  /** The Home stopped mid-operation: the entry stays open until the same id is repeated. */
  | "open"
  /** The Home refuses the key file before its journal opens, naming the hint. */
  | { readonly identityRefused: string; readonly journalled?: true };

/** Holds a call until released; `arrived` completes once `want` calls wait. */
export interface Hold {
  readonly want: number;
  readonly arrived: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  count: number;
}
export const makeHold = (want = 1) =>
  Effect.map(
    Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
    ([arrived, release]): Hold => ({ want, arrived, release, count: 0 }),
  );
const pass = (hold: Hold | undefined) =>
  hold === undefined
    ? Effect.void
    : Effect.suspend(() => {
        hold.count += 1;
        return (
          hold.count >= hold.want ? Deferred.succeed(hold.arrived, undefined) : Effect.void
        ).pipe(Effect.andThen(Deferred.await(hold.release)));
      });

interface Operation {
  readonly operationId: string;
  readonly alias: string;
  state: string;
  linkId: string;
  code?: string;
}

/**
 * A Home and a Pen as enrollment sees them: Pen's route per node (none until a test names one),
 * the machine's known_hosts, which machines answer ssh, and OpenCodex's link operation journal
 * and links, keyed by operation id as the Home keeps them.
 */
export const fakeEnrollHost = () => {
  const journal = new Map<string, Operation>();
  const links = new Map<string, Record<string, unknown>>();
  const control = {
    routes: new Map<string, PenExactRoute>(),
    knownHosts: new Map<string, string>(),
    unreachable: new Set<string>(),
    /** What a reach of the node answers; nodes in unreachable refuse the key. */
    reachAnswers: new Map<string, ReachAnswer>(),
    reached: [] as Array<DisposableRoute>,
    /** Scripts for the next link adds, in order; "commit" once they run out. */
    adds: [] as Array<AddScript>,
    calls: [] as Array<ReadonlyArray<string>>,
    statusUnreadable: false,
    keysMade: 0,
    keyFile: MACHINE_KEY_FILE,
    /** What the check of the key's path for OpenCodex answers. */
    keyPath: { kind: "ok" } as KeyPathAnswer,
    /** Hold Pen's route read, the reach, or the journal read until a test releases them. */
    holdRoute: undefined as Hold | undefined,
    holdReach: undefined as Hold | undefined,
    holdKnownHosts: undefined as Hold | undefined,
    knownHostsUnwritable: false,
    /** Where GOAT's state folder keeps known_hosts now; a moved home changes it. */
    knownHostsDir: "/srv/goat/disposable/known_hosts/",
    /** A listener that does not serve the journal: ocx exits 4 for every journal read. */
    journalRouteMissing: false,
    /** Every read of one journal entry fails, as a stopped Home or a timeout does. */
    journalUnreadable: false,
    /** A repeat of an open entry leaves it open, as a Home that keeps failing to recover it would. */
    openStaysOpen: false,
    /** Runs as each link add arrives, before it answers. */
    onAdd: undefined as (() => void) | undefined,
    holdOperations: undefined as Hold | undefined,
    journal,
    links,
    /** The Home pruned this settled entry, as it may after 2 hours. */
    forget: (operationId: string) => journal.delete(operationId),
  };
  let nextLink = 1;
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const output = (code: number, stdout = ""): OcxOutput => ({ code, stdout });
  const add = (args: ReadonlyArray<string>) => {
    control.onAdd?.();
    const alias = args[2] ?? "";
    const operationId = args[args.indexOf("--operation-id") + 1] ?? "";
    const known = journal.get(operationId);
    if (known !== undefined) {
      // A repeat recovers a dead open entry by its reserved ids (link-operation.ts recoverEnroll).
      if (known.state === "open" && !control.openStaysOpen) known.state = "unknown";
      return output(known.state === "committed" ? 0 : 1);
    }
    const script = control.adds.shift() ?? "commit";
    if (script === "not_journalled") return output(1);
    if (typeof script === "object" && "identityRefused" in script) {
      if (script.journalled === true) {
        const linkId = "lnk_" + String(nextLink++).padStart(16, "0");
        journal.set(operationId, { operationId, alias, state: "committed", linkId });
        links.set(linkId, {
          id: linkId,
          alias,
          childKind: "ephemeral",
          exclusive: true,
          explicitRoute: {
            proxyCommand: args[args.indexOf("--proxy-command") + 1],
            user: args[args.indexOf("--ssh-user") + 1],
            port: Number(args[args.indexOf("--ssh-port") + 1]),
          },
        });
      }
      return { code: 1, stdout: "", phase: script.identityRefused };
    }
    const linkId = "lnk_" + String(nextLink++).padStart(16, "0");
    const operation: Operation = { operationId, alias, state: "committed", linkId };
    journal.set(operationId, operation);
    if (typeof script === "object" && "failedClean" in script) {
      operation.state = "failed_clean";
      operation.code = script.failedClean;
      return output(1);
    }
    if (script === "residual" || script === "unknown" || script === "open") {
      operation.state = script;
      return output(1);
    }
    links.set(linkId, {
      id: linkId,
      alias,
      childKind: "ephemeral",
      exclusive: true,
      explicitRoute: {
        proxyCommand: args[args.indexOf("--proxy-command") + 1],
        user: args[args.indexOf("--ssh-user") + 1],
        port: Number(args[args.indexOf("--ssh-port") + 1]),
      },
    });
    return output(script === "commit" ? 0 : 1, json({ linkId, alias }));
  };
  const service = EnrollHost.of({
    route: (node) =>
      pass(control.holdRoute).pipe(
        Effect.andThen(Effect.sync(() => control.routes.get(node.nodeId))),
      ),
    journalServed: Effect.sync(() => !control.journalRouteMissing),
    keyPath: () => Effect.sync(() => control.keyPath),
    knownHosts: (attachId, line) =>
      Effect.suspend(() => pass(control.holdKnownHosts)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (control.knownHostsUnwritable)
              return Effect.fail(new KnownHostsError({ reason: "unwritable" }));
            const known = control.knownHosts.get(attachId);
            if (known !== undefined && known !== line)
              return Effect.fail(new KnownHostsError({ reason: "changed" }));
            control.knownHosts.set(attachId, line);
            return Effect.succeed(control.knownHostsDir + attachId);
          }),
        ),
      ),
    reach: (route) =>
      pass(control.holdReach).pipe(
        Effect.andThen(
          Effect.sync(() => {
            control.reached.push(route);
            // ssh finds no host key in a file under a home that moved away.
            if (!route.knownHostsFile.startsWith(control.knownHostsDir)) return "host_key_unknown";
            return (
              control.reachAnswers.get(route.nodeId) ??
              (control.unreachable.has(route.nodeId) ? "key_refused" : "ok")
            );
          }),
        ),
      ),
    ocx: (args) =>
      (args[1] === "operations" ? pass(control.holdOperations) : Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            control.calls.push(args);
            if (args[0] === "link" && args[1] === "add") return add(args);
            if (args[0] === "link" && args[1] === "operations" && control.journalUnreadable)
              return output(1);
            if (args[0] === "link" && args[1] === "operations" && control.journalRouteMissing)
              return output(4);
            if (args[0] === "link" && args[1] === "operations") {
              const operation = journal.get(args[3] ?? "");
              if (operation === undefined) return output(4);
              return output(
                0,
                json({
                  operationId: operation.operationId,
                  kind: "enroll",
                  alias: operation.alias,
                  state: operation.state,
                  reserved: { linkId: operation.linkId, apiKeyId: "k", tunnelPort: 7000 },
                  effects: [],
                  ...(operation.code === undefined
                    ? {}
                    : { error: { code: operation.code, status: 409 } }),
                }),
              );
            }
            if (args[0] === "link" && args[1] === "status")
              return control.statusUnreadable
                ? output(1)
                : output(0, json({ role: "home", links: [...links.values()] }));
            return output(2);
          }),
        ),
      ),
  });
  return { service, control, machineKey: fakeMachineKey(control) };
};
