import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpClient from "effect-acp/client";
import { normalizeDevinSessionUpdate } from "@goat/provider-acp-registry/server/devinAcp";
import type * as Acp from "effect-acp/compat";
import type { OrchestrationV2CloudTask } from "@goat/contracts";
import { DevinCloudCliError, type DevinCloudLaunch } from "./cli.ts";

export interface CloudRelay {
  readonly capabilities: Acp.AgentCapabilities;
  readonly create: Effect.Effect<Acp.NewSessionResponse, DevinCloudCliError>;
  readonly configureSource: (
    id: string,
    source: OrchestrationV2CloudTask["source"],
    selection?: { readonly model: string; readonly platform: string },
  ) => Effect.Effect<void, DevinCloudCliError>;
  readonly attach: (id: string) => Effect.Effect<Acp.LoadSessionResponse, DevinCloudCliError>;
  readonly prompt: (
    id: string,
    text: string,
  ) => Effect.Effect<Acp.PromptResponse, DevinCloudCliError>;
  readonly cancel: (id: string) => Effect.Effect<void, DevinCloudCliError>;
}
export class DevinCloudRelay extends Context.Service<
  DevinCloudRelay,
  {
    readonly open: (
      launch: DevinCloudLaunch,
      onUpdate: (notice: Acp.SessionNotification) => Effect.Effect<void>,
    ) => Effect.Effect<CloudRelay, DevinCloudCliError, Scope.Scope>;
  }
>()("@goat/provider-devin-cloud/server/relay/DevinCloudRelay") {}

