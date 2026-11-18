import { type HubMachineStep } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { conflictCount } from "./attachModel.ts";
import { Detach, Health, onlyHostKeyConflict } from "./detachModel.ts";

/**
 * An attach's progress after Pen admits the machine (design section 2, steps 3 to 5): the route GOAT
 * recorded, whether it reached the machine with the hub's key, and the OpenCodex link operation.
 * Every value is GOAT's own fixed code; nothing the machine or OpenCodex printed is stored.
 */
const Note = Schema.Struct({ outcome: Schema.String, at: Schema.String });
const Enroll = Schema.Struct({
  route: Schema.optionalKey(Note),
  reach: Schema.optionalKey(Note),
  link: Schema.optionalKey(
    Schema.Struct({
      /** Operations started; each has its own id, <attachId>.link.<attempt>. */
      attempt: Schema.Number,
      /** When the current operation's id was first stored, before it was first sent. */
      intentAtMs: Schema.Number,
      /** How many times the current id was sent; OpenCodex never journalled the earlier ones. */
      sends: Schema.optionalKey(Schema.Number),
      /** When GOAT first read the entry as open. */
      openSinceMs: Schema.optionalKey(Schema.Number),
      /** When the journal first could not be read, since the last answer it gave. */
      unreadableSinceMs: Schema.optionalKey(Schema.Number),
      outcome: Schema.optionalKey(Schema.String),
    }),
  ),
  /** The folder or symlink on the key's path that holds the link (key_dir_*, key_symlink_foreign). */
  keyDir: Schema.optionalKey(Schema.String),
  /** Why the attach stopped and only a person can move it on. */
  stop: Schema.optionalKey(Schema.String),
  /** Removing the link: detach, retirement, recover (detachModel.ts). */
  detach: Schema.optionalKey(Detach),
  /** The handshake of a linked or detaching machine, every 30 minutes. */
  health: Schema.optionalKey(Health),
  /** The link names a machine key path that no longer holds the key: GOAT's home moved. */
  linkKeyMoved: Schema.optionalKey(Schema.Literal(true)),
});
export type Enroll = typeof Enroll.Type;
const EnrollJson = Schema.fromJsonString(Enroll);
const decodeEnrollJson = Schema.decodeOption(EnrollJson);
/** An unreadable progress reads as stopped, so nothing acts on it. */
export const decodeEnroll = (json: string): Enroll =>
  Option.getOrElse(decodeEnrollJson(json), () => ({ stop: "unreadable" }));
export const encodeEnroll = Schema.encodeSync(EnrollJson);

/** Whether a record's detach may run: no conflict, or a person's force past a changed host key only. */
export const detachRuns = (row: {
  readonly conflicts_json: string;
  readonly enroll_json: string;
}) =>
  conflictCount(row.conflicts_json) === 0 ||
  (decodeEnroll(row.enroll_json).detach?.force === true && onlyHostKeyConflict(row.conflicts_json));

/** The route recorded at step 3, which every later SSH command and the link use unchanged. */
const Route = Schema.Struct({
  proxyCommand: Schema.String,
  user: Schema.String,
  hostKey: Schema.String,
  fingerprint: Schema.String,
  knownHostsFile: Schema.String,
});
export type StoredRoute = typeof Route.Type;
const RouteJson = Schema.fromJsonString(Route);
const decodeRouteJson = Schema.decodeOption(RouteJson);
export const decodeRoute = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeRouteJson(json));
export const encodeRoute = Schema.encodeSync(RouteJson);

/** OpenCodex's link operations a Home must declare before GOAT links a machine (O1, O5, O6). */
export const LINK_CONTRACTS = ["link.route/1", "link.operation/1", "link.recover/1"] as const;
/**
 * Without this contract an explicit route carries no identity and the Home offers its own agent and
 * default keys. A disposable machine trusts only the hub's machine key, so the link waits for a Home
 * that takes it with the route (opencodex#8714, released in OpenCodex 2.100.3).
 */
export const LINK_IDENTITY_CONTRACT = "link.route/2";
export const linkIdentityArgs = (identityFile: string) => ["--ssh-identity-file", identityFile];
/**
 * How long an entry stays open before GOAT repeats its id. OpenCodex recovers a dead open entry only
 * on a repeat; while another apply still runs, its alias lock makes the repeat wait or refuse with
 * nothing journalled, so the repeat is safe whenever it lands.
 */
