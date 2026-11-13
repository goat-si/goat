import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OcxOutput, PenExactRoute } from "../HubOcx.ts";
import type { PenNode } from "../penSshRoute.ts";
import { EnrollHost, KnownHostsError } from "./EnrollHost.ts";
import { MachineKey } from "./machineKey.ts";
import type { DisposableRoute } from "./routeContract.ts";

export const MACHINE_KEY_FILE = "/srv/goat/disposable/machine_ed25519";
export const MACHINE_KEY_LINE = "ssh-ed25519 " + "A".repeat(68) + " goat-disposable";
export const fakeMachineKey = MachineKey.of({
  identity: Effect.succeed({ privateKeyFile: MACHINE_KEY_FILE, publicLine: MACHINE_KEY_LINE }),
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
  | "unknown";

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
    reached: [] as Array<DisposableRoute>,
    /** Scripts for the next link adds, in order; "commit" once they run out. */
    adds: [] as Array<AddScript>,
    calls: [] as Array<ReadonlyArray<string>>,
    statusUnreadable: false,
    journal,
    links,
    /** The Home pruned this settled entry, as it may after 2 hours. */
    forget: (operationId: string) => journal.delete(operationId),
  };
  let nextLink = 1;
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const output = (code: number, stdout = ""): OcxOutput => ({ code, stdout });
  const add = (args: ReadonlyArray<string>) => {
    const alias = args[2] ?? "";
    const operationId = args[args.indexOf("--operation-id") + 1] ?? "";
    const known = journal.get(operationId);
    if (known !== undefined) return output(known.state === "committed" ? 0 : 1);
    const script = control.adds.shift() ?? "commit";
    if (script === "not_journalled") return output(1);
    const linkId = "lnk_" + String(nextLink++).padStart(16, "0");
    const operation: Operation = { operationId, alias, state: "committed", linkId };
    journal.set(operationId, operation);
    if (typeof script === "object") {
      operation.state = "failed_clean";
      operation.code = script.failedClean;
      return output(1);
    }
    if (script === "residual" || script === "unknown") {
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
    route: (node) => Effect.sync(() => control.routes.get(node.nodeId)),
    knownHosts: (attachId, line) =>
      Effect.suspend(() => {
        const known = control.knownHosts.get(attachId);
        if (known !== undefined && known !== line)
          return Effect.fail(new KnownHostsError({ reason: "changed" }));
        control.knownHosts.set(attachId, line);
        return Effect.succeed("/srv/goat/disposable/known_hosts/" + attachId);
      }),
    reach: (route) =>
      Effect.sync(() => {
        control.reached.push(route);
        return !control.unreachable.has(route.nodeId);
      }),
    ocx: (args) =>
      Effect.sync(() => {
        control.calls.push(args);
        if (args[0] === "link" && args[1] === "add") return add(args);
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
  });
  return { service, control };
};
