import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Notes from "./NotesService.ts";
import * as Auto from "./NoteAutoDone.ts";
import * as Work from "./NoteWorkService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Linked from "../linkedHosts/LinkedHosts.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import { notesLayer } from "./NotesTestkit.ts";

const projectId = ProjectId.make("project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const defaults = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: modelSelection };
const workLayer = (
  options: {
    launch?: Launch.ThreadLaunchService["Service"]["launch"];
    remote?: Dispatch.SshRemoteDispatch["Service"]["launchThread"];
    auto?: Auto.NoteAutoDone["Service"];
    listHosts?: Dispatch.SshRemoteDispatch["Service"]["listHosts"];
    linkedList?: Linked.LinkedHosts["Service"]["list"];
  } = {},
) =>
  Work.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Auto.NoteAutoDone,
        options.auto ?? { reconcile: Effect.void, reconcileNote: () => Effect.void },
      ),
    ),
    Layer.provide(
      Layer.mock(Launch.ThreadLaunchService)({
        launch: options.launch ?? (() => Effect.die("unexpected local launch")),
      }),
    ),
    Layer.provide(
      Layer.mock(Dispatch.SshRemoteDispatch)({
        launchThread: options.remote ?? (() => Effect.die("unexpected remote launch")),
        listHosts:
          options.listHosts ??
          (() => Effect.succeed([{ alias: "ssh-host", source: "ssh-config", reachable: true }])),
      }),
    ),
    Layer.provide(
      Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(defaults) }),
    ),
    Layer.provide(
      Layer.mock(Projects.ProjectService)({
        snapshot: Effect.succeed({
          projects: [
            { id: projectId, title: "project", workspaceRoot: "/project", deletedAt: null },
          ],
          threads: [],
        } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(Linked.LinkedHosts)({
        list:
          options.linkedList ?? Effect.succeed([{ name: "linked", label: "Linked host" }] as never),
      }),
    ),
    Layer.provide(
      Layer.mock(Hosts.HostThreadsMcpService)({
        readOnHost: (_scope, input, decode) => {
          assert.strictEqual(input.tool, "goat_project_list");
          return decode({
            projects: [{ title: "remote project", workspaceRoot: "/remote" }],
            nextCursor: null,
          }).pipe(
            Effect.map((value) => ({ ...value, host: input.host })),
            Effect.orDie,
          );
        },
      }),
    ),
  );

it.effect("local retries use stable launch receipts and append one thread link", () => {
  const launched: Array<Launch.ThreadLaunchInput> = [];
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "# A task\nbody", baseRevision: null }, "user");
    const work = yield* Work.NoteWorkService.pipe(
      Effect.provide(
        workLayer({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input);
              return { threadId: input.threadId!, projection: {} as never, resumed: false };
            }),
        }),
      ),
    );
    const input = {
      path: "task.md",
      requestId: "attempt-1",
      target: { type: "hub" as const, projectId },
    };
    const first = yield* work.startWork(input);
    const retry = yield* work.startWork(input);
    assert.strictEqual(first.threadId, retry.threadId);
    assert.strictEqual(retry.note.threads.length, 1);
    assert.strictEqual(retry.note.status, "doing");
    assert.strictEqual(launched[0]!.commandId, launched[1]!.commandId);
    assert.strictEqual(
      launched[0]!.initialMessage?.messageId,
      launched[1]!.initialMessage?.messageId,
    );
    assert.strictEqual(launched[0]!.reuseExistingThread, undefined);
    assert.strictEqual(launched[0]!.createdBy, "user");
    assert.strictEqual(launched[0]!.runtimeMode, defaults.defaultRuntimeMode);
    assert.deepStrictEqual(launched[0]!.modelSelection, modelSelection);
    assert.include(launched[0]!.initialMessage!.text, 'goat_call {path:"thread.report_result"}');
    const second = yield* work.startWork({ ...input, requestId: "attempt-2" }, "mobile");
    assert.notStrictEqual(first.threadId, second.threadId);
    assert.strictEqual(second.note.threads.length, 2);
    assert.strictEqual(launched.at(-1)!.creationSource, "mobile");
  }).pipe(Effect.provide(notesLayer()));
});

it.effect("remote launch intent survives retries and a reconstructed service", () => {
  let calls = 0;
  const remote: Dispatch.SshRemoteDispatch["Service"]["launchThread"] = (input) =>
    Effect.sync(() => {
      calls++;
      assert.strictEqual(input.host, "host-a");
      assert.strictEqual(input.cwd, "/project");
      return { host: "host-a", threadId: "remote-worker" } as Dispatch.SshLaunchResult;
    });
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "task", baseRevision: null }, "user");
    const input = {
      path: "task.md",
      requestId: "attempt-1",
      target: { type: "host" as const, host: "host-a", projectPath: "/project" },
    };
    const first = yield* Work.NoteWorkService.pipe(Effect.provide(workLayer({ remote })));
    const launched = yield* first.startWork(input);
    const restarted = yield* Work.NoteWorkService.pipe(Effect.provide(workLayer({ remote })));
    const retry = yield* restarted.startWork(input);
    assert.strictEqual(launched.threadId, retry.threadId);
    assert.strictEqual(calls, 1);
    assert.strictEqual(retry.note.threads.length, 1);
    assert.strictEqual(retry.note.threads[0]!.host, "host-a");
  }).pipe(Effect.provide(notesLayer()));
});