export const STALE_OPEN_MS = 10 * 60 * 1000;
/** OpenCodex replays an operation id's recorded answer for this long (link operation journal). */
export const OPERATION_REPLAY_MS = 2 * 60 * 60 * 1000;
/** Link operations an attach may start before it stops for a person. */
export const LINK_ATTEMPTS = 3;
/** Sends of one operation id that OpenCodex refuses before journalling it, before a person decides. */
export const LINK_SENDS = 3;
const SSH_PORT = 22;

export const linkOperationId = (attachId: string, attempt: number) => attachId + ".link." + attempt;

/** `ocx link add` for a disposable machine: planted ocx-child only, its own exclusive route. */
export const linkAddArgs = (input: {
  readonly alias: string;
  readonly route: StoredRoute;
  readonly operationId: string;
  readonly identityArgs: ReadonlyArray<string>;
}) => [
  "link",
  "add",
  input.alias,
  "--plant",
  "--require-ephemeral",
  "--expect-fingerprint",
  input.route.fingerprint,
  "--operation-id",
  input.operationId,
  "--proxy-command",
  input.route.proxyCommand,
  "--ssh-user",
  input.route.user,
  "--ssh-port",
  String(SSH_PORT),
  "--exclusive",
  ...input.identityArgs,
  "--json",
];

/** One entry of OpenCodex's link operation journal, as `ocx link operations --operation-id` prints it. */
const Operation = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.String,
  alias: Schema.String,
  state: Schema.String,
  reserved: Schema.optionalKey(Schema.Struct({ linkId: Schema.String })),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
  /** The Child may still hold an enrollment or a plant, whatever the outcome says of the Home. */
  childResidual: Schema.optionalKey(Schema.Boolean),
  /** A person or O5 resolved this residual or unknown entry. */
  resolvedAt: Schema.optionalKey(Schema.String),
});
const decodeOperation = Schema.decodeUnknownOption(Schema.fromJsonString(Operation));

export type LinkOutcome =
  | { readonly kind: "committed"; readonly linkId: string }
  | { readonly kind: "failed_clean"; readonly code: string }
  | {
      readonly kind: "unsettled";
      readonly state: "residual" | "unknown";
      readonly resolved?: true;
      /** The link id the operation reserved: the only link a later removal may take as this attach's. */
      readonly reservedLinkId?: string;
    }
  | { readonly kind: "open"; readonly reservedLinkId?: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "unreadable" };

const LINK_ID = /^lnk_[0-9a-f]{16}$/u;
// A status step outcome carries at most 40 characters (HubMachineStep).
const CODE = /^[a-z][a-z0-9_]{0,39}$/u;
/** Not found is ocx's exit 4 for a 404; anything else that is not a valid entry for this id is unreadable. */
export const readOperation = (
  output: { readonly code: number; readonly stdout: string },
  expected: { readonly operationId: string; readonly alias: string },
): LinkOutcome => {
  if (output.code === 4) return { kind: "not_found" };
  if (output.code !== 0) return { kind: "unreadable" };
  const operation = Option.getOrUndefined(decodeOperation(output.stdout));
  if (
    operation === undefined ||
    operation.operationId !== expected.operationId ||
    operation.kind !== "enroll" ||
    operation.alias.toLowerCase() !== expected.alias.toLowerCase()
  )
    return { kind: "unreadable" };
  const reserved = operation.reserved?.linkId;
  const reservedLinkId =
    reserved !== undefined && LINK_ID.test(reserved) ? { reservedLinkId: reserved } : {};
  switch (operation.state) {
    case "committed": {
      const linkId = operation.reserved?.linkId;
      return linkId !== undefined && LINK_ID.test(linkId)
        ? { kind: "committed", linkId }
        : { kind: "unreadable" };
    }
    case "failed_clean": {
      if (operation.childResidual === true)
        return { kind: "unsettled", state: "residual", ...reservedLinkId };
      const code = operation.error?.code;
      return {
        kind: "failed_clean",
        code: code !== undefined && CODE.test(code) ? code : "failed",
      };
    }
    case "residual":
    case "unknown":
      return {
        kind: "unsettled",
        state: operation.state,
        ...(operation.resolvedAt === undefined ? {} : { resolved: true as const }),
        ...reservedLinkId,
      };
    case "open":
      return { kind: "open", ...reservedLinkId };
    default:
      return { kind: "unreadable" };
  }
};

