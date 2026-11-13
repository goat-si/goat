import { isPinnedPenRoute } from "../penSshRoute.ts";

/** What GOAT recorded for a disposable machine's route at attach step 3. */
export interface DisposableRoute {
  readonly nodeId: string;
  /** The Noise key the machine's provisioner reported and its invite was bound to. */
  readonly noisePub: string;
  /** Pen's exact ProxyCommand for the node, naming the confirmed Pen home. */
  readonly proxyCommand: string;
  /** The User of Pen's block for the node, from the member's hostkeys record. */
  readonly user: string;
  /** GOAT's private known_hosts for this machine: one line, written once. */
  readonly knownHostsFile: string;
}

const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;
// ssh splits UserKnownHostsFile on spaces and expands % tokens in it.
const FILE = /^\/[^\s"'%]+$/u;
const ED25519_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/u;

/**
 * The options every SSH command GOAT runs for a disposable machine carries. Command-line options
 * win over every ssh_config, so a later config edit cannot move the route, reuse another
 * connection, or accept another key. Undefined when a value could not be passed unchanged.
 */
export const disposableSshOptions = (route: DisposableRoute) => {
  if (
    !isPinnedPenRoute(route.proxyCommand, route) ||
    !USER.test(route.user) ||
    !FILE.test(route.knownHostsFile)
  )
    return undefined;
  return [
    "BatchMode=yes",
    "ControlMaster=no",
    "ControlPath=none",
    "KnownHostsCommand=none",
    "GlobalKnownHostsFile=none",
    `UserKnownHostsFile=${route.knownHostsFile}`,
    "StrictHostKeyChecking=yes",
    `HostKeyAlias=pen-${route.nodeId}`,
    // The private file holds only the ed25519 key; Pen records every key sshd has.
    "HostKeyAlgorithms=ssh-ed25519",
    "VerifyHostKeyDNS=no",
    "CheckHostIP=no",
    "UpdateHostKeys=no",
    "CanonicalizeHostname=no",
    "ProxyJump=none",
    "ProxyUseFdpass=no",
    "Port=22",
    `User=${route.user}`,
    `ProxyCommand=${route.proxyCommand}`,
    "ForwardAgent=no",
    "ForwardX11=no",
    "PermitLocalCommand=no",
  ].flatMap((option) => ["-o", option]);
};

/** The one line of a disposable machine's private known_hosts, or undefined for any other key. */
export const disposableKnownHosts = (nodeId: string, hostKey: string) =>
  /^[a-z2-7]{26}$/u.test(nodeId) && ED25519_KEY.test(hostKey)
    ? `pen-${nodeId} ${hostKey}\n`
    : undefined;