function repositoryChoice(repository: string): string | undefined {
  try {
    const url = new URL(repository);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/?$/u.exec(url.pathname);
    if (!match) return undefined;
    const name = match[2]!.replace(/\.git$/u, "");
    return name ? `${match[1]}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

/** Pure readback check shared by creation and deliberate follow-up after load.
 * Missing/null options, unoffered repositories, or any non-exact selection fail closed.
 */
export function validateRepositorySelection(
  configOptions: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  source: OrchestrationV2CloudTask["source"],
): boolean {
  const value = repositoryChoice(source.repository);
  const repos = configOptions?.filter((option) => option.id === "repos");
  const selected = repos?.length === 1 ? repos[0] : undefined;
  return (
    value !== undefined &&
    selected?.type === "select" &&
    selected.currentValue === value &&
    selected.options.some((choice) =>
      "options" in choice
        ? choice.options.some((entry) => entry.value === value)
        : choice.value === value,
    )
  );
}

function offeredSelection(
  options: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  id: string,
  value: string,
): boolean {
  const matches = options?.filter((option) => option.id === id);
  const selected = matches?.length === 1 ? matches[0] : undefined;
  return (
    selected?.type === "select" &&
    selected.options.some((choice) =>
      "options" in choice
        ? choice.options.some((entry) => entry.value === value)
        : choice.value === value,
    )
  );
}

function confirmedSelection(
  options: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  id: string,
  value: string,
): boolean {
  const matches = options?.filter((option) => option.id === id);
  return (
    matches?.length === 1 &&
    matches[0]?.currentValue === value &&
    offeredSelection(options, id, value)
  );
}

/** The session currently holds the requested version and platform; "default" leaves Devin's own. */
export function confirmsChoices(
  configOptions: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  selection: { readonly model: string; readonly platform: string },
): boolean {
  return (
    (selection.model === "default" ||
      confirmedSelection(configOptions, "devin_version", selection.model)) &&
    (selection.platform === "default" ||
      confirmedSelection(configOptions, "platform", selection.platform))
  );
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return DevinCloudRelay.of({
    open: Effect.fn("DevinCloudRelay.open")(function* (
      launch: DevinCloudLaunch,
      onUpdate: (notice: Acp.SessionNotification) => Effect.Effect<void>,
    ) {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(launch.command, ["acp", "--cloud"], {
            cwd: launch.cwd,
            env: launch.env,
            shell: false,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "relay", cause })));
      // Drain diagnostics without logging potential credentials or task text.
      yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
      const context = yield* Layer.build(
        AcpClient.layerChildProcess(child, { transformSessionUpdate: normalizeDevinSessionUpdate }),
      );
      const client = yield* Effect.service(AcpClient.AcpClient).pipe(Effect.provide(context));
      yield* client.handleSessionUpdate(onUpdate);
      yield* client.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" } }),
      );
      // No client FS, terminal, MCP or elicitation handlers are registered. No capabilities advertised.
      const initialized = yield* client.agent
        .initialize({
          protocolVersion: 2,
          clientCapabilities: {},
          clientInfo: { name: "goat-devin-cloud", version: "1" },
        })
        .pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "relay", cause })));
      const capabilities = initialized.agentCapabilities ?? {};
      const wrap = <A>(effect: Effect.Effect<A, import("effect-acp/errors").AcpError>) =>
        effect.pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "relay", cause })));
      const setups = new Map<string, ReadonlyArray<Acp.SessionConfigOption>>();
      const create = wrap(client.agent.createSession({ cwd: launch.cwd, mcpServers: [] })).pipe(
        Effect.flatMap((reply) =>
          /^devin-\S+$/u.test(reply.sessionId)
            ? Effect.sync(() => {
                setups.set(reply.sessionId, reply.configOptions ?? []);
                return reply;
              })
            : Effect.fail(
                new DevinCloudCliError({
                  stage: "relay",
                  detail:
                    "Devin returned an invalid cloud session identity; do not retry creation automatically.",
                }),
              ),
        ),
      );
      return {
        capabilities,
        create,
        configureSource: (sessionId, source, selection) =>
          Effect.gen(function* () {
            const value = repositoryChoice(source.repository);
            const applied: Array<{ id: string; value: string }> = [];
            for (const choice of [
              { id: "devin_version", value: selection?.model ?? "default" },
              { id: "platform", value: selection?.platform ?? "default" },
            ]) {
              if (choice.value === "default") continue;
              if (!offeredSelection(setups.get(sessionId), choice.id, choice.value))
                return yield* new DevinCloudCliError({
                  stage: "relay",
                  detail: `Devin does not offer ${choice.id}=${choice.value} for this cloud session; no prompt was sent.`,
                });
              const reply = yield* wrap(
                client.agent.setSessionConfigOption({
                  sessionId,
                  configId: choice.id,
                  value: choice.value,
                }),
              );
              if (!confirmedSelection(reply.configOptions, choice.id, choice.value))
                return yield* new DevinCloudCliError({
                  stage: "relay",
                  detail: `Devin did not confirm ${choice.id}=${choice.value}; no prompt was sent.`,
                });
              setups.set(sessionId, reply.configOptions);
              applied.push(choice);
            }
            if (!value || !offeredSelection(setups.get(sessionId), "repos", value)) {
              return yield* new DevinCloudCliError({
                stage: "relay",
                detail:
                  "The published repository is not offered by this Devin organization's repos option. Grant access in Devin before sending.",
              });
            }
            const reply = yield* wrap(
              client.agent.setSessionConfigOption({ sessionId, configId: "repos", value }),
            );
            if (
              !validateRepositorySelection(reply.configOptions, source) ||
              applied.some(({ id, value }) => !confirmedSelection(reply.configOptions, id, value))
            ) {
              return yield* new DevinCloudCliError({
                stage: "relay",
                detail:
                  "Devin did not confirm the selected version, platform and repository together; no prompt was sent.",
              });
            }
            setups.set(sessionId, reply.configOptions);
          }),
        attach: (sessionId) =>
          capabilities.loadSession
            ? wrap(client.agent.loadSession({ sessionId, cwd: launch.cwd, mcpServers: [] })).pipe(
                Effect.tap((reply) =>
                  Effect.sync(() => setups.set(sessionId, reply.configOptions ?? [])),
                ),
              )
            : Effect.fail(
                new DevinCloudCliError({
                  stage: "relay",
                  detail: "This Devin relay cannot load the saved session.",
                }),
              ),
        prompt: (sessionId, text) =>
          wrap(client.agent.prompt({ sessionId, prompt: [{ type: "text", text }] })),
        cancel: (sessionId) => wrap(client.agent.cancel({ sessionId })),
      } satisfies CloudRelay;
    }),
  });
});
export const layer = Layer.effect(DevinCloudRelay, make);
