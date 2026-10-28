import {
  AuthSessionId,
  ProjectId,
  type AgentTerminalBinding,
  type OrchestrationV2AppThread,
  type ThreadId,
  type ProviderInstanceId,
  requiredScopesForServerSettingsPatch,
  type ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@goat/contracts";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SessionStore from "./auth/SessionStore.ts";
import { MCP_CLIENT_SUBJECT } from "./auth/mcpClientSubject.ts";
const isSettingsError = Schema.is(ServerSettingsError);
export class AgentWorkspaceTerminalPolicyThreadLookup extends Context.Service<
  AgentWorkspaceTerminalPolicyThreadLookup,
  {
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt">,
      ServerSettingsError
    >;
  }
>()("goat/AgentWorkspaceTerminalPolicy/AgentWorkspaceTerminalPolicyThreadLookup") {}

function policyChanged(current: ServerSettings, next: ServerSettings): boolean {
  if (
    current.agentWorkspaceAccess !== next.agentWorkspaceAccess ||
    current.agentTerminalAccess !== next.agentTerminalAccess
  ) {
    return true;
  }
  const projects = new Set(
    [
      ...Object.keys(current.projectSettingsOverrides),
      ...Object.keys(next.projectSettingsOverrides),
    ].map((id) => ProjectId.make(id)),
  );
  for (const projectId of projects) {
    const previous = current.projectSettingsOverrides[projectId];
    const updated = next.projectSettingsOverrides[projectId];
    if (
      previous?.agentWorkspaceAccess !== updated?.agentWorkspaceAccess ||
      previous?.agentTerminalAccess !== updated?.agentTerminalAccess
    ) {
      return true;
    }
  }
  const bindings = new Set(
    [
      ...Object.keys(current.agentTerminalClientBindings),
      ...Object.keys(next.agentTerminalClientBindings),
    ].map((id) => AuthSessionId.make(id)),
  );
  for (const sessionId of bindings) {
    const previous = current.agentTerminalClientBindings[sessionId];
    const updated = next.agentTerminalClientBindings[sessionId];
    if (previous?.threadId !== updated?.threadId || previous?.generation !== updated?.generation) {
      return true;
    }
  }
  return false;
}

/** Compare the resulting policy under the settings lock, including override deletion. */
export const rejectAgentWorkspaceTerminalPolicyChange = Effect.fn(
  "ServerSettings.rejectAgentWorkspaceTerminalPolicyChange",
)(function* (current: ServerSettings, patch: ServerSettingsPatch, settingsPath: string) {
  const next = applyServerSettingsPatch(current, patch);
  if (
    Object.hasOwn(patch, "agentTerminalBinding") ||
    Object.hasOwn(patch, "agentTerminalClientBindings") ||
    policyChanged(current, next)
  ) {
    return yield* new ServerSettingsError({
      settingsPath,
      operation: "normalize",
      cause: new Error("Agent workspace and terminal policy requires a human settings transition."),
    });
  }
});

type Transact = <E, R>(
  update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
  targetIds?: ReadonlyArray<ProviderInstanceId>,
  beforeCommit?: Effect.Effect<void, E | ServerSettingsError, R>,
) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>;

type SettingsMethods = {
  readonly updateSettings: (
    patch: ServerSettingsPatch,
    authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettingsWith: (
    patchFor: (current: ServerSettings) => Effect.Effect<ServerSettingsPatch, ServerSettingsError>,
    authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateAgentWorkspaceTerminalPolicy: (
    patch: ServerSettingsPatch,
    actorSessionId: AuthSessionId,
    agentTerminalBinding?: AgentTerminalBinding,
    authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
};

export const agentWorkspaceTerminalSettingsMethods = (
  transact: Transact,
  settingsPath: string,
  rejectReserved: (
    patch: unknown,
    settingsPath: string,
  ) => Effect.Effect<void, ServerSettingsError>,
  stamp: (current: ServerSettings, next: ServerSettings) => Effect.Effect<ServerSettings>,
): SettingsMethods => ({
  updateSettings: (patch, authorizeAtCommit) =>
    transact(
      (current) =>
        Effect.gen(function* () {
          if (authorizeAtCommit) yield* authorizeAtCommit;
          yield* rejectReserved(patch, settingsPath);
          yield* rejectAgentWorkspaceTerminalPolicyChange(current, patch, settingsPath);
          return yield* stamp(current, applyServerSettingsPatch(current, patch));
        }),
      Object.keys(patch.providerInstances ?? {}).map((id) => id as ProviderInstanceId),
      authorizeAtCommit,
    ),
  updateSettingsWith: (patchFor, authorizeAtCommit) =>
    transact(
      (current) =>
        Effect.gen(function* () {
          if (authorizeAtCommit) yield* authorizeAtCommit;
          const patch = yield* patchFor(current);
          yield* rejectReserved(patch, settingsPath);
          yield* rejectAgentWorkspaceTerminalPolicyChange(current, patch, settingsPath);
          return yield* stamp(current, applyServerSettingsPatch(current, patch));
        }),
      [],
      authorizeAtCommit,
    ),
  updateAgentWorkspaceTerminalPolicy: (
    patch,
    actorSessionId,
    agentTerminalBinding,
    authorizeAtCommit,
  ) => {
    const authorize = Effect.gen(function* () {
      if (authorizeAtCommit) yield* authorizeAtCommit;
      const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);
      if (Option.isNone(sessions)) {
        return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
      }
      const active = yield* sessions.value.listActive();
      const actor = active.find((session) => session.sessionId === actorSessionId);
      if (
        actor === undefined ||
        actor.subject === MCP_CLIENT_SUBJECT ||
        actor.client.deviceType === "bot"
      ) {
        return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
      }
      if (agentTerminalBinding !== undefined) {
        const client = active.find(
          (session) => session.sessionId === agentTerminalBinding.sessionId,
        );
        if (
          client?.subject !== MCP_CLIENT_SUBJECT ||
          client.client.deviceType !== "bot" ||
          client.method !== "bearer-access-token"
        ) {
          return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
        }
        yield* sessions.value.readActiveScopes(client.sessionId);
        if (agentTerminalBinding.threadId !== null) {
          const projections = yield* Effect.serviceOption(AgentWorkspaceTerminalPolicyThreadLookup);
          if (Option.isNone(projections)) {
            return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
          }
          const thread = yield* projections.value.read(agentTerminalBinding.threadId);
          if (thread.deletedAt !== null || thread.archivedAt !== null) {
            return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
          }
        }
      }
      const scopes = yield* sessions.value.readActiveScopes(actorSessionId);
      const required = requiredScopesForServerSettingsPatch(patch, agentTerminalBinding);
      if (!required.every((scope) => scopes.includes(scope))) {
        return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
      }
    }).pipe(
      Effect.mapError((cause) =>
        isSettingsError(cause)
          ? cause
          : new ServerSettingsError({ settingsPath, operation: "normalize", cause }),
      ),
    );
    return transact(
      (current) =>
        Effect.gen(function* () {
          yield* rejectReserved(patch, settingsPath);
          if (
            Object.hasOwn(patch, "agentTerminalBinding") ||
            Object.hasOwn(patch, "agentTerminalClientBindings")
          ) {
            return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
          }
          yield* authorize;
          let next = applyServerSettingsPatch(current, patch);
          const protectedChange =
            agentTerminalBinding !== undefined || policyChanged(current, next);
          if (
            protectedChange &&
            (patch.providerInstances !== undefined ||
              Object.hasOwn(patch, "providers") ||
              patch.usageLimitSources !== undefined)
          ) {
            return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
          }
          if (agentTerminalBinding !== undefined) {
            const bindings = { ...current.agentTerminalClientBindings };
            if (agentTerminalBinding.threadId === null) {
              delete bindings[agentTerminalBinding.sessionId];
            } else {
              const crypto = yield* Effect.serviceOption(Crypto.Crypto);
              if (Option.isNone(crypto)) {
                return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
              }
              const generation = yield* crypto.value
                .randomUUIDv4()
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({ settingsPath, operation: "normalize", cause }),
                  ),
                );
              bindings[agentTerminalBinding.sessionId] = {
                threadId: agentTerminalBinding.threadId,
                generation,
              };
            }
            next = { ...next, agentTerminalClientBindings: bindings };
          }
          return yield* stamp(current, next);
        }),
      Object.keys(patch.providerInstances ?? {}).map((id) => id as ProviderInstanceId),
      authorize,
    );
  },
});