it.effect("an ambiguous remote launch never automatically starts a second thread", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "task", baseRevision: null }, "user");
    const input = {
      path: "task.md",
      requestId: "attempt",
      target: { type: "host" as const, host: "host-a", projectPath: "/project" },
    };
    const work = yield* Work.NoteWorkService.pipe(
      Effect.provide(
        workLayer({
          remote: () => {
            calls++;
            return Effect.fail(
              new Dispatch.SshRemoteDispatchError({
                reason: "host_unavailable",
                message: "response lost",
                launchMayHaveStarted: true,
              }),
            );
          },
        }),
      ),
    );
    assert.strictEqual((yield* work.startWork(input).pipe(Effect.flip)).reason, "launch_ambiguous");
    const restarted = yield* Work.NoteWorkService.pipe(Effect.provide(workLayer()));
    assert.strictEqual(
      (yield* restarted.startWork(input).pipe(Effect.flip)).reason,
      "launch_ambiguous",
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual((yield* notes.read({ path: "task.md" })).threads.length, 0);
    const fs = yield* FileSystem.FileSystem;
    const { stateDir } = yield* Config.ServerConfig;
    assert.include(
      yield* fs.readFileString(`${stateDir}/note-work-intents.json`),
      '"state":"launching"',
    );
  }).pipe(Effect.provide(notesLayer()));
});

it.effect("target discovery includes hub, SSH and linked hosts and remote projects", () =>
  Effect.gen(function* () {
    const work = yield* Work.NoteWorkService.pipe(Effect.provide(workLayer()));
    const targets = yield* work.workTargets;
    assert.strictEqual(targets.hub.projects[0]!.projectId, projectId);
    assert.deepStrictEqual(
      targets.hosts.map((host) => host.kind),
      ["ssh", "linked"],
    );
    assert.deepStrictEqual(yield* work.workTargetProjects({ host: "host-a" }), {
      projects: [{ title: "remote project", path: "/remote" }],
    });
  }).pipe(Effect.provide(notesLayer())),
);

it.effect("startWork reconciles only its linked note without waiting on global recovery", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    const reconciled: Array<string> = [];
    const work = yield* Work.NoteWorkService.pipe(
      Effect.provide(
        workLayer({
          launch: (input) =>
            Effect.succeed({ threadId: input.threadId!, projection: {} as never, resumed: false }),
          auto: {
            reconcile: Effect.die("global recovery must not block startWork"),
            reconcileNote: (path) =>
              Effect.sync(() => {
                reconciled.push(path);
              }),
          },
        }),
      ),
    );
    yield* work.startWork({
      path: "task.md",
      requestId: "scoped",
      target: { type: "hub", projectId },
    });
    assert.deepStrictEqual(reconciled, ["task.md"]);
  }).pipe(Effect.provide(notesLayer())),
);

it.effect(
  "work targets list hosts without probing them and keep hub projects when hosts fail",
  () => {
    const probes: Array<boolean> = [];
    return Effect.gen(function* () {
      const listed = yield* Work.NoteWorkService.pipe(
        Effect.flatMap((work) => work.workTargets),
        Effect.provide(
          workLayer({
            listHosts: (input) =>
              Effect.sync(() => {
                probes.push(input.probe);
                return [{ alias: "ssh-host", source: "ssh-config" }] as never;
              }),
          }),
        ),
      );
      assert.deepStrictEqual(probes, [false]);
      assert.deepStrictEqual(
        listed.hosts.map((host) => host.host),
        ["ssh-host", "linked"],
      );
      const failing = yield* Work.NoteWorkService.pipe(
        Effect.flatMap((work) => work.workTargets),
        Effect.provide(
          workLayer({
            listHosts: () =>
              Effect.fail(
                new Dispatch.SshRemoteDispatchError({
                  reason: "ssh_failed",
                  message: "ssh config unreadable",
                }),
              ),
          }),
        ),
      );
      assert.deepStrictEqual(
        failing.hub.projects.map((project) => project.projectId),
        [projectId],
      );
      assert.deepStrictEqual(
        failing.hosts.map((host) => host.host),
        ["linked"],
      );
    }).pipe(Effect.provide(notesLayer()));
  },
);

it.effect(
  "an unreachable host refuses the start as host_unavailable and allows a safe retry",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      yield* notes.write({ path: "task.md", body: "task", baseRevision: null }, "user");
      const input = {
        path: "task.md",
        requestId: "attempt",
        target: { type: "host" as const, host: "host-a", projectPath: "/project" },
      };
      const work = yield* Work.NoteWorkService.pipe(
        Effect.provide(
          workLayer({
            remote: () => {
              calls++;
              return calls === 1
                ? Effect.fail(
                    new Dispatch.SshRemoteDispatchError({
                      reason: "ssh_failed",
                      message: "connection refused",
                    }),
                  )
                : Effect.succeed({ host: "host-a", threadId: "remote-worker" } as never);
            },
          }),
        ),
      );
      assert.strictEqual(
        (yield* work.startWork(input).pipe(Effect.flip)).reason,
        "host_unavailable",
      );
      const retried = yield* work.startWork(input);
      assert.strictEqual(calls, 2);
      assert.strictEqual(retried.note.threads.length, 1);
    }).pipe(Effect.provide(notesLayer()));
  },
);

it.effect("an unreadable linked host list keeps hub projects and SSH hosts", () =>
  Effect.gen(function* () {
    const targets = yield* Work.NoteWorkService.pipe(
      Effect.flatMap((work) => work.workTargets),
      Effect.provide(
        workLayer({
          linkedList: Effect.fail(
            new Linked.LinkedHostError({
              reason: "storage_failed",
              message: "secret store locked",
            }),
          ),
        }),
      ),
    );
    assert.deepStrictEqual(
      targets.hub.projects.map((project) => project.projectId),
      [projectId],
    );
    assert.deepStrictEqual(
      targets.hosts.map((host) => host.host),
      ["ssh-host"],
    );
  }).pipe(Effect.provide(notesLayer())),
);
