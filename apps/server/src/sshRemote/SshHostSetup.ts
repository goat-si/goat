import * as PrepareAuthorization from "./SshHostPrepareAuthorization.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as MaintenanceAudit from "../maintenance/MaintenanceAudit.ts";
import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as ProviderHostSync from "../provider/ProviderHostSync.ts";
import * as ProviderSettings from "../provider/ProviderSettings.ts";
import {
  EnvironmentAuthorizationError,
  PROVIDER_SETTINGS_HANDOFF_PATH,
  PROVIDER_SETUP_HANDOFF_PATH,
  SshHostProbeError,
  HandoffError,
  SshHostAddInput,
  SshHostAlias,
  buildSshKeyAuthInstructions,
  hasCloudMachineAliasPrefix,
  type SshPreflightInput,
  type SshPreflightReport,
  type AuthSessionId,
  type Handoff,
  type HandoffRespondInput,
  type SshHostResult,
  type SshHostStatusInput,
  type SshRuntimeUpdateInput,
  type SshHostPrepareInput,
  type SshHostForgetInput,
  type SshHostTrustInput,
  type SshHostProbeResult,
  type SshHandoffProgressInput,
  type SshHandoffProgressResult,
  type SshHostSetupProgress,
} from "@goat/contracts";
import { discoverSshHosts } from "@goat/ssh/config";
import { resolveSshCommand } from "@goat/ssh/command";
import { parseSshDestination } from "@goat/shared/sshDestination";
import { runSshPreflight } from "@goat/ssh/preflight";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import { probeHostKey } from "@goat/ssh/hostKey";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- opaque IDs and stable alias hashes, never credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Diagnosis from "../provider/ProviderDiagnosisRouting.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readOnlySshArgs, readOnlyProxyJumpArgs } from "@goat/ssh/probeOptions";
import {
  makeManagedSshWriter,
  definesHostAlias,
  effectiveSettingsMatch,
  type ManagedSshEndpoint,
} from "../cloudMachines/sshConfig.ts";
import {
  authorizeApprovalRequest,
  authorizeSshHost,
  type SshHostCaller,
} from "./SshHostAuthorization.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";
export type { SshHostCaller } from "./SshHostAuthorization.ts";