/** Refusals that no retry changes: the machine holds a full install, or cannot take ocx-child. */
export const FINAL_LINK_CODES: ReadonlySet<string> = new Set([
  "full_install_present",
  "require_ephemeral_unsupported",
]);

const LinkRow = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  childKind: Schema.optionalKey(Schema.String),
  exclusive: Schema.optionalKey(Schema.Boolean),
  explicitRoute: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ proxyCommand: Schema.String, user: Schema.String, port: Schema.Number }),
    ),
  ),
});
const decodeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ links: Schema.Array(LinkRow) })),
);

/**
 * What `ocx link status --json` says of the link this attach made: verified when it is an exclusive
 * ephemeral Child on exactly the recorded route, gone when the Home lists no such link.
 */
export const verifyLink = (
  stdout: string,
  expected: { readonly linkId: string; readonly alias: string; readonly route: StoredRoute },
): "verified" | "mismatch" | "gone" | "unreadable" => {
  const status = Option.getOrUndefined(decodeStatus(stdout));
  if (status === undefined) return "unreadable";
  const link = status.links.find((row) => row.id === expected.linkId);
  if (link === undefined) return "gone";
  const route = link.explicitRoute;
  return link.alias === expected.alias &&
    link.childKind === "ephemeral" &&
    link.exclusive === true &&
    route?.proxyCommand === expected.route.proxyCommand &&
    route.user === expected.route.user &&
    route.port === SSH_PORT
    ? "verified"
    : "mismatch";
};

export type ListedLink =
  | { readonly kind: "unreadable" }
  | { readonly kind: "none"; readonly aliasLinkId?: string }
  | { readonly kind: "ours"; readonly linkId: string }
  | { readonly kind: "foreign"; readonly linkId: string };
/**
 * The link OpenCodex lists for a machine whose last link operation it cannot settle: the id that
 * operation reserved (none listed means this attach has no link), or without one an exclusive
 * ephemeral Child on the record's route. A link that only shares the alias is foreign, and no
 * removal takes it.
 */
export const listedLink = (
  output: { readonly code: number; readonly stdout: string } | undefined,
  expected: {
    readonly alias: string;
    readonly reservedLinkId: string | undefined;
    readonly route: StoredRoute | undefined;
  },
): ListedLink => {
  if (output === undefined || output.code !== 0) return { kind: "unreadable" };
  const status = Option.getOrUndefined(decodeStatus(output.stdout));
  if (status === undefined) return { kind: "unreadable" };
  const named = status.links.filter(
    (link) => link.alias.toLowerCase() === expected.alias.toLowerCase(),
  );
  if (expected.reservedLinkId !== undefined) {
    const reserved = named.find((link) => link.id === expected.reservedLinkId);
    if (reserved !== undefined && LINK_ID.test(reserved.id))
      return { kind: "ours", linkId: reserved.id };
    // Not this attach's link; it is named so a person sees what GOAT left.
    const other = named.find((link) => LINK_ID.test(link.id));
    return other === undefined ? { kind: "none" } : { kind: "none", aliasLinkId: other.id };
  }
  const ours = named.find(
    (link) =>
      expected.route !== undefined &&
      link.childKind === "ephemeral" &&
      link.exclusive === true &&
      link.explicitRoute?.proxyCommand === expected.route.proxyCommand,
  );
  if (ours !== undefined && LINK_ID.test(ours.id)) return { kind: "ours", linkId: ours.id };
  const other = named.find((link) => LINK_ID.test(link.id));
  return other !== undefined ? { kind: "foreign", linkId: other.id } : { kind: "none" };
};

