import {
  DecisionItem,
  DecisionListResult,
  OrchestratorMcpFailure,
  type DecisionListMcpInput,
  type DecisionGetMcpInput,
  type DecisionAnswerMcpInput,
  type PermissionProfile,
  type RuntimeMode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Inbox from "./DecisionInbox.ts";
import { compareDecisions } from "./decisionOrder.ts";
import * as Authority from "./DecisionAuthority.ts";
import * as Profiles from "./PermissionProfiles.ts";
import * as Settings from "../serverSettings.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, readCaller, reauthorizationFailure } from "../mcp/threadAccess.ts";
import { canResolveHumanStep, mcpResolver, PERSON } from "../handoffs/HumanStepAuthority.ts";
import { withHostFanOutDeadline } from "../mcp/hostFanOutDeadline.ts";

const HOST_LIMIT = 16;
const CONCURRENCY = 4;
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const outdated = (host: string) =>
  new OrchestratorMcpFailure({
    code: "remote_outdated",
    message: `Update GOAT on ${host} to read and answer decisions safely from this environment. No unfiltered retry was made.`,
  });
const remoteFailure = (host: string, error: OrchestratorMcpFailure) =>
  error.code === "remote_outdated" || /does not take|[Uu]nrecognized key/.test(error.message)
    ? outdated(host)
    : error;
const raw = (value: unknown) => Effect.succeed({ value });
const decodePage = Schema.decodeUnknownEffect(DecisionListResult);
const decodeItem = Schema.decodeUnknownEffect(DecisionItem);
const keyOf = (item: DecisionItem) =>
  JSON.stringify(
    item.source === "pending_request"
      ? [item.from.environmentId, item.pending?.threadId, item.pending?.requestId]
      : [item.from.environmentId, item.id],
  );
const transported = (input: DecisionListMcpInput) =>
  input.launcherEnvironmentId !== undefined ||
  input.localOnly !== undefined ||
  input.permissionProfileCeiling !== undefined ||
  input.transportEnvironmentId !== undefined;

export class DecisionService extends Context.Service<
  DecisionService,
  {
    readonly list: (
      caller: Inbox.DecisionCaller,
      input: DecisionListMcpInput,
    ) => Effect.Effect<DecisionListResult, OrchestratorMcpFailure>;
    readonly get: (
      caller: Inbox.DecisionCaller,
      input: DecisionGetMcpInput,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly answer: (
      caller: Inbox.DecisionCaller,
      input: DecisionAnswerMcpInput,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly create: Inbox.DecisionInbox["Service"]["create"];
    readonly withdraw: Inbox.DecisionInbox["Service"]["withdraw"];
  }
>()("goat/goatclaw/DecisionService") {}

const make = Effect.gen(function* () {
  const inbox = yield* Inbox.DecisionInbox;
  const hosts = yield* Hosts.HostThreadsMcpService;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const profiles = yield* Profiles.PermissionProfiles;
  const settings = yield* Settings.ServerSettingsService;
  const threads = yield* Threads.ThreadManagementService;
  const requireProfile = (
    caller: Inbox.DecisionCaller,
    required: string,
    runtimeMode: RuntimeMode,
  ) =>
    Authority.requireProfile(caller, required, undefined, runtimeMode).pipe(
      Effect.provideService(Profiles.PermissionProfiles, profiles),
      Effect.provideService(Settings.ServerSettingsService, settings),
    );
  const authorize = Effect.fn("DecisionService.authorizeHost")(function* (
    caller: Inbox.DecisionCaller,
    host: string,
    writes: boolean,
    item?: DecisionItem,
    snapshot?: PermissionProfile,
  ) {
    const scope = Authority.scopeOf(caller);
    if (scope.readOnly === true || scope.client?.access === "read-only")
      return yield* denied("This credential cannot reach other machines because it is read-only.");
    yield* Authority.writeAccess(caller);
    const approval = writes && item?.pending?.approval !== undefined;
    const required = writes
      ? approval && caller.kind === "agent"
        ? (["orchestration:operate", "orchestration:approve"] as const)
        : (["orchestration:operate"] as const)
      : (["orchestration:read", "orchestration:operate"] as const);
    if (scope.reauthorize === undefined)
      return yield* denied(
        "This credential cannot reach other machines without live session authorization.",
      );
    yield* scope.reauthorize(required).pipe(Effect.mapError(reauthorizationFailure));
    const live = yield* readCaller().pipe(
      Effect.tap(assertLiveCaller),
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(Threads.ThreadManagementService, threads),
    );
    if (live.limits.interactionMode !== "default")
      return yield* new OrchestratorMcpFailure({
        code: "interaction_mode_escalation_denied",
        message: "Decisions on other machines require default interaction mode.",
      });
    const grant = yield* profiles.check(scope, "threads.remote", {
      host,
      runtimeMode: live.limits.runtimeMode,
    });
    if (!grant.ok) return yield* denied(grant.reason);
    const effective = grant.effective;
    const profile = { ...effective.profile, runtimeModeCeiling: effective.runtimeMode };
    if (snapshot !== undefined && !Authority.dominatesProfile(profile, snapshot))
      return yield* denied(
        "The caller's permission profile narrowed while preparing the remote decision call.",
      );
    if (item !== undefined) {
      if (item.status !== "open") return yield* invalid("This decision is no longer open.");
      const resolver = caller.kind === "client" ? PERSON : mcpResolver(scope);
      if (item.humanRequired && (!approval || !canResolveHumanStep(resolver, "runtime_approval")))
        return yield* denied(
          "This item cannot be answered over this transport; forward it to the user in its asking thread.",
        );
      if (caller.kind === "agent" && !approval)
        yield* requireProfile(caller, item.requiredProfile, effective.runtimeMode);
    }
    return { ...effective, profile };
  });
  const forwarding = (caller: Inbox.DecisionCaller, effective: Profiles.EffectiveProfile) => ({
    transportEnvironmentId: Authority.scopeOf(caller).environmentId,
    // As other profiled host calls do: only an enabled origin policy has a narrowing to forward,
    // and a destination with goatclaw off refuses any forwarded ceiling.
    ...(caller.kind === "agent" && effective.enabled
      ? { permissionProfileCeiling: effective.profile }
      : {}),
  });
  const stamp = (
    caller: Inbox.DecisionCaller,
    host: string,
    items: ReadonlyArray<DecisionItem>,
  ) => {
    const origin = Authority.scopeOf(caller).environmentId;
    const environments = new Set(items.map((item) => item.from.environmentId));
    if (
      environments.size > 1 ||
      items.some(
        (item) =>
          item.from.environmentId === undefined ||
          item.from.environmentId === origin ||
          item.from.host !== undefined ||
          (item.source === "pending_request" && item.pending === undefined),
      )
    )
      return Effect.fail(outdated(host));
    return Effect.succeed(
      items.map((item) => ({
        ...item,
        from: { ...item.from, host },
        ...(caller.kind === "client" && item.answeredBy !== null
          ? { answeredBy: item.answeredByLabel ?? "an agent" }
          : {}),
      })),
    );
  };
  const remoteList = Effect.fn("DecisionService.listOnHost")(function* (
    caller: Inbox.DecisionCaller,
    host: string,
    input: DecisionListMcpInput,
    discovery: boolean,
  ) {
    const effective = yield* authorize(caller, host, false);
    const response = yield* hosts
      .readOnHost(
        Authority.scopeOf(caller),
        {
          host,
          tool: "goat_decision_list",
          arguments: {
            ...(input.status === undefined ? {} : { status: input.status }),
            limit: input.limit ?? 100,
            ...forwarding(caller, effective),
            ...(discovery
              ? { launcherEnvironmentId: Authority.scopeOf(caller).environmentId }
              : { localOnly: true }),
          },
          authorize: authorize(caller, host, false, undefined, effective.profile).pipe(
            Effect.map((grant) => grant.runtimeMode),
          ),
        },
        raw,
      )
      .pipe(
        Effect.mapError((error) =>
          error.code === "invalid_request" || error.code === "remote_outdated"
            ? outdated(host)
            : error,
        ),
      );
    const page = yield* decodePage(response.value).pipe(Effect.mapError(() => outdated(host)));
    if (page.unavailableHosts.length !== 0) return yield* outdated(host);
    return { ...page, items: yield* stamp(caller, host, page.items) };
  });
  const get = Effect.fn("DecisionService.get")(function* (
    caller: Inbox.DecisionCaller,
    input: DecisionGetMcpInput,
  ) {
    if (input.host === undefined) return yield* inbox.get(caller, input.id, input);
    if (input.transportEnvironmentId !== undefined || input.permissionProfileCeiling !== undefined)
      return yield* invalid("Transport controls cannot be combined with host routing.");
    const effective = yield* authorize(caller, input.host, false);
    const response = yield* hosts
      .readOnHost(
        Authority.scopeOf(caller),
        {
          host: input.host,
          tool: "goat_decision_get",
          arguments: { id: input.id, ...forwarding(caller, effective) },
          authorize: authorize(caller, input.host, false, undefined, effective.profile).pipe(
            Effect.map((grant) => grant.runtimeMode),
          ),
        },
        raw,
      )
      .pipe(
        Effect.mapError((error) =>
          error.code === "invalid_request" && error.message.includes("does not take")
            ? outdated(input.host ?? "host")
            : error,
        ),
      );
    const item = yield* decodeItem(response.value).pipe(
      Effect.mapError(() => outdated(input.host ?? "host")),
    );
    if (item.id !== input.id) return yield* outdated(input.host);
    const stamped = yield* stamp(caller, input.host, [item]);
    const first = stamped[0];
    if (first === undefined) return yield* outdated(input.host);
    return first;
  });
  const list = Effect.fn("DecisionService.list")(function* (
    caller: Inbox.DecisionCaller,
    input: DecisionListMcpInput,
  ) {
    if (transported(input)) return yield* inbox.list(caller, input);
    if (input.launcherThreadId !== undefined)
      return yield* invalid("A launcher thread filter requires its foreign environment identity.");
    if (input.host !== undefined) {
      if (input.hosts !== undefined) return yield* invalid("Use host or hosts, not both.");
      return yield* remoteList(caller, input.host, input, false);
    }
    const limit = input.limit ?? 100;
    const here = yield* inbox.list(caller, {
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: limit + 1,
    });
    const aliases = [
      ...new Set(
        [...(yield* dispatch.connectedHosts), ...(input.hosts ?? [])].map((host) => host.trim()),
      ),
    ].toSorted();
    const pages = yield* Effect.forEach(
      aliases.slice(0, HOST_LIMIT),
      (host) =>
        remoteList(caller, host, { ...input, limit: Math.min(limit + 1, 200) }, true).pipe(
          withHostFanOutDeadline(host),
          Effect.result,
          Effect.map((result) => ({ host, result })),
        ),
      { concurrency: CONCURRENCY },
    );
    const items: DecisionItem[] = [...here.items];
    const unavailableHosts = aliases.slice(HOST_LIMIT).map((host) => ({
      host,
      code: "invalid_request",
      message: "Decision discovery is limited to 16 hosts per call; query this host explicitly.",
    }));
    let truncated = here.truncated || aliases.length > HOST_LIMIT;
    for (const { host, result } of pages) {
      if (result._tag === "Success") {
        items.push(...result.success.items);
        truncated ||= result.success.truncated;
      } else
        unavailableHosts.push({ host, code: result.failure.code, message: result.failure.message });
    }
    const unique = new Map<string, DecisionItem>();
    for (const item of items.toSorted(compareDecisions))
      if (!unique.has(keyOf(item))) unique.set(keyOf(item), item);
    const merged = [...unique.values()];
    return {
      items: merged.slice(0, limit),
      unavailableHosts,
      truncated: truncated || merged.length > limit,
    };
  });
  const answer = Effect.fn("DecisionService.answer")(function* (
    caller: Inbox.DecisionCaller,
    input: DecisionAnswerMcpInput,
  ) {
    if (input.host === undefined) return yield* inbox.answer(caller, input);
    yield* Authority.writeAccess(caller);
    if (input.transportEnvironmentId !== undefined || input.permissionProfileCeiling !== undefined)
      return yield* invalid("Transport controls cannot be combined with host routing.");
    const host = input.host;
    const item = yield* get(caller, { id: input.id, host });
    const effective = yield* authorize(caller, host, true, item);
    const { host: _host, ...args } = input;
    const response = yield* hosts
      .writeOnHost(
        Authority.scopeOf(caller),
        {
          host,
          tool: "goat_decision_answer",
          arguments: { ...args, ...forwarding(caller, effective) },
          approvals: item.pending?.approval !== undefined,
          authorize: authorize(caller, host, true, item, effective.profile).pipe(
            Effect.map((grant) => grant.runtimeMode),
          ),
        },
        raw,
      )
      .pipe(Effect.mapError((error) => remoteFailure(host, error)));
    const answered = yield* decodeItem(response.value).pipe(Effect.mapError(() => outdated(host)));
    if (answered.id !== item.id || answered.from.environmentId !== item.from.environmentId)
      return yield* outdated(host);
    const stamped = yield* stamp(caller, host, [answered]);
    const first = stamped[0];
    if (first === undefined) return yield* outdated(host);
    return first;
  });
  return DecisionService.of({ list, get, answer, create: inbox.create, withdraw: inbox.withdraw });
});
export const layer = Layer.effect(DecisionService, make);
