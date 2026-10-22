import * as Effect from "effect/Effect";
import { SshHostKeyProbeError } from "./errors.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { parseSshDestination } from "@goat/shared/sshDestination";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const readOnlySshArgs = [
  "-T",
  ...[
    "ControlMaster=no",
    "ControlPath=none",
    "UpdateHostKeys=no",
    "PermitLocalCommand=no",
    "BatchMode=yes",
    "RemoteCommand=none",
    "RequestTTY=no",
    "ClearAllForwardings=yes",
    "ForwardAgent=no",
    "ForwardX11=no",
    "LogLevel=VERBOSE",
    "ConnectTimeout=10",
  ].flatMap((option) => ["-o", option]),
];

export const readOnlyProxyJumpArgs = Effect.fn("ssh/probe.resolveProxyJump")(function* (
  ssh: string,
  settings: ReadonlyMap<string, string>,
) {
  const jump = settings.get("proxyjump");
  if (!jump || jump === "none") return [];
  const hops = jump.split(",");
  const seen = new Set<string>();
  let firstProxy: string | undefined;
  // An explicit comma-separated route overrides later hops' configured routes. Only its
  // first hop can introduce another route; flatten that route before disabling ProxyJump.
  for (;;) {
    if (hops.length > 8 || seen.has(hops[0]!))
      return yield* new SshHostKeyProbeError({
        message: "SSH jump route loops or exceeds 8 hops.",
      });
    seen.add(hops[0]!);
    const parsed = parseSshDestination({ host: hops[0]!.replace(/^ssh:\/\//u, "") });
    if (!parsed.ok)
      return yield* new SshHostKeyProbeError({ message: "Invalid SSH jump destination." });
    const hop = parsed.destination;
    const resolved = yield* runPreflightProcess(ssh, [
      "-G",
      ...readOnlySshArgs,
      ...(hop.user ? ["-l", hop.user] : []),
      ...(hop.port ? ["-p", String(hop.port)] : []),
      "--",
      hop.hostname,
    ]);
    if (resolved.exitCode !== 0)
      return yield* new SshHostKeyProbeError({ message: "Could not resolve the SSH jump route." });
    const hopSettings = new Map(
      resolved.stdout.split(/\r?\n/u).map((line) => {
        const [key = "", ...value] = line.trim().split(/\s+/u);
        return [key, value.join(" ")] as const;
      }),
    );
    const nested = hopSettings.get("proxyjump");
    if (!nested || nested === "none") {
      const command = hopSettings.get("proxycommand");
      firstProxy = command && command !== "none" ? command : undefined;
      break;
    }
    hops.unshift(...nested.split(","));
  }
  // Windows OpenSSH spawns ProxyCommand directly; POSIX passes it to the shell.
  const quoteArg = ssh.endsWith(".exe")
    ? (value: string) => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
    : quote;
  let proxy: string | undefined;
  for (const hop of hops) {
    const args = [
      ssh,
      ...readOnlySshArgs,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ProxyJump=none",
      "-o",
      `ProxyCommand=${proxy ?? firstProxy ?? "none"}`,
    ];
    const parsed = parseSshDestination({ host: hop.replace(/^ssh:\/\//u, "") });
    const destination = parsed?.ok ? parsed.destination : undefined;
    if (destination?.user) args.push("-l", destination.user);
    if (destination?.port) args.push("-p", String(destination.port));
    // Each SSH process expands its own forwarding target; nested commands survive one expansion.
    const literal = args.map((arg) => quoteArg(arg.replaceAll("%", "%%")));
    proxy = [
      ...literal,
      "-W",
      quoteArg("[%h]:%p"),
      "--",
      quoteArg((destination?.hostname ?? hop).replaceAll("%", "%%")),
    ].join(" ");
  }
  return ["-o", "ProxyJump=none", "-o", `ProxyCommand=${proxy}`];
});