/** The steps after admission, for the status a caller sees. */
export const enrollSteps = (enroll: Enroll): ReadonlyArray<HubMachineStep> => [
  ...(enroll.route === undefined ? [] : [{ step: "route", outcome: enroll.route.outcome }]),
  ...(enroll.reach === undefined ? [] : [{ step: "reach", outcome: enroll.reach.outcome }]),
  ...(enroll.link?.outcome === undefined ? [] : [{ step: "link", outcome: enroll.link.outcome }]),
];

const STOPS: Record<string, string> = {
  sshd_pin_shared:
    "Another disposable machine presents the same SSH host key, so GOAT cannot tell them apart.",
  pin_changed: "Pen now advertises another SSH host key for this machine than GOAT recorded.",
  identity_file_missing: "OpenCodex refused this hub's machine key file: it could not find it.",
  identity_file_not_regular:
    "OpenCodex refused this hub's machine key file: it is not a regular file.",
  identity_file_permissions:
    "OpenCodex refused this hub's machine key file's owner or permissions; OpenCodex on this hub may run as another user than GOAT.",
  identity_file_directory:
    "OpenCodex refused this hub's machine key file: the folder holding it is not private to the user OpenCodex runs as, which may not be GOAT's. Run OpenCodex as GOAT's user, or move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass; never change a shared or system folder, even as root.",
  identity_file_ancestor:
    "OpenCodex refused this hub's machine key file: a folder above it or a symlink on its path is writable by others or belongs to another user than OpenCodex's. Run OpenCodex as GOAT's user, or move GOAT's home (GOAT_HOME or --base-dir) to a path that passes; never change a shared or system folder or another user's symlink, even as root.",
  identity_file_unreadable:
    "OpenCodex refused this hub's machine key file: it cannot read it or a folder on its path; OpenCodex on this hub may run as another user than GOAT.",
  identity_file_unsupported_platform:
    "OpenCodex refused this hub's machine key file: a Windows hub cannot use one.",
  known_hosts_edited:
    "GOAT's known_hosts file for this machine no longer holds only the host key Pen recorded; it was edited or damaged on the hub.",
  host_key_changed: "The machine presented another SSH host key than the one Pen recorded for it.",
  route_other_pen: "Pen's route for this machine names another Pen than the one confirmed here.",
  route_unsafe_pen_path: "The confirmed Pen's path cannot be passed to ssh unchanged.",
  route_several_keys: "Pen recorded more than one ed25519 host key for this machine.",
  full_install_present:
    "The machine has a full OpenCodex install; disposable machines take only the lightweight Child.",
  require_ephemeral_unsupported: "OpenCodex cannot plant its lightweight Child on this machine.",
  link_attempts_used: "Three link attempts failed.",
  journal_unreadable:
    "OpenCodex's link operation journal could not be read for two hours after GOAT sent the link; check it on the hub with ocx link operations.",
  machine_key_path:
    "OpenCodex accepts a key file path of letters, digits and . _ + / - only, and the path of GOAT's state folder holds another character.",
  link_stuck_open:
    "OpenCodex left the link operation open and did not settle it when GOAT repeated it.",
  link_not_started:
    "OpenCodex refused the link three times before recording it: it may not accept this hub's machine key file (OpenCodex running as another user, or a folder on the key's path others can write), the hub may already hold a link for this machine, its SSH host key may not match, or the link journal is full.",
  operation_lost:
    "OpenCodex no longer has the link operation GOAT started more than two hours ago, so GOAT cannot tell whether it linked the machine.",
  link_residual: "The link operation may have left an enrollment or a plant on the machine.",
  link_unknown: "OpenCodex cannot tell what the link operation left.",
  link_mismatch:
    "The Home's link for this machine is not the exclusive lightweight Child on the recorded route.",
  link_gone: "The Home no longer lists the link this attach made.",
  joined_without_admit:
    "Pen admitted it without an admit GOAT saved; its key is among Pen's members, so it holds its slot.",
  unreadable: "GOAT cannot read this attach's progress.",
};
const stopText = (stop: string) => STOPS[stop] ?? "The attach stopped and needs a person.";

