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
          }).pipe(Effect.as({} as never)),
        write: ({ data }) =>
          Effect.sync(() => {
            writes.push(data);
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const result = yield* Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    return yield* runner.runForThread({
      threadId: "thread:setup-file",
      worktreePath: input.checkout,
      project: { id: projectId, workspaceRoot: input.root, scripts: input.scripts ?? [] },
    });
  }).pipe(Effect.provide(layer));
  return { result, writes, opened };
});

export const makeObservedSetup = Effect.gen(function* () {
  const written = yield* Deferred.make<{ threadId: string; terminalId: string; data: string }>();
  let listener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        open: () => Effect.succeed({} as never),
        write: (input) => Deferred.succeed(written, input).pipe(Effect.asVoid),
        closeIdle: () => Effect.void,
        subscribe: (onEvent) =>
          Effect.sync(() => {
            listener = onEvent;
            return () => {
              listener = undefined;
            };
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"] =
    (input) =>
      Effect.flatMap(ProjectSetupScriptRunner.ProjectSetupScriptRunner, (runner) =>
        runner.runForThread(input),
      ).pipe(Effect.provide(layer));
  const finish = Effect.gen(function* () {
    const { threadId, terminalId, data } = yield* Deferred.await(written);
    const sentinel = data.match(/__GOAT_SETUP_DONE__[a-f0-9_]+:/)?.[0];
    if (!sentinel || !listener) return yield* Effect.die("Setup completion was not observed");
    yield* listener({ type: "output", threadId, terminalId, data: `ready\n${sentinel}0\n$ ` });
  });
  return { runForThread, written, finish };
});
