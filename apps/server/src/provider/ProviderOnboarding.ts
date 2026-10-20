/**
 * Adding providers and signing in on behalf of MCP callers.
 *
 * A caller holding providers:manage (an outside client signed in as the
 * person) starts a sign-in flow owned by its own auth session, so no other
 * session can read, answer, or cancel it. A thread agent never holds that
 * scope: it gets a `provider.setup` handoff instead, which only a person with
 * providers:manage can open, and the person finishes setup in the app's
 * add-provider popup. Results carry only {@link redactProviderAuthState}.
 */
import {
  AuthProvidersManageScope,
  PROVIDER_SETUP_HANDOFF_PATH,
  PROVIDER_SIGN_IN_COMMANDS,
  ProviderDriverKind,
  ProviderInstanceId,
  redactProviderAuthState,
  type ProviderAddableDriver,
  type ProviderAddableListResult,
  type ProviderLoginFlowInput,
  type ProviderLoginResult,
  type ProviderLoginStartInput,
  type ProviderSetupOpenInput,
  type ProviderSetupOpenResult,
  type ProviderSignInKind,
  type ServerProvider,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { authorizeApprovalRequest } from "../sshRemote/SshHostAuthorization.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import * as ProviderAuthService from "./ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

/**
 * How each driver signs in when its snapshot does not say. `command` is the
 * provider's own terminal command for drivers whose sign-in cannot run in the
 * app on this server; cloud drivers follow their local sibling.
 */
const SIGN_IN: Readonly<Record<string, { readonly kind: ProviderSignInKind }>> = {
  codex: { kind: "browser" },
  claudeAgent: { kind: "terminal" },
  claudeCloud: { kind: "linked" },
  cursor: { kind: "browser" },
  cursorCloud: { kind: "linked" },
  devinCloud: { kind: "linked" },
  antigravity: { kind: "browser" },
  acpRegistry: { kind: "agent" },
  grok: { kind: "credentials" },
  opencode: { kind: "command" },
};

const error = (code: string, message: string, fix?: { instruction: string; path?: string }) => ({
  kind: "error" as const,
  code,
  message,
  ...(fix ? { fix: { actor: "human" as const, ...fix } } : {}),
});

/** Pure: the addable list from driver metadata and the current snapshots. */
export const buildAddableDrivers = (
  drivers: ReadonlyArray<{ readonly driverKind: string; readonly displayName: string }>,
  snapshots: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderAddableDriver> =>
  drivers.map(({ driverKind, displayName }) => {
    const own = snapshots.filter((snapshot) => snapshot.driver === driverKind);
    const known = SIGN_IN[driverKind];
    const probe = own.find((snapshot) => snapshot.enabled) ?? own[0];
    const signInInApp =
      own.some((snapshot) => snapshot.setup?.canAuthenticate === true) ||
      driverKind === "acpRegistry";
    const kind = known?.kind ?? (signInInApp ? "agent" : "none");
    return {
      driver: ProviderDriverKind.make(driverKind),
      displayName,
      install: {
        state: probe === undefined ? "unknown" : probe.installed ? "installed" : "missing",
        inApp: own.some((snapshot) => snapshot.setup?.canInstall === true),
        version: probe?.version ?? null,
      },
      signIn: {
        kind,
        inApp: signInInApp,
        command: signInInApp ? null : (PROVIDER_SIGN_IN_COMMANDS[driverKind] ?? null),
      },
      instances: own.map((snapshot) => ({
        instanceId: snapshot.instanceId,
        displayName: snapshot.displayName ?? displayName,
        enabled: snapshot.enabled,
        status: snapshot.status,
        auth: snapshot.auth.status,
      })),
    };
  });

export class ProviderOnboarding extends Context.Service<
  ProviderOnboarding,
  {
    readonly list: Effect.Effect<ProviderAddableListResult>;
    readonly loginStart: (
      input: ProviderLoginStartInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderLoginResult>;
    readonly loginStatus: (
      input: ProviderLoginFlowInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderLoginResult>;
    readonly loginCancel: (
      input: ProviderLoginFlowInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderLoginResult>;
    readonly setupOpen: (
      input: ProviderSetupOpenInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderSetupOpenResult>;
  }
>()("goat/provider/ProviderOnboarding") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const auth = yield* ProviderAuthService.ProviderAuthService;
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const driverMeta = BUILT_IN_DRIVERS.map((driver) => ({
    driverKind: driver.driverKind as string,
    displayName: driver.metadata.displayName,
  }));
  const driverName = (driver: string) =>
    driverMeta.find((meta) => meta.driverKind === driver)?.displayName ?? driver;

  const snapshots = Effect.gen(function* () {
    const live = yield* registry.listInstances;
    const states = yield* Effect.forEach(live, (instance) => instance.snapshot.getSnapshot);
    return [...states, ...(yield* registry.listUnavailable)];
  });

  /** The caller's own auth session, when it may manage providers on this environment. */
  const managingSession = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      if (
        scope.readOnly ||
        scope.client === undefined ||
        scope.reauthorize === undefined ||
        !scope.grantedScopes?.includes(AuthProvidersManageScope)
      )
        return Option.none<string>();
      const live = yield* Effect.exit(scope.reauthorize([AuthProvidersManageScope]));
      return live._tag === "Success" ? Option.some(scope.client.sessionId) : Option.none<string>();
    });

  const requestSetup = (
    scope: McpInvocationScope,
    intent: { readonly driver?: string; readonly instanceId?: ProviderInstanceId },
    copy: { readonly title: string; readonly reason: string; readonly location: string },
  ) =>
    Effect.gen(function* () {
      if (!scope.thread || scope.readOnly)
        return error(
          "unsupported",
          "Ask from a thread on this environment, or sign in from GOAT's model picker.",
        );
      const allowed = yield* authorizeApprovalRequest(scope).pipe(
        Effect.as(true),
        Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
      );
      if (!allowed)
        return error("capability_denied", "The requesting thread must have live authorization.");
      const view = yield* threads.getThreadSnapshot(scope.thread.threadId);
      const run = view.projection.runs.at(-1);
      if (!run || run.rootNodeId === null)
        return error("unsupported", "Ask again from a thread with an active turn.");
      const handoff = yield* handoffs.create({
        kind: "approval",
        title: copy.title,
        reason: copy.reason,
        requestedBy: {
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
          path: PROVIDER_SETUP_HANDOFF_PATH,
        },
        target: { environmentId: scope.environmentId, path: PROVIDER_SETUP_HANDOFF_PATH },
        runId: run.id,
        nodeId: run.rootNodeId,
        human: {
          location: copy.location,
          providerSetup: {
            ...(intent.driver === undefined ? {} : { driver: intent.driver }),
            ...(intent.instanceId === undefined ? {} : { instanceId: intent.instanceId }),
          },
        },
        args: { version: 1, ...intent },
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
      });
      return {
        kind: "needs_human" as const,
        handoff,
        next: { after: "approval" as const, call: "goat_provider_addable_list" as const },
      };
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(error("request_failed", "Could not ask for provider setup. Try again.")),
      ),
    );

  // Driver error text is meant for the owning client; agents get a fixed message.
  const flowFailure = () =>
    error("sign_in_failed", "Sign-in could not continue. The person can see why in GOAT.", {
      instruction: "Ask the person to finish setup in GOAT's add-provider window.",
      path: "provider.setup_open",
    });

  return ProviderOnboarding.of({
    list: Effect.gen(function* () {
      return {
        environmentId: yield* environment.getEnvironmentId,
        drivers: buildAddableDrivers(driverMeta, yield* snapshots),
      };
    }),
    loginStart: (input, scope) =>
      Effect.gen(function* () {
        const instance = yield* registry.getInstance(input.instanceId);
        if (!instance)
          return error("not_found", "This provider instance does not exist on this environment.", {
            instruction: "Add the provider first.",
            path: "provider.setup_open",
          });
        const name = instance.displayName ?? driverName(instance.driverKind);
        if (!instance.auth) {
          const command = PROVIDER_SIGN_IN_COMMANDS[instance.driverKind];
          return error(
            "unsupported",
            `${name} does not sign in through GOAT.`,
            command
              ? {
                  instruction: `Ask the person to run \`${command}\` on this environment's machine.`,
                }
              : { instruction: "Ask the person to follow the provider's sign-in instructions." },
          );
        }
        const session = yield* managingSession(scope);
        if (Option.isSome(session)) {
          return yield* auth
            .start(
              {
                instanceId: input.instanceId,
                callbackMode: "server",
                ...(input.methodId === undefined ? {} : { methodId: input.methodId }),
              },
              session.value,
            )
            .pipe(
              Effect.map((state) => ({
                kind: "flow" as const,
                flow: redactProviderAuthState(state),
              })),
              Effect.catch(() => Effect.succeed(flowFailure())),
            );
        }
        const host = yield* HostProcess.Hostname;
        return yield* requestSetup(
          scope,
          { driver: instance.driverKind, instanceId: input.instanceId },
          {
            title: `Sign in to ${name}?`,
            reason: "An agent asked you to sign in to this provider.",
            location: `Sign in to ${name} on ${host}. GOAT opens the provider's own sign-in; the provider keeps the credentials.`,
          },
        );
      }),
    loginStatus: (input, scope) =>
      Effect.gen(function* () {
        const session = yield* managingSession(scope);
        if (Option.isNone(session))
          return error("not_found", "This caller owns no sign-in flows.", {
            instruction: "Call goat_provider_addable_list to read sign-in state.",
            path: "provider.addable_list",
          });
        const state = yield* auth.subscribe({ instanceId: input.instanceId }, session.value).pipe(
          Stream.runHead,
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        if (Option.isNone(state) || state.value.flowId !== input.flowId)
          return error("not_found", "This sign-in is not active for this caller.");
        return { kind: "flow" as const, flow: redactProviderAuthState(state.value) };
      }),
    loginCancel: (input, scope) =>
      Effect.gen(function* () {
        const session = yield* managingSession(scope);
        if (Option.isNone(session))
          return error("not_found", "This sign-in is not active for this caller.");
        return yield* auth.cancel(input, session.value).pipe(
          Effect.map((state) => ({ kind: "flow" as const, flow: redactProviderAuthState(state) })),
          Effect.catch(() => Effect.succeed(flowFailure())),
        );
      }),
    setupOpen: (input, scope) =>
      Effect.gen(function* () {
        if (input.driver !== undefined && !driverMeta.some((m) => m.driverKind === input.driver))
          return error("not_found", "GOAT has no provider driver with that name.");
        let driver: string | undefined = input.driver;
        if (input.instanceId !== undefined) {
          const instance = yield* registry.getInstance(input.instanceId);
          if (!instance) return error("not_found", "This provider instance does not exist.");
          if (driver !== undefined && driver !== instance.driverKind)
            return error("invalid_request", "instanceId belongs to a different driver.");
          driver = instance.driverKind;
        }
        const host = yield* HostProcess.Hostname;
        const name = driver === undefined ? "a provider" : driverName(driver);
        return yield* requestSetup(
          scope,
          {
            ...(driver === undefined ? {} : { driver }),
            ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
          },
          {
            title: driver === undefined ? "Add a provider?" : `Set up ${name}?`,
            reason: "An agent asked you to add or sign in to a provider.",
            location: `Set up ${name} on ${host}: install it if needed and sign in. Continue in GOAT's add-provider window.`,
          },
        );
      }),
  });
});

export const layer = Layer.effect(ProviderOnboarding, make);
