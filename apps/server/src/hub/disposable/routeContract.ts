import { isPenRunCommand, isRouteUser } from "../penSshRoute.ts";

/** What GOAT recorded for a disposable machine's route at attach step 3. */
export interface DisposableRoute {
  readonly nodeId: string;
  /** The Noise key the machine's provisioner reported and its invite was bound to. */
  readonly noisePub: string;
  /** penRunCommand for the node: the confirmed pen and its home, unquoted. */
  readonly proxyCommand: string;
  /** The User of Pen's block for the node, from the member's hostkeys record. */
  readonly user: string;
  /** GOAT's private known_hosts for this machine: one line, written once. */
  readonly knownHostsFile: string;
  /** The hub's machine key (machineKey.ts), the only identity offered. */
  readonly identityFile: string;
}

// ssh splits UserKnownHostsFile on spaces and expands % tokens and ${VAR} in it.
const FILE = /^\/[^\s"'%$]+$/u;
const ED25519_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/u;

/**
 * The arguments every SSH command GOAT runs for a disposable machine starts with. `-F none` reads
 * no ssh_config, so no config adds forwards, environment or identities; the options name the route.
 * The hub's machine key is the only identity offered, never the agent's keys or the default key
 * files. Undefined when a value could not be passed unchanged.
 */
const sharedOptions = (route: DisposableRoute) => {
  if (
    !isPenRunCommand(route.proxyCommand, route) ||
    !isRouteUser(route.user) ||
    !FILE.test(route.knownHostsFile) ||
    !FILE.test(route.identityFile)
  )
    return undefined;
  const options = [
    "BatchMode=yes",
    "ConnectTimeout=10",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
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
    "ForwardX11Trusted=no",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    `IdentityFile=${route.identityFile}`,
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "GSSAPIAuthentication=no",
    "GSSAPIDelegateCredentials=no",
    "AddKeysToAgent=no",
    "SendEnv=-*",
    "RemoteCommand=none",
    "RequestTTY=no",
    "EscapeChar=none",
    "Tunnel=no",
    "PermitRemoteOpen=none",
    "PermitLocalCommand=no",
  ];
  return ["-F", "none", ...options.flatMap((option) => ["-o", option])];
};

/** For a command run on the machine: no forward at all, the command line's included. */
export const disposableSshExecOptions = (route: DisposableRoute) => {
  const shared = sharedOptions(route);
  return shared && [...shared, "-o", "ClearAllForwardings=yes"];
};

/** For a tunnel: only the forwards the caller passes after these, and none that fail silently. */
export const disposableSshTunnelOptions = (route: DisposableRoute) => {
  const shared = sharedOptions(route);
  return shared && [...shared, "-o", "ExitOnForwardFailure=yes"];
};

/** The one line of a disposable machine's private known_hosts, or undefined for any other key. */
export const disposableKnownHosts = (nodeId: string, hostKey: string) =>
  /^[a-z2-7]{26}$/u.test(nodeId) && ED25519_KEY.test(hostKey)
    ? `pen-${nodeId} ${hostKey}\n`
    : undefined;