type Failure = EnvironmentAuthorizationError | HandoffError;
export class SshHostSetup extends Context.Service<
  SshHostSetup,
  {
    readonly preflight: (
      input: SshPreflightInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshPreflightReport, EnvironmentAuthorizationError | SshHostProbeError>;
    readonly resolveDestination: (
      input: SshHostAddInput,
    ) => Effect.Effect<
      { input: SshHostAddInput; host?: string; managed?: boolean },
      SshHostProbeError
    >;
    readonly status: (input: SshHostStatusInput) => Effect.Effect<SshHostResult>;
    readonly update: (
      input: SshRuntimeUpdateInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshHostResult, Failure>;
    readonly probe: (
      input: SshHostAddInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<SshHostProbeResult, EnvironmentAuthorizationError | SshHostProbeError>;
    readonly trust: (
      input: SshHostTrustInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<SshHostResult, EnvironmentAuthorizationError>;
    readonly add: (
      input: SshHostAddInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshHostResult, Failure>;
    readonly prepare: (
      input: SshHostPrepareInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshHostResult, Failure>;
    readonly forget: (
      input: SshHostForgetInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshHostResult, EnvironmentAuthorizationError>;
    readonly respondHandoff: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, Failure>;
    readonly handoffProgress: (
      input: SshHandoffProgressInput,
      caller: { readonly kind: "client"; readonly sessionId: AuthSessionId },
    ) => Effect.Effect<SshHandoffProgressResult, Failure>;
    readonly resumeContinuations: Effect.Effect<void, HandoffError>;
  }
>()("goat/sshRemote/SshHostSetup") {}

const errorResult = (
  message: string,
  code:
    | "operation_failed"
    | "invalid_request"
    | "alias_conflict"
    | "cancelled" = "operation_failed",
): SshHostResult => ({
  kind: "error",
  code,
  message: message.slice(0, 2000),
  fix: { actor: "agent", instruction: "Try again" },
});
const dispatchFailure = (error: Dispatch.SshRemoteDispatchError): SshHostResult => ({
  kind: "error",
  code:
    error.reason === "host_unknown" || error.reason === "invalid_request"
      ? error.reason
      : error.reason === "host_unavailable"
        ? "host_unreachable"
        : "operation_failed",
  message: error.message.slice(0, 2000),
  fix: { actor: "agent", instruction: "Try again" },
});
const outsideThread = (instruction: string): SshHostResult => ({
  kind: "error",
  code: "unsupported",
  message: instruction,
  fix: { actor: "human", instruction },
});
const aliasFor = (input: SshHostAddInput) =>
  input.alias ??
  `goat-${input.address
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "-")
    .slice(0, 38)}-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.address, input.user, input.port ?? 22]))
    .digest("hex")
    .slice(0, 8)}`;
const Endpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  user: Schema.String,
  hostKey: Schema.String,
  proxyJump: Schema.optionalKey(Schema.String),
  proxyCommand: Schema.optionalKey(Schema.String),
});
const Challenge = Schema.Struct({
  input: SshHostAddInput,
  host: SshHostAlias,
  endpoint: Endpoint,
  fingerprint: Schema.String,
  algorithm: Schema.optionalKey(Schema.String),
  identityFile: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
  aliasGeneration: Schema.Int,
  includeRequired: Schema.Boolean,
});
type Challenge = typeof Challenge.Type;
const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  step: Schema.Literals(["runtime_update", "host_trust", "key_auth"]),
  host: SshHostAlias,
  operationId: Schema.String,
  aliasGeneration: Schema.Int,
  requestedVersion: Schema.optionalKey(Schema.String),
  aliasRevision: Schema.optionalKey(Schema.String),
  challenge: Schema.optional(Challenge),
});
const decodeContinuation = Schema.decodeUnknownEffect(Continuation);
const isProbeError = Schema.is(SshHostProbeError);
const isHandoffError = Schema.is(HandoffError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const decodeAlias = Schema.decodeUnknownEffect(SshHostAlias);
const isAlias = Schema.is(SshHostAlias);

export const make = (
  options: { readonly home?: string; readonly runPreflight?: typeof runSshPreflight } = {},
) =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const home = options.home ?? NodeOS.homedir();
    const audit = yield* MaintenanceAudit.MaintenanceAudit;
    const dispatch = yield* Dispatch.SshRemoteDispatch;
    const sessions = yield* SessionStore.SessionStore;
    const handoffs = yield* Handoffs.Handoffs;
    const providerHomeRequests = yield* Effect.serviceOption(HomeRequests.CodexHomeRequests);
    const providerHostSync = yield* Effect.serviceOption(ProviderHostSync.ProviderHostSync);
    const providerSettings = yield* Effect.serviceOption(ProviderSettings.ProviderSettings);
    const threads = yield* Threads.ThreadManagementService;
    const authorizePrepare = yield* PrepareAuthorization.make;
    const environment = yield* Environment.ServerEnvironment;
    const diagnosis = yield* Diagnosis.ProviderDiagnosisRouting;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const serviceScope = yield* Scope.Scope;
    const runtime = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | import("effect/process/ChildProcessSpawner").ChildProcessSpawner
    >();
    const writer = yield* makeManagedSshWriter({
      home,
      directory: "goat-hosts",
      isAlias: (alias) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias) && !hasCloudMachineAliasPrefix(alias),
    });
    const directory = path.join(home, ".ssh", "goat-hosts");
    const challenges = new Map<string, { challenge: Challenge; sessionId: AuthSessionId }>();
    const aliasGenerations = new Map<string, number>();
    const jobs = new Map<
      string,
      {
        operation: SshHostSetupProgress;
        first: Deferred.Deferred<SshHostResult>;
        fiber: Fiber.Fiber<void, never>;
      }
    >();
    const continuing = new Set<string>();
    const continuationAdmission = yield* Semaphore.make(1);
    const admission = yield* Semaphore.make(1);
    const authorize = (caller: SshHostCaller, scope: Parameters<typeof authorizeSshHost>[2]) =>
      authorizeSshHost(sessions, caller, scope);
    const status = (input: SshHostStatusInput) =>
      dispatch.runtimeStatus(input.host).pipe(
        Effect.catchTags({
          SshRemoteDispatchError: (error) => Effect.succeed(dispatchFailure(error)),
        }),
        Effect.flatMap((result) => {
          if (result.status?.keyAuth === undefined) return Effect.succeed(result);
          const snapshot = result.status;
          return environment.getDescriptor.pipe(
            Effect.map((origin) => ({
              ...result,
              status: {
                ...snapshot,
                keyAuth: {
                  ...snapshot.keyAuth!,
                  originLabel: origin.label,
                  instruction: snapshot.keyAuth!.instruction.replace(
                    `Run this on ${snapshot.keyAuth!.originLabel}.`,
                    `Run this on ${origin.label}.`,
                  ),
                },
              },
            })),
          );
        }),
      );
    const readOptional = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
    const aliasRevision = (host: string) =>
      Effect.gen(function* () {
        const conf = yield* readOptional(path.join(directory, `${host}.conf`));
        if (conf === null) return undefined;
        const pin = yield* readOptional(path.join(directory, `${host}.known_hosts`));
        const metadata = yield* fs.stat(path.join(directory, `${host}.conf`));
        return NodeCrypto.createHash("sha256")
          .update(`${conf}\0${pin ?? ""}\0${Option.getOrNull(metadata.mtime)?.getTime() ?? ""}`)
          .digest("hex");
      });
    const probeFailure = (input: SshHostAddInput, reason: SshHostProbeError["reason"]) =>
      new SshHostProbeError({
        host: input.alias ?? input.address,
        reason,
        message:
          reason === "unreachable"
            ? `Can't reach ${input.alias ?? input.address}.`
            : reason === "connection_refused"
              ? `${input.alias ?? input.address} refused the connection.`
              : reason === "invalid_request"
                ? "Check the SSH address, user, port and alias."
                : reason === "alias_conflict"
                  ? "This SSH alias is already in use or its key changed."
                  : "Could not check this SSH host. Try again.",
      });
    // hostKey intentionally returns no raw SSH stderr. On failure only, collect a bounded,
    // authentication-free diagnostic using disposable known_hosts, preserving jump routing.
    const classifyProbeFailure = (input: SshHostAddInput, settings: ReadonlyMap<string, string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "goat-probe-error-" });
          yield* fs.chmod(temporary, 0o700);
          const knownHosts = path.join(temporary, "known_hosts");
          yield* fs.writeFileString(knownHosts, "", { mode: 0o600, flag: "wx" });
          const ssh = yield* resolveSshCommand;
          const proxyArgs = yield* readOnlyProxyJumpArgs(ssh, settings).pipe(
            Effect.provide(runtime),
          );
          const output = yield* runner.run({
            command: ssh,
            args: [
              ...readOnlySshArgs,
              ...proxyArgs,
              ...(input.user ? ["-l", input.user] : []),
              ...(input.port ? ["-p", String(input.port)] : []),
              "-o",
              "PreferredAuthentications=none",
              "-o",
              "StrictHostKeyChecking=accept-new",
              "-o",
              `UserKnownHostsFile="${knownHosts.replaceAll("\\", "/").replaceAll('"', '\\"')}"`,
              "-o",
              "GlobalKnownHostsFile=/dev/null",
              input.address,
              "exit",
              "0",
            ],
            timeout: "20 seconds",
            timeoutBehavior: "timedOutResult",
          });
          const evidence = output.stderr;
          return probeFailure(
            input,
            /connection refused/iu.test(evidence)
              ? "connection_refused"
              : output.timedOut ||
                  /timed out|no route to host|network is unreachable|could not resolve hostname|name or service not known|nodename nor servname/iu.test(
                    evidence,
                  )
                ? "unreachable"
                : "operation_failed",
          );
        }),
      ).pipe(Effect.orElseSucceed(() => probeFailure(input, "operation_failed")));
    const collect = (input: SshHostAddInput) =>
      Effect.gen(function* () {
        const host = yield* decodeAlias(aliasFor(input));
        if (
          hasCloudMachineAliasPrefix(host) ||
          [input.address, input.user, input.identityFile].some(
            (v) => v !== undefined && (!v.trim() || v.startsWith("-") || /[\r\n\0]/u.test(v)),
          )
        )
          return yield* new HandoffError({ reason: "invalid_request" });
        const generation = aliasGenerations.get(host) ?? 0;
        const pin = yield* readOptional(path.join(directory, `${host}.known_hosts`));
        const config = yield* readOptional(path.join(home, ".ssh", "config"));
        if (
          pin === null &&
          (definesHostAlias(config ?? "", host) ||
            (yield* fs.exists(path.join(home, ".ssh", "goat-cloud", `${host}.conf`))))
        )
          return yield* new HandoffError({ reason: "conflict" });
        if (pin === null) {
          const known = yield* discoverSshHosts({ homeDir: home }).pipe(Effect.provide(runtime));
          if (
            known.some(
              (entry) =>
                entry.source === "ssh-config" && entry.alias.toLowerCase() === host.toLowerCase(),
            )
          )
            return yield* new HandoffError({ reason: "conflict" });
        }
        const resolved = yield* runner.run({
          command: "ssh",
          args: [
            "-G",
            ...(input.user ? ["-l", input.user] : []),
            ...(input.port ? ["-p", String(input.port)] : []),
            input.address,
          ],
          timeout: "20 seconds",
        });
        if (resolved.code !== 0) return yield* new HandoffError({ reason: "unavailable" });
        const settings = new Map(
          resolved.stdout.split(/\r?\n/u).map((line) => {
            const [key = "", ...value] = line.split(/\s+/u);
            return [key, value.join(" ")] as const;
          }),
        );
        const key = yield* probeHostKey({
          target: input.address,
          ...(input.user ? { user: input.user } : {}),
          ...(input.port ? { port: input.port } : {}),
        }).pipe(
          Effect.provide(runtime),
          Effect.catch(() =>
            classifyProbeFailure(input, settings).pipe(Effect.flatMap(Effect.fail)),
          ),
        );
        const endpoint: ManagedSshEndpoint = {
          host: settings.get("hostname") ?? input.address,
          port: Number(settings.get("port") ?? input.port ?? 22),
          user: settings.get("user") ?? input.user ?? "",
          hostKey: `${key.algorithm} ${key.key}`,
          ...(settings.get("proxyjump") && settings.get("proxyjump") !== "none"
            ? { proxyJump: settings.get("proxyjump")! }
            : {}),
          ...(settings.get("proxycommand") && settings.get("proxycommand") !== "none"
            ? { proxyCommand: settings.get("proxycommand")! }
            : {}),
        };
        if (pin !== null && pin.trim() !== `${host} ${endpoint.hostKey}`)
          return yield* new HandoffError({
            reason: "conflict",
            cause: { reason: "host_key_changed" },
          });
        let identityFile = input.identityFile;
        if (identityFile === undefined) {
          for (const line of resolved.stdout.split(/\r?\n/u)) {
            if (!line.startsWith("identityfile ")) continue;
            const candidate = line.slice(13).replace(/^~(?=\/)/u, home);
            if (yield* fs.exists(candidate)) {
              identityFile = candidate;
              break;
            }
          }
        }
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if ((aliasGenerations.get(host) ?? 0) !== generation)
          return yield* new HandoffError({ reason: "expired" });
        return {
          input,
          host,
          endpoint,
          fingerprint: key.fingerprint,
          algorithm: key.algorithm,
          ...(identityFile ? { identityFile } : {}),
          expiresAt: now + 24 * 60 * 60 * 1000,
          aliasGeneration: generation,
          includeRequired: !/^\s*Include\s+~\/\.ssh\/goat-hosts\/\*\.conf\s*$/imu.test(
            config ?? "",
          ),
        } satisfies Challenge;
      }).pipe(
        Effect.mapError((cause) =>
          isHandoffError(cause) ? cause : new HandoffError({ reason: "unavailable", cause }),
        ),
      );
    const humanFor = (input: Challenge) => {
      const challenge = {
        ...input,
        algorithm: input.algorithm ?? input.endpoint.hostKey.split(" ")[0],
      };
      // Name the host the person entered; the managed alias is GOAT's bookkeeping.
      const entered = parseSshDestination({ host: input.input.address });
      const shown = entered.ok ? entered.destination.hostname : challenge.host;
      const saved = shown === challenge.host ? "" : ` and save it as ${challenge.host}`;
      return {
        location: `${shown} presented this key. GOAT will connect as ${challenge.endpoint.user}${saved}.${challenge.includeRequired ? " Approving also adds one Include line to ~/.ssh/config." : ""}`,
        fingerprint: `${challenge.fingerprint} (${challenge.algorithm})`,
      };
    };
    const resolveDestination: SshHostSetup["Service"]["resolveDestination"] = (input) =>
      Effect.gen(function* () {
        const parsed = parseSshDestination({
          host: input.address,
          user: input.user,
          port: input.port,
        });
        const invalid = (message: string) =>
          new SshHostProbeError({ host: input.address, reason: "invalid_request", message });
        if (!parsed.ok) return yield* invalid(parsed.message);
        const target = parsed.destination;
        const hosts = yield* discoverSshHosts({ homeDir: home }).pipe(Effect.provide(runtime));
        const configured = hosts.find(
          (entry) =>
            entry.source === "ssh-config" &&
            entry.alias.toLowerCase() === target.hostname.toLowerCase(),
        );
        if (configured) {
          if (target.user !== null || target.port !== null || input.identityFile !== undefined)
            return yield* invalid(
              `Set User, Port and IdentityFile for ${configured.alias} in ${path.join(home, ".ssh", "config")}; configured aliases cannot have overrides.`,
            );
          return {
            input: { ...input, address: configured.alias },
            host: configured.alias,
            managed:
              (yield* fs.exists(path.join(directory, `${configured.alias}.conf`))) &&
              (yield* fs.exists(path.join(directory, `${configured.alias}.known_hosts`))),
          };
        }
        const normalized = {
          ...input,
          address: target.hostname,
          ...(target.user === null ? {} : { user: target.user }),
          ...(target.port === null ? {} : { port: target.port }),
        };
        const matchesSettings = (config: string) => {
          const fields = new Map<string, string>();
          for (const line of config.split(/\r?\n/u)) {
            const match = /^\s*(\S+)\s+(.+?)\s*$/u.exec(line);
            const key = match?.[1]?.toLowerCase();
            if (key && !fields.has(key)) fields.set(key, match![2]!.replace(/^"|"$/gu, ""));
          }
          return (
            fields.get("hostname")?.toLowerCase() === normalized.address.toLowerCase() &&
            Number(fields.get("port")) === (normalized.port ?? 22) &&
            (normalized.user === undefined || fields.get("user") === normalized.user) &&
            (normalized.identityFile === undefined ||
              fields.get("identityfile") === normalized.identityFile)
          );
        };
        const matchesDestination = (alias: string) =>
          Effect.gen(function* () {
            const config = yield* readOptional(path.join(directory, `${alias}.conf`));
            if (config === null || !matchesSettings(config)) return false;
            // OpenSSH's first matching setting can override the managed file.
            const effective = yield* runner.run({
              command: "ssh",
              args: ["-G", alias],
              timeout: "20 seconds",
            });
            return effective.code === 0 && matchesSettings(effective.stdout);
          });
        const host = aliasFor(normalized);
        if (yield* fs.exists(path.join(directory, `${host}.known_hosts`))) {
          if (!(yield* matchesDestination(host)))
            return yield* new SshHostProbeError({
              host,
              reason: "alias_conflict",
              message:
                "This managed SSH alias belongs to a different destination or identity. Choose another alias.",
            });
          return { input: normalized, host, managed: true };
        }
        if (input.alias === undefined && (yield* fs.exists(directory))) {
          const matches: string[] = [];
          for (const file of yield* fs.readDirectory(directory)) {
            if (!file.endsWith(".conf")) continue;
            const alias = file.slice(0, -5);
            if (
              !isAlias(alias) ||
              !(yield* fs.exists(path.join(directory, `${alias}.known_hosts`)))
            )
              continue;
            if (yield* matchesDestination(alias)) matches.push(alias);
          }
          if (matches.length === 1) return { input: normalized, host: matches[0]!, managed: true };
        }
        return { input: normalized };
      }).pipe(
        Effect.mapError((cause) =>
          isProbeError(cause)
            ? cause
            : new SshHostProbeError({
                host: input.address,
                reason: "operation_failed",
                message: "Could not resolve SSH configuration.",
              }),
        ),
      );
    const preflight: SshHostSetup["Service"]["preflight"] = (input, caller) =>
      Effect.gen(function* () {
        if (caller.kind === "mcp") {
          if (!caller.scope.capabilities.has("orchestration"))
            return yield* new EnvironmentAuthorizationError({
              requiredScope: "orchestration:read",
              message: "SSH preflight needs the orchestration capability.",
            });
        } else yield* authorize(caller, "settings:write");
        const resolved = yield* resolveDestination({ ...input, address: input.host });
        const owner = yield* environment.getDescriptor;
        const cliRunner = yield* Dispatch.resolveSshCliRunner(
          Option.isSome(config) ? config.value.baseDir : home,
        );
        const target = resolved.host
          ? { host: resolved.host }
          : { ...resolved.input, host: resolved.input.address };
        const report = yield* (options.runPreflight ?? runSshPreflight)(target, {
          ownerLabel: owner.label,
          runner: cliRunner,
          ...(resolved.host ? { alias: resolved.host } : {}),
        }).pipe(Effect.provide(runtime), Effect.provide(FetchHttpClient.layer));
        // Lets Settings offer Forget host for a pinned alias that never became a connection.
        return resolved.managed && report.destination.alias === resolved.host
          ? { ...report, destination: { ...report.destination, managed: true as const } }
          : report;
      }).pipe(
        Effect.mapError((cause) =>
          isAuthorizationError(cause) || isProbeError(cause)
            ? cause
            : new SshHostProbeError({
                host: input.host,
                reason: "operation_failed",
                message: "Could not check the SSH host.",
              }),
        ),
      );
    const probe: SshHostSetup["Service"]["probe"] = (input, sessionId) =>
      Effect.gen(function* () {
        yield* authorize({ kind: "client", sessionId }, "settings:write");
        const challenge = yield* collect(input);
        const probeId = NodeCrypto.randomUUID();
        challenges.set(probeId, { challenge, sessionId });
        return {
          probeId,
          host: challenge.host,
          human: humanFor(challenge),
          includeRequired: challenge.includeRequired,
        };
      }).pipe(
        Effect.catchTags({
          HandoffError: (error) =>
            Effect.fail(
              isProbeError(error.cause)
                ? error.cause
                : probeFailure(
                    input,
                    error.reason === "invalid_request"
                      ? "invalid_request"
                      : error.reason === "conflict"
                        ? "alias_conflict"
                        : "operation_failed",
                  ),
            ),
        }),
      );
    const trustChallenge = (challenge: Challenge, caller: SshHostCaller) =>
      Effect.gen(function* () {
        yield* authorize(caller, "settings:write");
        if (
          challenge.expiresAt <= DateTime.toEpochMillis(yield* DateTime.now) ||
          (aliasGenerations.get(challenge.host) ?? 0) !== challenge.aliasGeneration
        )
          return errorResult("This SSH trust request expired. Ask again.", "cancelled");
        const confirmation = yield* collect(challenge.input).pipe(Effect.result);
        if (confirmation._tag === "Failure")
          return errorResult(
            `Could not reach ${challenge.input.address} to confirm its key; Check again.`,
          );
        const current = confirmation.success;
        if (
          current.endpoint.hostKey !== challenge.endpoint.hostKey ||
          Object.entries(challenge.endpoint).some(
            ([key, value]) => current.endpoint[key as keyof typeof current.endpoint] !== value,
          )
        )
          return {
            kind: "error",
            code: "operation_failed",
            message: "The SSH host key or destination changed. Add this host again to review it.",
            status: {
              host: challenge.host,
              runtimeVersion: null,
              requestedVersion: "",
              state: "failed",
              failure: {
                reason: "host_key_changed",
                fix: {
                  actor: "human",
                  instruction: "Forget the host, then add it again to review its new fingerprint.",
                  path: "ssh.host_forget",
                },
              },
            },
          } satisfies SshHostResult;
        yield* authorize(caller, "settings:write");
        if ((aliasGenerations.get(challenge.host) ?? 0) !== challenge.aliasGeneration)
          return errorResult("This SSH trust request was cancelled by Forget.", "cancelled");
        let identityFile = challenge.identityFile;
        if (identityFile === undefined) {
          const agent = yield* runner
            .run({ command: "ssh-add", args: ["-l"], timeout: "10 seconds" })
            .pipe(Effect.result);
          if (agent._tag === "Failure" || agent.success.code !== 0)
            identityFile = (yield* writer.ensureKey).identityFile;
        }
        if ((aliasGenerations.get(challenge.host) ?? 0) !== challenge.aliasGeneration)
          return errorResult("This SSH trust request was cancelled by Forget.", "cancelled");
        yield* writer.writeHost(challenge.host, challenge.endpoint, identityFile);
        // Pinning confirms host identity only. Authentication belongs to the next preflight.
        return {
          kind: "ok",
          status: {
            host: challenge.host,
            state: "stopped",
            runtimeVersion: null,
            requestedVersion: "",
          },
        } satisfies SshHostResult;
      }).pipe(
        Effect.catch((error) =>
          isAuthorizationError(error)
            ? Effect.fail(error)
            : Effect.succeed(errorResult(error.message)),
        ),
      );
    const trust: SshHostSetup["Service"]["trust"] = (input, sessionId) =>
      Effect.gen(function* () {
        yield* authorize({ kind: "client", sessionId }, "settings:write");
        const entry = challenges.get(input.probeId);
        if (!entry || entry.sessionId !== sessionId)
          return errorResult("This SSH trust request expired. Probe again.", "cancelled");
        challenges.delete(input.probeId);
        if (!input.accepted)
          return {
            kind: "error",
            code: "declined",
            message: "SSH host trust was declined.",
          } satisfies SshHostResult;
        return yield* trustChallenge(entry.challenge, { kind: "client", sessionId }).pipe(
          admission.withPermits(1),
        );
      });
    const createHandoff = (
      caller: SshHostCaller,
      host: string,
      operation: SshHostSetupProgress,
      step: (typeof Continuation.Type)["step"],
      human: typeof import("@goat/contracts").HandoffHuman.Type,
      snapshot: SshHostResult,
      challenge?: Challenge,
      owner?: Handoff["requestedBy"],
    ) =>
      Effect.gen(function* () {
        if (owner === undefined && (caller.kind !== "mcp" || caller.scope.thread === undefined))
          return outsideThread(
            step === "host_trust"
              ? "Add this host in Settings → Connections."
              : "Ask from a GOAT thread so you can approve it there.",
          );
        const thread = owner ?? (caller.kind === "mcp" ? caller.scope.thread : undefined);
        if (thread === undefined)
          return outsideThread("Ask from a GOAT thread so you can approve it there.");
        const view = yield* threads
          .getThreadSnapshot(thread.threadId)
          .pipe(Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })));
        const run = view.projection.runs.at(-1);
        if (!run || run.rootNodeId === null)
          return outsideThread("Ask from a GOAT thread so you can approve it there.");
        const descriptor = yield* environment.getDescriptor;
        const target =
          step === "runtime_update"
            ? "ssh.runtime_update"
            : step === "host_trust"
              ? "ssh.host_add"
              : "ssh.host_prepare";
        const revision = yield* aliasRevision(host).pipe(
          Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })),
        );
        const args: typeof Continuation.Type = {
          version: 1,
          step,
          host,
          operationId: operation.operationId,
          aliasGeneration: operation.generation,
          ...(revision === undefined ? {} : { aliasRevision: revision }),
          ...(step === "runtime_update"
            ? { requestedVersion: snapshot.status?.requestedVersion ?? "" }
            : {}),
          ...(challenge ? { challenge } : {}),
        };
        const now = yield* DateTime.now;
        const handoff = yield* handoffs.create({
          kind: step === "key_auth" ? "terminal" : "approval",
          title:
            step === "runtime_update"
              ? `Update runtime on ${host}?`
              : step === "host_trust"
                ? `Trust ${host}?`
                : `Set up key authentication on ${host}`,
          reason:
            step === "runtime_update"
              ? "Running agent work gets up to a minute to finish, then continues on the new version."
              : step === "host_trust"
                ? `Check that ${host} is the server you meant before GOAT connects to it.`
                : `${host} needs your public key before GOAT can sign in.`,
          requestedBy: {
            threadId: thread.threadId,
            providerInstanceId: thread.providerInstanceId,
            path: target,
          },
          target: { environmentId: descriptor.environmentId, path: target },
          runId: run.id,
          nodeId: run.rootNodeId,
          human,
          args,
          expiresAt: DateTime.add(now, { hours: 24 }),
          sshProgress: {
            host,
            operationId: operation.operationId,
            aliasGeneration: operation.generation,
            environmentId: descriptor.environmentId,
            threadId: thread.threadId,
          },
        });
        return {
          kind: "needs_human",
          handoff,
          next: {
            after: step === "key_auth" ? "terminal" : "approval",
            call: step === "key_auth" ? "goat_ssh_host_prepare" : "goat_ssh_host_status",
          },
          status: snapshot.status ?? {
            host,
            state: "untrusted",
            runtimeVersion: null,
            requestedVersion: "",
          },
        } satisfies SshHostResult;
      });
    const managedContext = (host: string) =>
      Effect.gen(function* () {
        yield* decodeAlias(host);
        const config = yield* readOptional(path.join(directory, `${host}.conf`));
        const pin = yield* readOptional(path.join(directory, `${host}.known_hosts`));
        if (!config || !pin) return yield* new HandoffError({ reason: "not_found" });
        const fields = new Map(
          config.split(/\r?\n/u).flatMap((line) => {
            const match = /^\s*(\S+)\s+(.+?)\s*$/u.exec(line);
            return match ? [[match[1]!.toLowerCase(), match[2]!]] : [];
          }),
        );
        const endpoint: ManagedSshEndpoint = {
          host: fields.get("hostname") ?? "",
          user: fields.get("user") ?? "",
          port: Number(fields.get("port")),
          hostKey: pin.trim().split(/\s+/u).slice(1).join(" "),
          ...(fields.get("proxyjump") ? { proxyJump: fields.get("proxyjump")! } : {}),
          ...(fields.get("proxycommand") ? { proxyCommand: fields.get("proxycommand")! } : {}),
        };
        const identityFile = fields.get("identityfile")?.replace(/^"|"$/gu, "");
        const resolved = yield* runner.run({
          command: "ssh",
          args: ["-G", host],
          timeout: "20 seconds",
        });
        if (
          resolved.code !== 0 ||
          !effectiveSettingsMatch(resolved.stdout, {
            alias: host,
            endpoint,
            knownHostsFile: path.join(directory, `${host}.known_hosts`),
            ...(identityFile ? { identityFile } : {}),
          })
        )
          return yield* new HandoffError({ reason: "conflict" });
        return { endpoint, identityFile, pin };
      });
    const validateManaged = (host: string) =>
      Effect.gen(function* () {
        const context = yield* managedContext(host);
        // Validate every preparation even when dispatch already has a tunnel for this alias.
        const key = yield* probeHostKey({ target: host }).pipe(Effect.provide(runtime));
        if (context.pin.trim() !== `${host} ${key.algorithm} ${key.key}`)
          return yield* new HandoffError({
            reason: "conflict",
            cause: { reason: "host_key_changed" },
          });
      }).pipe(
        Effect.mapError((cause) =>
          isHandoffError(cause) ? cause : new HandoffError({ reason: "unavailable", cause }),
        ),
      );
    const startJob = (
      host: string,
      caller: SshHostCaller,
      update: boolean,
      confirmReplacement: boolean,
      reserved?: SshHostSetupProgress,
      onFinished?: Effect.Effect<void, HandoffError>,
      onStarted?: (operation: SshHostSetupProgress) => Effect.Effect<void, HandoffError>,
      owner?: Handoff["requestedBy"],
      requestGeneration = aliasGenerations.get(host) ?? 0,
      beforeRun?: Effect.Effect<void, HandoffError>,
      authorizeCaller: ReturnType<typeof authorize> = authorize(caller, "environment:maintain"),
    ) =>
      Effect.gen(function* () {
        yield* authorizeCaller;
        if ((aliasGenerations.get(host) ?? 0) !== requestGeneration)
          return yield* new HandoffError({ reason: "expired" });
        const existing = jobs.get(host);
        if (existing !== undefined) return existing.first;
        const operation =
          reserved ??
          (yield* dispatch.beginSetupOperation(host, { operationId: NodeCrypto.randomUUID() }));
        if ((aliasGenerations.get(host) ?? 0) !== requestGeneration) {
          yield* dispatch.forgetRuntime(host, { stopRuntime: "no" });
          return yield* new HandoffError({ reason: "expired" });
        }
        if (onStarted) yield* onStarted(operation);
        const first = yield* Deferred.make<SshHostResult>();
        const onPhase = () => {
          // The manager publishes before calling its observer. Read that same snapshot.
          Effect.runFork(
            status({ host }).pipe(
              Effect.flatMap((result) => Deferred.succeed(first, result)),
              Effect.forkIn(serviceScope),
              Effect.asVoid,
            ),
          );
        };
        let diagnosing = false;
        const work = Effect.gen(function* () {
          yield* authorizeCaller;
          if ((aliasGenerations.get(host) ?? 0) !== requestGeneration)
            return yield* new HandoffError({ reason: "expired" });
          if (beforeRun) yield* beforeRun;
          const auditEntry = update
            ? {
                operationId: operation.operationId,
                operation: "ssh-runtime-update" as const,
                destination: host,
                actor:
                  caller.kind === "client"
                    ? { kind: "client", sessionId: caller.sessionId }
                    : {
                        kind: "mcp",
                        sessionId:
                          caller.scope.client?.sessionId ?? caller.scope.thread?.providerSessionId,
                        threadId: caller.scope.thread?.threadId,
                      },
                fromVersion: (yield* status({ host })).status?.runtimeVersion ?? null,
                targetVersion: packageJson.version,
                mode: confirmReplacement ? ("confirmed" as const) : ("idle" as const),
              }
            : undefined;
          if (auditEntry !== undefined)
            yield* audit
              .append({ ...auditEntry, outcome: "requested" })
              .pipe(Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })));
          let result = yield* auditEntry !== undefined
            ? dispatch.runtimeUpdate(host, { confirmReplacement, onPhase, ...operation }).pipe(
                // An idle update can return while it still waits; only the target version is done.
                Effect.tap((updated) =>
                  audit
                    .append({
                      ...auditEntry,
                      outcome:
                        updated.status?.runtimeVersion === auditEntry.targetVersion
                          ? "completed"
                          : "accepted",
                    })
                    .pipe(Effect.ignore({ log: true })),
                ),
                Effect.tapError(() =>
                  audit
                    .append({ ...auditEntry, outcome: "failed" })
                    .pipe(Effect.ignore({ log: true })),
                ),
              )
            : dispatch.prepareRuntime(host, { ...operation, onPhase });
          if (
            update ||
            (result.status?.state !== "ready" && result.status?.state !== "auth_failed")
          ) {
            yield* dispatch.publishSetupOutcome(host, operation, { kind: "complete" });
            result = yield* status({ host });
          }
          if (update || result.status?.state !== "auth_failed")
            yield* Deferred.succeed(first, result);
          if (!update && result.status?.state === "ready") {
            diagnosing = true;
            const diagnosed = yield* diagnosis.diagnose({ host }, caller);
            const providers = {
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              ready: diagnosed.diagnoses.every((entry) => entry.ready),
              fixes: diagnosed.diagnoses.flatMap((entry) =>
                entry.checks.flatMap((check) => (check.fix ? [check.fix] : [])),
              ),
            };
            yield* dispatch.publishProviderDiagnosis(host, { ...operation, providers });
          } else if (!update && result.status?.state === "auth_failed") {
            const origin = yield* environment.getDescriptor;
            const context = yield* managedContext(host);
            const instructions =
              result.status.keyAuth ??
              buildSshKeyAuthInstructions({
                originLabel: origin.label,
                host,
                user: context.endpoint.user,
                port: context.endpoint.port,
                ...(result.status.publicKey
                  ? {
                      publicKey: result.status.publicKey,
                      generatedKey: true,
                      publicKeyPath: path.join(directory, "id_ed25519.pub"),
                    }
                  : {}),
              });
            if (caller.kind === "client" && owner === undefined) {
              yield* Deferred.succeed(first, result);
              return;
            }
            result = yield* createHandoff(
              caller,
              host,
              operation,
              "key_auth",
              {
                location: instructions.instruction,
                ...(instructions.command ? { command: instructions.command } : {}),
              },
              result,
              undefined,
              owner,
            );
            yield* Deferred.succeed(first, result);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const revoked = isAuthorizationError(error);
              const expired = isHandoffError(error) && error.reason === "expired";
              const reason = revoked
                ? "authorization_revoked"
                : expired
                  ? "approval_expired"
                  : diagnosing
                    ? "diagnosis_failed"
                    : "operation_failed";
              const message = revoked
                ? !update && caller.kind === "mcp" && caller.scope.thread !== undefined
                  ? error.message
                  : "The approving session no longer has permission. Ask again."
                : expired
                  ? `This approval expired before GOAT could update ${host}. Ask again.`
                  : diagnosing
                    ? `Provider diagnosis on ${host} failed. Try again.`
                    : `SSH setup on ${host} failed. Try again.`;
              yield* dispatch.publishSetupOutcome(host, operation, {
                kind: "error",
                reason,
                message,
                fix: {
                  actor: revoked || expired ? "human" : "agent",
                  instruction:
                    revoked || expired
                      ? !update && revoked
                        ? PrepareAuthorization.prepareRecovery(host)
                        : "Ask again and approve with a client that has permission."
                      : `Call goat_ssh_host_prepare for ${host} to retry setup and diagnosis.`,
                },
              });
              yield* Deferred.succeed(first, yield* status({ host }));
            }),
          ),
          Effect.ensuring(onFinished?.pipe(Effect.ignore({ log: true })) ?? Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              if (jobs.get(host)?.operation.operationId === operation.operationId)
                jobs.delete(host);
            }),
          ),
        );
        const fiber = yield* work.pipe(Effect.forkIn(serviceScope, { startImmediately: false }));
        jobs.set(host, { operation, first, fiber });
        return first;
      }).pipe(
        admission.withPermits(1),
        Effect.catchTags({
          SshRemoteDispatchError: (error) =>
            Effect.gen(function* () {
              const first = yield* Deferred.make<SshHostResult>();
              yield* Deferred.succeed(first, dispatchFailure(error));
              return first;
            }),
        }),
      );
    const setupFailure = (host: string, error: HandoffError): SshHostResult => {
      if (isProbeError(error.cause))
        return {
          kind: "error",
          code:
            error.cause.reason === "unreachable" || error.cause.reason === "connection_refused"
              ? "host_unreachable"
              : "operation_failed",
          message: error.cause.message,
          fix: { actor: "agent", instruction: "Check the SSH host and try again." },
        };
      const changed =
        error.cause !== null &&
        typeof error.cause === "object" &&
        "reason" in error.cause &&
        error.cause.reason === "host_key_changed";
      if (changed)
        return {
          kind: "error",
          code: "operation_failed",
          message: `The SSH host key for ${host} changed.`,
          status: {
            host,
            state: "failed",
            runtimeVersion: null,
            requestedVersion: "",
            failure: {
              reason: "host_key_changed",
              fix: {
                actor: "human",
                instruction: "Forget the host, then add it again to review its new fingerprint.",
                path: "ssh.host_forget",
              },
            },
          },
        };
      return errorResult(
        `${host}: ${error.message}`,
        error.reason === "invalid_request"
          ? "invalid_request"
          : error.reason === "conflict"
            ? "alias_conflict"
            : error.reason === "expired"
              ? "cancelled"
              : "operation_failed",
      );
    };
    const prepare: SshHostSetup["Service"]["prepare"] = (input, caller) =>
      Effect.gen(function* () {
        const authorizeCaller = authorizePrepare(caller, input.host);
        yield* authorizeCaller;
        const generation = aliasGenerations.get(input.host) ?? 0;
        yield* validateManaged(input.host);
        return yield* Deferred.await(
          yield* startJob(
            input.host,
            caller,
            false,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            generation,
            undefined,
            authorizeCaller,
          ),
        );
      }).pipe(
        Effect.catchTags({
          HandoffError: (error) => Effect.succeed(setupFailure(input.host, error)),
        }),
      );
    const update: SshHostSetup["Service"]["update"] = (input, caller) =>
      Effect.gen(function* () {
        if (caller.kind === "client")
          return outsideThread(
            "Server client SSH runtime updates are not supported. Choose Update now in Settings → Connections on the desktop app that owns this connection.",
          );
        if ((input.mode ?? "when_idle") !== "now") {
          // An idle update drains only an owned, older runtime with no running work and never
          // replaces a newer or foreign one, so a live, writable thread may start it without
          // the maintenance grant threads never hold. Everyone else still needs that grant.
          const authorizeIdle =
            caller.scope.thread !== undefined &&
            !caller.scope.grantedScopes?.includes("environment:maintain")
              ? authorizeApprovalRequest(caller.scope)
              : authorize(caller, "environment:maintain");
          yield* authorizeIdle;
          return yield* Deferred.await(
            yield* startJob(
              input.host,
              caller,
              true,
              false,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              authorizeIdle,
            ),
          );
        }
        if (!caller.scope.thread) {
          yield* authorize(caller, "environment:maintain");
          return outsideThread("Ask from a GOAT thread so you can approve it there.");
        }
        yield* authorizeApprovalRequest(caller.scope);
        const snapshot = yield* status({ host: input.host });
        if (snapshot.kind !== "ok") return snapshot;
        const operation = yield* dispatch
          .beginSetupOperation(input.host, { operationId: NodeCrypto.randomUUID() })
          .pipe(Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })));
        return yield* createHandoff(
          caller,
          input.host,
          operation,
          "runtime_update",
          {
            location: `Update GOAT on ${input.host} now.`,
          },
          snapshot,
        );
      });
    const add: SshHostSetup["Service"]["add"] = (input, caller) =>
      Effect.gen(function* () {
        if (caller.kind !== "mcp" || caller.scope.thread === undefined) {
          yield* authorize(caller, "settings:write");
          return outsideThread("Add this host in Settings → Connections.");
        }
        yield* authorizeApprovalRequest(caller.scope);
        const challenge = yield* collect(input);
        const pin = yield* readOptional(path.join(directory, `${challenge.host}.known_hosts`)).pipe(
          Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })),
        );
        if (pin !== null) return yield* status({ host: challenge.host });
        return yield* createHandoff(
          caller,
          challenge.host,
          {
            operationId: NodeCrypto.randomUUID(),
            generation: challenge.aliasGeneration,
            stage: "runtime",
          },
          "host_trust",
          humanFor(challenge),
          {
            kind: "ok",
            status: {
              host: challenge.host,
              state: "untrusted",
              runtimeVersion: null,
              requestedVersion: "",
            },
          },
          challenge,
        );
      }).pipe(
        Effect.catchTags({
          HandoffError: (error) => Effect.succeed(setupFailure(aliasFor(input), error)),
        }),
      );
    const forget: SshHostSetup["Service"]["forget"] = (input, caller) =>
      Effect.gen(function* () {
        yield* authorize(caller, "settings:write");
        aliasGenerations.set(input.host, (aliasGenerations.get(input.host) ?? 0) + 1);
        for (const [id, entry] of challenges)
          if (entry.challenge.host === input.host) challenges.delete(id);
        const job = jobs.get(input.host);
        jobs.delete(input.host);
        if (job) {
          yield* Deferred.succeed(
            job.first,
            errorResult("This SSH setup was cancelled by Forget.", "cancelled"),
          );
          yield* Fiber.interrupt(job.fiber).pipe(Effect.forkIn(serviceScope));
        }
        // This call fences the manager before it waits for the install lock, while config is intact.
        const result = yield* dispatch
          .forgetRuntime(input.host, { stopRuntime: input.stopRuntime })
          .pipe(
            Effect.catchTags({
              SshRemoteDispatchError: (error) =>
                error.reason === "host_unknown"
                  ? Effect.succeed<SshHostResult>({
                      kind: "ok",
                      status: {
                        host: input.host,
                        state: "untrusted",
                        runtimeVersion: null,
                        requestedVersion: "",
                      },
                    })
                  : Effect.succeed(dispatchFailure(error)),
            }),
          );
        yield* authorize(caller, "settings:write");
        const removed = yield* writer
          .removeHost(input.host)
          .pipe(admission.withPermits(1), Effect.result);
        return removed._tag === "Failure"
          ? errorResult("Could not remove the managed SSH files. Try again.")
          : result;
      });
    const resumeContinuations = Effect.gen(function* () {
      for (const { handoff, sshProgress } of yield* handoffs.resolvedSshOutcomes) {
        yield* dispatch.publishSetupOutcome(
          sshProgress.host,
          { operationId: sshProgress.operationId, generation: sshProgress.aliasGeneration },
          {
            kind: "error",
            reason: handoff.state === "expired" ? "approval_expired" : "operation_failed",
            message:
              handoff.state === "expired"
                ? `This approval expired before GOAT could update ${sshProgress.host}. Ask again.`
                : `SSH setup for ${sshProgress.host} was ${handoff.state}.`,
            fix: { actor: "human", instruction: "Ask again to review and approve this SSH setup." },
          },
        );
        yield* handoffs.finishSshContinuation({
          threadId: handoff.requestedBy.threadId,
          handoffId: handoff.handoffId,
        });
      }
      for (const entry of yield* handoffs.completedSshContinuations) {
        const id = entry.handoff.handoffId;
        if (continuing.has(id)) continue;
        continuing.add(id);
        const work = Effect.gen(function* () {
          const args = yield* decodeContinuation(entry.args).pipe(
            Effect.mapError((cause) => new HandoffError({ reason: "invalid_request", cause })),
          );
          const caller: SshHostCaller = { kind: "client", sessionId: entry.approvedBySessionId };
          const address = { threadId: entry.handoff.requestedBy.threadId, handoffId: id };
          const discard = handoffs.finishSshContinuation(address);
          const reject = (
            reason: "approval_expired" | "authorization_revoked" | "operation_failed",
            message: string,
          ) =>
            Effect.gen(function* () {
              if (entry.sshProgress !== undefined)
                yield* dispatch.publishSetupOutcome(
                  entry.sshProgress.host,
                  {
                    operationId: entry.sshProgress.operationId,
                    generation: entry.sshProgress.aliasGeneration,
                  },
                  {
                    kind: "error",
                    reason,
                    message,
                    fix: {
                      actor: "human",
                      instruction: "Ask again and approve with a client that has permission.",
                    },
                  },
                );
              yield* handoffs.finishSshContinuation(
                address,
                args.step === "host_trust" ? { result: errorResult(message) } : undefined,
              );
            });
          const expectedPath =
            args.step === "runtime_update"
              ? "ssh.runtime_update"
              : args.step === "host_trust"
                ? "ssh.host_add"
                : "ssh.host_prepare";
          if (
            entry.handoff.target.path !== expectedPath ||
            (entry.sshProgress !== undefined && entry.sshProgress.host !== args.host)
          )
            return yield* discard;
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            entry.handoff.expiresAt !== null &&
            DateTime.toEpochMillis(entry.handoff.expiresAt) <= now
          )
            return yield* reject(
              "approval_expired",
              `This approval expired before GOAT could update ${args.host}. Ask again.`,
            );
          if (
            args.step === "runtime_update" &&
            (!entry.handoff.resolvedAt ||
              now - DateTime.toEpochMillis(entry.handoff.resolvedAt) >= 10 * 60 * 1000)
          )
            return yield* reject(
              "approval_expired",
              `This approval expired before GOAT could update ${args.host}. Ask again.`,
            );
          if ((aliasGenerations.get(args.host) ?? 0) !== (args.challenge?.aliasGeneration ?? 0))
            return yield* discard;
          if (
            args.aliasRevision !== undefined &&
            args.aliasRevision !== (yield* aliasRevision(args.host))
          )
            return yield* discard;
          yield* authorize(
            caller,
            args.step === "host_trust" ? "settings:write" : "environment:maintain",
          );
          if (args.step === "host_trust") {
            if (!args.challenge) return yield* discard;
            const trusted = yield* trustChallenge(args.challenge, caller).pipe(
              admission.withPermits(1),
            );
            const revision = trusted.kind === "ok" ? yield* aliasRevision(args.host) : undefined;
            let result = trusted;
            if (trusted.kind === "ok") {
              const snapshot = { ...trusted.status };
              delete snapshot.setup;
              result = { ...trusted, status: snapshot };
            }
            return yield* handoffs.finishSshContinuation(address, {
              result,
              ...(revision === undefined ? {} : { aliasRevision: revision }),
            });
          } else {
            const current = yield* status({ host: args.host });
            if (
              current.status?.setup !== undefined &&
              (current.status.setup.operationId !== args.operationId ||
                current.status.setup.generation !== args.aliasGeneration)
            )
              return yield* discard;
            if (
              args.step === "runtime_update" &&
              current.status?.requestedVersion !== args.requestedVersion
            )
              return yield* discard;
          }
          const latest = yield* status({ host: args.host });
          if (
            args.step === "runtime_update" &&
            latest.status?.state === "ready" &&
            latest.status.runtimeVersion === args.requestedVersion
          ) {
            if (latest.status.setup !== undefined)
              yield* dispatch.publishSetupOutcome(args.host, latest.status.setup, {
                kind: "complete",
              });
            return yield* discard;
          }
          const operation =
            latest.status?.setup?.operationId === args.operationId
              ? latest.status.setup
              : yield* dispatch.beginSetupOperation(args.host, { operationId: args.operationId });
          const ack = handoffs.finishSshContinuation({
            threadId: entry.handoff.requestedBy.threadId,
            handoffId: id,
          });
          yield* Deferred.await(
            yield* startJob(
              args.host,
              caller,
              args.step === "runtime_update",
              args.step === "runtime_update",
              operation,
              ack,
              (current) =>
                handoffs.bindSshContinuation(
                  address,
                  {
                    host: args.host,
                    operationId: current.operationId,
                    aliasGeneration: current.generation,
                    environmentId: entry.handoff.target.environmentId,
                    threadId: entry.handoff.requestedBy.threadId,
                  },
                  { ...args, aliasGeneration: current.generation },
                ),
              entry.handoff.requestedBy,
              undefined,
              Effect.gen(function* () {
                if (args.step !== "runtime_update") return;
                const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
                if (
                  !entry.handoff.resolvedAt ||
                  startedAt - DateTime.toEpochMillis(entry.handoff.resolvedAt) >= 10 * 60 * 1000
                )
                  return yield* new HandoffError({ reason: "expired" });
              }),
            ),
          );
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const binding = entry.sshProgress;
              if (binding)
                yield* dispatch.publishSetupOutcome(
                  binding.host,
                  { operationId: binding.operationId, generation: binding.aliasGeneration },
                  {
                    kind: "error",
                    reason: isAuthorizationError(cause)
                      ? "authorization_revoked"
                      : "operation_failed",
                    message: isAuthorizationError(cause)
                      ? "The approving session no longer has permission. Ask again."
                      : "This SSH approval could not continue. Ask again.",
                    fix: {
                      actor: "human",
                      instruction: "Ask again and approve with a client that has permission.",
                    },
                  },
                );
            }).pipe(
              Effect.andThen(
                Effect.logWarning("SSH continuation did not resume", {
                  handoffId: id,
                  reason: cause._tag,
                }),
              ),
              Effect.andThen(
                handoffs
                  .finishSshContinuation(
                    {
                      threadId: entry.handoff.requestedBy.threadId,
                      handoffId: id,
                    },
                    entry.handoff.target.path === "ssh.host_add"
                      ? {
                          result: errorResult(
                            isAuthorizationError(cause)
                              ? "The approving session no longer has permission. Ask again."
                              : "This SSH approval could not continue. Ask again.",
                          ),
                        }
                      : undefined,
                  )
                  .pipe(Effect.ignore),
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => continuing.delete(id))),
          Effect.asVoid,
        );
        if (entry.handoff.target.path === "ssh.host_add") yield* work;
        else yield* work.pipe(Effect.forkIn(serviceScope));
      }
    }).pipe(continuationAdmission.withPermits(1));
    const respondExisting = (input: HandoffRespondInput, sessionId: AuthSessionId) =>
      handoffs
        .respond(input, sessionId)
        .pipe(
          Effect.tap((result) =>
            result.state !== "pending" &&
            result.state !== "opened" &&
            result.target.path.startsWith("ssh.")
              ? resumeContinuations
              : Effect.void,
          ),
        );
    const respondHandoff: SshHostSetup["Service"]["respondHandoff"] = (input, sessionId) =>
      handoffs
        .read(input)
        .pipe(
          Effect.flatMap((record) =>
            record.target.path === "provider.home_request" && Option.isSome(providerHomeRequests)
              ? providerHomeRequests.value.respond(input, sessionId)
              : record.target.path === ProviderHostSync.HOST_SYNC_PATH &&
                  Option.isSome(providerHostSync)
                ? providerHostSync.value.respondHandoff(input, sessionId)
                : (record.target.path === PROVIDER_SETTINGS_HANDOFF_PATH ||
                      record.target.path === PROVIDER_SETUP_HANDOFF_PATH) &&
                    Option.isSome(providerSettings)
                  ? providerSettings.value.respond(input, sessionId)
                  : respondExisting(input, sessionId),
          ),
        );
    const handoffProgress: SshHostSetup["Service"]["handoffProgress"] = (input, caller) =>
      Effect.gen(function* () {
        yield* authorize(caller, "orchestration:read");
        const record = yield* handoffs.read(input);
        if (!record.target.path.startsWith("ssh."))
          return { kind: "unavailable", reason: "not_ssh" } as const;
        let binding = yield* handoffs.readSshProgressBinding(input, caller.sessionId);
        // The timeline can deliver approval before the pin-only continuation has finished.
        if (
          binding &&
          !binding.completion &&
          record.target.path === "ssh.host_add" &&
          record.state === "completed"
        ) {
          yield* resumeContinuations;
          binding = yield* handoffs.readSshProgressBinding(input, caller.sessionId);
        }
        if (!binding) return { kind: "unavailable", reason: "expired" } as const;
        if (binding.completion !== undefined) {
          if (
            binding.completion.aliasRevision !== undefined &&
            binding.completion.aliasRevision !==
              (yield* aliasRevision(binding.host).pipe(
                Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })),
              ))
          )
            return { kind: "unavailable", reason: "superseded" } as const;
          return {
            kind: "available",
            host: binding.host,
            operationId: binding.operationId,
            generation: binding.aliasGeneration,
            result: binding.completion.result,
          } as const;
        }
        const result = yield* status({ host: binding.host });
        if (
          result.status?.setup?.operationId !== binding.operationId ||
          result.status.setup.generation !== binding.aliasGeneration
        )
          return { kind: "unavailable", reason: "superseded" } as const;
        return {
          kind: "available",
          host: binding.host,
          operationId: binding.operationId,
          generation: binding.aliasGeneration,
          result,
        } as const;
      });
    return SshHostSetup.of({
      status,
      resolveDestination,
      preflight,
      update,
      probe,
      trust,
      add,
      prepare,
      forget,
      respondHandoff,
      handoffProgress,
      resumeContinuations,
    });
  });
export const layer = Layer.effect(SshHostSetup, make());