const WAITING: Record<string, string> = {
  no_pen: "This hub has no confirmed Pen to read the machine's route from.",
  no_exact_block: "Pen has not written this machine's route yet.",
  no_user: "Pen has not recorded this machine's SSH user yet.",
  no_key: "Pen has not recorded this machine's SSH host key yet.",
  known_hosts_unwritable:
    "GOAT could not write the machine's known_hosts file in its state folder; it tries again on the next pass.",
  unreachable: "GOAT cannot reach the machine through Pen yet; it tries again on the next pass.",
  key_refused: "The machine refused this hub's machine key.",
  host_key_unknown:
    "ssh found no host key in GOAT's known_hosts for this machine; GOAT writes it again on the next pass.",
  unusable:
    "GOAT cannot pass this machine's route or key to ssh unchanged (a space or % in GOAT's state folder path).",
  key_symlink_foreign:
    "OpenCodex refuses a key whose path passes a symlink another user owns. Move GOAT's home (GOAT_HOME or --base-dir) to a path without it; never change another user's symlink, even as root.",
  key_dir_unsafe:
    "A folder of yours on the path of this hub's machine key can be written by its group or others, and its path is too long to show here. Move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass.",
  key_dir_shared:
    "A folder on the path of this hub's machine key can be written by its group or others, so OpenCodex refuses the key. Move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass; never change a shared or system folder, even as root.",
  key_dir_foreign:
    "A folder on the path of this hub's machine key belongs to another user, so OpenCodex refuses the key. Move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass; never change another user's folder, even as root.",
  key_dir_unreadable:
    "GOAT could not read a folder on the path of this hub's machine key, or the path passes too many symlinks. Move GOAT's home (GOAT_HOME or --base-dir) to a path this user can read without symlink loops; fix read access only on your own folders. GOAT tries again on the next pass.",
  machine_key_unusable:
    "This hub's machine key cannot be used: GOAT cannot read or make it, others can read it, its folder is a symlink, or it is not the plain ed25519 key file GOAT made.",
  opencodex_unsupported:
    "This hub's OpenCodex cannot record explicit routes and link operations; update OpenCodex on the hub.",
  identity_unsupported:
    "This hub's OpenCodex cannot link a machine with the hub's machine key; update OpenCodex on the hub to 2.100.3 or later.",
  journal_unreadable: "OpenCodex's link operation journal could not be read; GOAT asks again.",
  open: "OpenCodex is still running the link operation.",
  not_started: "OpenCodex did not record the link operation; GOAT sends it again on a later pass.",
  verify_unreadable: "OpenCodex's link status could not be read; GOAT asks again.",
};
const waitingText = (outcome: string | undefined) =>
  outcome === undefined ? undefined : WAITING[outcome];

/**
 * Texts naming the folder or symlink on the key's path, with the longest path each can carry within
 * the wire's 500 characters. chmod is offered only for the user's own folder (key_dir_unsafe).
 */
const PATH_TEXTS: Record<string, { readonly cap: number; readonly text: (at: string) => string }> =
  {
    key_dir_unsafe: {
      cap: 140,
      text: (at) =>
        at +
        " can be written by its group or others, so OpenCodex refuses the machine key under it. If only you use it, run chmod go-w " +
        at +
        " on the hub; if you share it on purpose, move GOAT's home (GOAT_HOME or --base-dir).",
    },
    key_dir_shared: {
      cap: 240,
      text: (at) =>
        at +
        " can be written by its group or others, so OpenCodex refuses the machine key under it. Move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass; never change a shared or system folder, even as root. GOAT tries again on the next pass.",
    },
    key_dir_foreign: {
      cap: 240,
      text: (at) =>
        at +
        " belongs to another user, so OpenCodex refuses the machine key under it. Move GOAT's home (GOAT_HOME or --base-dir) to a path whose folders pass; never change another user's folder, even as root. GOAT tries again on the next pass.",
    },
    key_symlink_foreign: {
      cap: 240,
      text: (at) =>
        "OpenCodex refuses a key whose path passes a symlink another user owns, " +
        at +
        ", who could point it elsewhere. Move GOAT's home (GOAT_HOME or --base-dir) to a path without it; never change another user's symlink, even as root.",
    },
  };
const pathText = (outcome: string | undefined, at: string | undefined) => {
  const entry = outcome === undefined ? undefined : PATH_TEXTS[outcome];
  return entry === undefined || at === undefined || at.length > entry.cap
    ? undefined
    : entry.text(at);
};

