import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProjectScript,
  type ServerSettings,
  type TerminalEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as ProjectService from "../ProjectService.ts";
import * as ProjectSetupScriptRunner from "../ProjectSetupScriptRunner.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";

export const projectId = ProjectId.make("project:setup-file");

export const setupScript: ProjectScript = {
  id: "stored-setup",
  name: "Stored setup",
  command: "stored-setup",
  icon: "configure",
  runOnWorktreeCreate: true,
};

export const runSetup = Effect.fn("test.runSetup")(function* (input: {
  readonly root: string;
  readonly checkout: string;
  readonly scripts?: readonly ProjectScript[];
  readonly settings?: Partial<ServerSettings>;
}) {
  const writes: string[] = [];
  const opened: string[] = [];
  const written = yield* Deferred.make<void>();
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...input.settings }),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        open: (terminal) =>
          Effect.sync(() => {
            opened.push(terminal.cwd);
          }).pipe(
            Effect.andThen(
              Effect.forEach(
                [...listeners],
                (listener) => listener({ type: "output", ...terminal, data: "\x1b[?2004h" }),
                { discard: true },
              ),
            ),
            Effect.as({} as never),
          ),
        write: ({ data }) =>
          Effect.sync(() => {
            writes.push(data);
          }).pipe(Effect.andThen(Deferred.succeed(written, undefined))),
        subscribe: (listener) =>
          Effect.sync(() => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const result = yield* Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread:setup-file",
      worktreePath: input.checkout,
      project: { id: projectId, workspaceRoot: input.root, scripts: input.scripts ?? [] },
    });
    if (result.status === "started") yield* Deferred.await(written);
    return result;
  }).pipe(Effect.provide(layer));
  return { result, writes, opened };
});

export const makeObservedSetup = Effect.gen(function* () {
  const written = yield* Deferred.make<{ threadId: string; terminalId: string; data: string }>();
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        open: ({ threadId, terminalId }) =>
          emit({ type: "output", threadId, terminalId, data: "\x1b[?2004h" }).pipe(
            Effect.as({} as never),
          ),
        write: (input) => Deferred.succeed(written, input).pipe(Effect.asVoid),
        closeIdle: () => Effect.void,
        subscribe: (onEvent) =>
          Effect.sync(() => {
            listeners.add(onEvent);
            return () => {
              listeners.delete(onEvent);
            };
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  const { runForThread } = Context.get(context, ProjectSetupScriptRunner.ProjectSetupScriptRunner);
  const finish = Effect.gen(function* () {
    const { threadId, terminalId, data } = yield* Deferred.await(written);
    const sentinel = data.match(/__GOAT_SETUP_DONE__[a-f0-9_]+:/)?.[0];
    if (!sentinel || listeners.size === 0)
      return yield* Effect.die("Setup completion was not observed");
    yield* emit({ type: "output", threadId, terminalId, data: `ready\n${sentinel}0\n$ ` });
  });
  return { runForThread, written, finish };
});
