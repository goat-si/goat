import { ThreadId, type ModelSelection } from "@goat/contracts";
import type * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { causeErrorTag } from "@goat/shared/observability";
import { Session } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ThreadState } from "./adapterState.ts";
import { agentPaths } from "./adapterUtilities.ts";
import { modelRef } from "./modelRef.ts";
import type * as OpenCode2Server from "./OpenCode2Server.ts";
import { sameRules, sessionRules, type Rule, type RulesPolicy } from "./sessionRules.ts";

export const makeSessionInventory = ({
  client,
  defaultDirectory,
  appThreadIdOf,
  mcpSessions,
  mcpServerNameFor,
  cuaServerNameFor,
}: {
  readonly client: () => OpenCode2Server.OpenCode2Connection["client"];
  readonly defaultDirectory: string;
  readonly appThreadIdOf: (state: ThreadState) => string | null;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly mcpServerNameFor: (threadId: string) => Effect.Effect<string>;
  readonly cuaServerNameFor: (threadId: string) => Effect.Effect<string>;
}) => {
  // Project config changes model limits; key by directory because this runtime serves all instance threads.
  const contextWindows = new Map<string, Map<string, number>>();
  const modelVariants = new Map<string, Map<string, ReadonlySet<string>>>();
  const directoryOf = (cwd: string | null | undefined) => cwd ?? defaultDirectory;
  const windowOf = (cwd: string | null | undefined, model: string) =>
    contextWindows.get(directoryOf(cwd))?.get(model);
  const listedModelRef = (selection: ModelSelection, cwd: string | null | undefined) =>
    modelRef(selection, modelVariants.get(directoryOf(cwd))?.get(selection.model));
  const readModels = (directory: string) =>
    Effect.suspend(() => {
      const windows = contextWindows.get(directory) ?? new Map<string, number>();
      contextWindows.set(directory, windows);
      const variants = modelVariants.get(directory) ?? new Map<string, ReadonlySet<string>>();
      modelVariants.set(directory, variants);
      return client()
        .model.list({ location: { directory } })
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.tap((models) =>
            Effect.sync(() => {
              for (const model of models.data) {
                const slug = `${model.providerID}/${model.id}`;
                windows.set(slug, model.limit.input ?? model.limit.context);
                variants.set(slug, new Set(model.variants.map((variant) => variant.id)));
              }
            }),
          ),
          Effect.ignore({ log: true }),
        );
    });
  const readModelsOnce = (cwd: string | null | undefined) =>
    contextWindows.has(directoryOf(cwd)) ? Effect.void : readModels(directoryOf(cwd));
  const agentRules = new Map<string, ReadonlyMap<string, ReadonlyArray<Rule>>>();
  const pathsFor = Effect.fnUntraced(function* (directory: string, agents: ReadonlyArray<string>) {
    let known = agentRules.get(directory);
    if (known === undefined) {
      // A fresh server lists no agents for its first moments, like its models.
      const listed = yield* client()
        .agent.list({ location: { directory } })
        .pipe(
          Effect.repeat({
            until: (list) => list.data.length > 0,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeout("5 seconds"),
          Effect.tapCause((cause) =>
            Effect.logWarning(
              "Could not list OpenCode agents; their path rules are skipped.",
              cause,
            ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
          ),
          Effect.option,
        );
      if (listed._tag === "None") return [];
      known = new Map(listed.value.data.map((agent) => [agent.id, agentPaths(agent.permissions)]));
      agentRules.set(directory, known);
    }
    const paths = new Map<string, Rule>();
    for (const agent of agents) {
      for (const entry of known.get(agent) ?? []) {
        paths.set(`${entry.action}\u0000${entry.resource}`, entry);
      }
    }
    return [...paths.values()];
  });

  const rulesFor = Effect.fnUntraced(function* (
    thread: Pick<ThreadState, "directory" | "agent" | "grants">,
    policy: RulesPolicy,
    appThreadId: string | null,
  ) {
    const plan = policy.interactionMode === "plan";
    const paths =
      policy.runtimeMode === "full-access" && !plan
        ? []
        : yield* pathsFor(thread.directory, plan ? [thread.agent, "plan"] : [thread.agent]);
    const mcpSession =
      appThreadId === null ? undefined : yield* mcpSessions.read(ThreadId.make(appThreadId));
    return sessionRules(
      policy,
      paths,
      policy.runtimeMode === "full-access" ? [] : thread.grants,
      appThreadId === null
        ? null
        : {
            goat: yield* mcpServerNameFor(appThreadId),
            cua: mcpSession?.cuaDriver === undefined ? null : yield* cuaServerNameFor(appThreadId),
          },
      mcpSession?.nativeSubagentLimit === 0,
    );
  });

  const writeRules = Effect.fnUntraced(function* (state: ThreadState, policy: RulesPolicy) {
    const rules = yield* rulesFor(state, policy, appThreadIdOf(state));
    if (!sameRules(state.rules, rules)) {
      yield* client().session.update({
        sessionID: Session.ID.make(state.sessionId),
        permissions: rules,
      });
      state.rules = rules;
    }
    state.policy = policy;
  });

  return {
    directoryOf,
    windowOf,
    listedModelRef,
    readModels,
    readModelsOnce,
    rulesFor,
    writeRules,
  };
};