/** A machine that left Pen while this hub's OpenCodex held, or was making, a link for it. */
export const leftPenMessage = (
  name: string,
  final: boolean,
  linkId: string | null,
  operationId: string | null,
): { readonly message: string; readonly nextAction: string | null } => {
  if (!final)
    return {
      message: name + " left Pen; GOAT is reading what its link operation left on this hub.",
      nextAction: null,
    };
  if (linkId !== null)
    return {
      message:
        name +
        " was removed from Pen while this hub's OpenCodex held link " +
        linkId +
        " for it; the link and the Child on the machine stay. Remove the link on the hub with ocx link revoke --link-id " +
        linkId +
        "; if the machine is gone, add --force --yes, then run ocx link recover --forget --link-id " +
        linkId +
        " --yes for the cleanup it leaves.",
      nextAction: "A person runs the ocx link revoke command above on the hub.",
    };
  return {
    message:
      name +
      " was removed from Pen during link operation " +
      operationId +
      ", which OpenCodex had not settled. Check it on the hub with ocx link operations --operation-id " +
      operationId +
      ": OpenCodex settles an open operation when it is repeated with that id, and a link it made is removed with ocx link revoke.",
    nextAction: null,
  };
};

/**
 * The fixed text for an admitted attach (design section 2, "What the caller sees"); undefined for a
 * state the invite texts cover.
 */
/** Stops about the link operation itself; their text names its id. */
const OPERATION_STOPS: ReadonlySet<string> = new Set([
  "journal_unreadable",
  "operation_lost",
  "link_residual",
  "link_unknown",
  "link_stuck_open",
]);

export const enrollMessage = (
  state: string,
  name: string,
  enroll: Enroll,
  /** The record was paused after its machine joined, not by a join after the withdrawal. */
  pausedAfterJoin = false,
  /** The record's link operation, named in a stop about it. */
  operationId: string | null = null,
  /** A conflict stopped the record, which detach refuses. */
  conflicted = false,
): { readonly message: string; readonly nextAction: string | null } | undefined => {
  // Both clients show the message, so what a person must do is in it.
  const keyStep =
    "Add this hub's machine key to authorized_keys of the machine's SSH user if it is not there yet; Settings → Hub shows it with the machine on web and desktop.";
  const leave = " It stays a Pen member until a person removes it with pen revoke.";
  if (enroll.stop !== undefined && (state === "paused" || state === "unknown"))
    return {
      message:
        name +
        " joined Pen; its attach stopped: " +
        stopText(enroll.stop) +
        (operationId !== null && OPERATION_STOPS.has(enroll.stop)
          ? " Link operation " + operationId + "."
          : "") +
        leave,
      nextAction: conflicted
        ? "A person removes the machine from Pen with pen revoke; a record a conflict stopped cannot be detached."
        : "Detach it to remove what it left; resuming an attach is not available yet.",
    };
  if (state === "paused" && pausedAfterJoin)
    return {
      message:
        name +
        " joined Pen; its attach then lost its authority (the consent changed or ended, or the provisioner's grant did) before it was linked." +
        leave,
      nextAction: "Resuming an attach is not available yet.",
    };
  switch (state) {
    case "admitted":
      return {
        message:
          (waitingText(enroll.route?.outcome) ?? name + " joined Pen; checking its route.") +
          " " +
          keyStep,
        nextAction: null,
      };
    case "attaching":
      if (enroll.reach?.outcome !== "ok")
        return {
          message:
            (waitingText(enroll.reach?.outcome) ??
              name + "'s route is recorded; reaching it with the hub's machine key.") +
            " " +
            keyStep,
          nextAction: null,
        };
      return {
        message:
          pathText(enroll.link?.outcome, enroll.keyDir) ??
          waitingText(enroll.link?.outcome) ??
          "Linking " + name + " to this hub's OpenCodex as a lightweight Child.",
        nextAction: null,
      };
    case "linked":
      return {
        message: name + " is linked to this hub's OpenCodex as a lightweight Child.",
        nextAction:
          "GOAT's runtime and agents there come in a later version; it stays a Pen member until a person removes it from Pen.",
      };
    default:
      return undefined;
  }
};
