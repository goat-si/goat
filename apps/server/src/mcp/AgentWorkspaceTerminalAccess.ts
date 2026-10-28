import {
  OrchestratorMcpFailure,
  AuthSessionId,
  type AuthEnvironmentScope,
  type ProjectId,
  type ThreadId,
} from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Settings from "../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import {
  assertLiveCaller,
  loadCaller,
  reauthorizationFailure,
  unavailable,
} from "./threadAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";

export const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
export const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export interface AgentWorkspaceTarget {
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}
export interface AgentWorkspacePermit {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | undefined;
  readonly root: string;
  readonly owner: string;
  readonly bindingGeneration: string | undefined;
}

export class AgentWorkspaceTerminalAccess extends Context.Service<
  AgentWorkspaceTerminalAccess,
  {
    readonly authorize: (
      scope: McpInvocationScope,
      target: AgentWorkspaceTarget,
      permission: AuthEnvironmentScope,
    ) => Effect.Effect<AgentWorkspacePermit, OrchestratorMcpFailure>;
  }
>()("goat/mcp/AgentWorkspaceTerminalAccess") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* Projects.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const profiles = yield* Profiles.PermissionProfiles;
  const audit = yield* Audit.AgentWorkspaceTerminalAudit;

  const authorize = Effect.fn("AgentWorkspaceTerminalAccess.authorize")(function* (
    scope: McpInvocationScope,
    target: AgentWorkspaceTarget,
    permission: AuthEnvironmentScope,
  ) {
    const terminal = permission.startsWith("terminal:");
    const writes = permission === "filesystem:write" || permission === "terminal:operate";
    const check = Effect.gen(function* () {
      if (!scope.grantedScopes?.includes(permission) || !scope.reauthorize)
        return yield* denied(
          `This operation needs an explicit ${permission} grant. Approve it separately when connecting the agent.`,
        );
      yield* scope.reauthorize([permission]).pipe(Effect.mapError(reauthorizationFailure));
      if ((yield* environment.getEnvironmentId) !== scope.environmentId)
        return yield* denied("This credential belongs to another environment.");
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      if (target.threadId !== undefined && target.projectId !== undefined)
        return yield* invalid("Choose threadId or projectId, not both.");
      const binding =
        scope.client === undefined
          ? undefined
          : current.agentTerminalClientBindings[AuthSessionId.make(scope.client.sessionId)];
      const threadId = terminal
        ? (scope.thread?.threadId ?? binding?.threadId)
        : (scope.thread?.threadId ?? target.threadId);
      if (
        scope.thread &&
        (target.projectId !== undefined ||
          (target.threadId !== undefined && target.threadId !== threadId))
      )
        return yield* denied("A GOAT agent can access only its own thread workspace.");
      if (terminal && threadId === undefined)
        return yield* denied(
          "Ask a person to bind this authorized client to a thread in Settings → Connections before using terminals.",
        );
      const thread =
        threadId === undefined
          ? null
          : yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (
        threadId !== undefined &&
        (!thread || thread.deletedAt !== null || thread.archivedAt !== null)
      )
        return yield* denied("The destination thread is missing, archived or deleted.");
      const projectId = thread?.projectId ?? target.projectId;
      if (projectId === undefined)
        return yield* invalid("Pass projectId or threadId for this workspace.");
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) return yield* denied("The destination project is unavailable.");
      const effective = resolveProjectSettings(current, projectId).settings;
      const level = terminal ? effective.agentTerminalAccess : effective.agentWorkspaceAccess;
      if (level === "off" || (writes && level !== (terminal ? "operate" : "read_write")))
        return yield* denied(
          "Agent access is off or read only. A person can change it in Settings → Integrations → Agent tools, including project overrides.",
        );
      const context = yield* loadCaller().pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      );
      yield* assertLiveCaller(context);
      if (
        writes &&
        (scope.readOnly ||
          context.limits.interactionMode !== "default" ||
          (terminal
            ? context.limits.runtimeMode !== "full-access"
            : !["auto-accept-edits", "auto", "full-access"].includes(context.limits.runtimeMode)))
      )
        return yield* denied(
          terminal
            ? "Terminal operations require full access mode."
            : "File writes require a mode that permits edits.",
        );
      if (writes && scope.thread) {
        const profile = yield* profiles.resolve(scope).pipe(Effect.mapError(unavailable));
        const result = Profiles.checkProfile(
          profile,
          terminal ? "terminal.operate" : "workspace.write",
          {},
        );
        if (!result.ok) return yield* denied(result.reason);
      }
      yield* scope.reauthorize([permission]).pipe(Effect.mapError(reauthorizationFailure));
      return {
        projectId,
        threadId,
        root: thread?.worktreePath ?? project.value.workspaceRoot,
        owner: scope.thread
          ? `thread:${scope.thread.threadId}`
          : `client:${scope.client?.sessionId}`,
        bindingGeneration: terminal && scope.client ? binding?.generation : undefined,
      } satisfies AgentWorkspacePermit;
    });
    return yield* check.pipe(
      Effect.tapError(() =>
        audit.append(
          scope,
          permission,
          target.threadId ?? target.projectId ?? "own-thread",
          "denied",
        ),
      ),
    );
  });
  return AgentWorkspaceTerminalAccess.of({ authorize });
});
export const layer = Layer.effect(AgentWorkspaceTerminalAccess, make);
