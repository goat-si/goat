// @effect-diagnostics-next-line nodeBuiltinImport:off -- request ids must survive retries and process restarts.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  NoteError,
  ThreadId,
  type NotesStartWorkInput,
  type NotesStartWorkResult,
  type NotesWorkTargetsResult,
  type NotesWorkTargetProjectsResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Projects from "../project/ProjectService.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Settings from "../serverSettings.ts";
import * as Notes from "./NotesService.ts";
import * as Results from "./NoteResults.ts";
import * as AutoDone from "./NoteAutoDone.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

const Intent = Schema.Struct({
  key: Schema.String,
  requestId: Schema.String,
  notePath: Schema.String,
  host: Schema.String,
  state: Schema.Literals(["launching", "launched"]),
  threadId: Schema.NullOr(ThreadId),
});
type Intent = typeof Intent.Type;
const encodeIntents = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Intent)));
const decodeIntents = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Intent)));
const RemoteProjects = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ title: Schema.String, workspaceRoot: Schema.String })),
  nextCursor: Schema.NullOr(Schema.Number),
});

const decodeRemoteProjects = Schema.decodeUnknownEffect(RemoteProjects);

export class NoteWorkService extends Context.Service<
  NoteWorkService,
  {
    readonly workTargets: Effect.Effect<NotesWorkTargetsResult, NoteError>;
    readonly workTargetProjects: (input: {
      readonly host: string;
    }) => Effect.Effect<NotesWorkTargetProjectsResult, NoteError>;
    readonly startWork: (
      input: NotesStartWorkInput,
      creationSource?: "web" | "mobile",
    ) => Effect.Effect<NotesStartWorkResult, NoteError>;
  }
>()("goat/notes/NoteWorkService") {}

const make = Effect.gen(function* () {
  const notes = yield* Notes.NotesService;
  const results = yield* Results.NoteResults;
  const autoDone = yield* AutoDone.NoteAutoDone;
  const projects = yield* Projects.ProjectService;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const linked = yield* LinkedHosts.LinkedHosts;
  const hosts = yield* Hosts.HostThreadsMcpService;
  const launches = yield* Launch.ThreadLaunchService;
  const settings = yield* Settings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* Config.ServerConfig;
  const intentPath = path.join(stateDir, "note-work-intents.json");
  const lock = yield* Semaphore.make(1);
  const storage = new NoteError({
    reason: "storage",
    message: "Note work intent storage is unavailable.",
  });
  const loadIntents = fs.readFileString(intentPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
    Effect.flatMap(decodeIntents),
    Effect.mapError(() => storage),
  );
  const saveIntents = (intents: ReadonlyArray<Intent>) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(stateDir, { recursive: true });
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: stateDir,
          prefix: ".note-intent-",
        });
        const file = path.join(temporary, "intents.json");
        yield* fs.writeFileString(file, yield* encodeIntents(intents));
        yield* fs.rename(file, intentPath);
      }),
    ).pipe(Effect.mapError(() => storage));
  const unavailable = new NoteError({
    reason: "host_unavailable",
    message: "The host is unavailable.",
  });
  const workTargets = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(() => storage));
    // Probing SSHes into every configured host and takes tens of seconds; a picker only needs
    // the names. An unreachable host fails at launch with host_unavailable instead. Host lists
    // that cannot be read leave the hub's own projects available.
    const ssh = yield* dispatch
      .listHosts({ probe: false })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<Dispatch.SshDispatchHost> => []));
    const links = yield* linked.list.pipe(Effect.orElseSucceed(() => []));
    const linkedNames = new Set(links.map((link) => link.name));
    return {
      hub: {
        projects: snapshot.projects
          .filter((project) => project.deletedAt === null)
          .map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
      },
      hosts: [
        ...ssh
          .filter((host) => host.reachable !== false && !linkedNames.has(host.alias))
          .map((host) => ({ host: host.alias, label: host.alias, kind: "ssh" as const })),
        ...links.map((host) => ({ host: host.name, label: host.label, kind: "linked" as const })),
      ],
    };
  });
  const workTargetProjects = Effect.fn("NoteWorkService.workTargetProjects")(function* (input: {
    readonly host: string;
  }) {
    const collected: Array<{ title: string; path: string }> = [];
    let cursor = 0;
    while (collected.length < 500) {
      const page = yield* hosts
        .readOnHost(
          results.scope,
          {
            host: input.host,
            tool: "goat_project_list",
            arguments: { cursor, limit: 100 },
          },
          decodeRemoteProjects,
        )
        .pipe(Effect.mapError(() => unavailable));
      collected.push(
        ...page.projects.map((project) => ({ title: project.title, path: project.workspaceRoot })),
      );
      if (page.nextCursor === null || page.nextCursor <= cursor) break;
      cursor = page.nextCursor;
    }
    return { projects: collected.slice(0, 500) };
  });
  const startWork: NoteWorkService["Service"]["startWork"] = (input, creationSource = "web") =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const note = yield* notes.read({ path: input.path });
        const key = NodeCrypto.createHash("sha256")
          .update(`${input.path.length}:${input.path}${input.requestId}`)
          .digest("hex");
        const defaults = yield* settings.getSettings.pipe(Effect.mapError(() => storage));
        const modelSelection = input.modelSelection ?? defaults.defaultModelSelection;
        if (modelSelection === null)
          return yield* new NoteError({
            reason: "launch_failed",
            message: "Choose a model or configure the hub's default model before starting work.",
          });
        const message = `${note.title}\n\n${note.body}\n\nWhen finished, report with ${goatCallText("thread.report_result")}.`;
        let threadId: ThreadId;
        let host: string | null = null;
        if (input.target.type === "hub") {
          const launched = yield* launches
            .launch({
              commandId: CommandId.make(`note:${key}`),
              threadId: ThreadId.make(`note:${key}`),
              projectId: input.target.projectId,
              title: note.title,
              modelSelection,
              runtimeMode: defaults.defaultRuntimeMode,
              interactionMode: "default",
              workspaceStrategy: input.workspace ?? { type: "root" },
              initialMessage: {
                messageId: MessageId.make(`note:${key}:message`),
                text: message,
                attachments: [],
              },
              createdBy: "user",
              creationSource,
              fromClient: true,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new NoteError({
                    reason: "launch_failed",
                    message: "Starting work from the note failed.",
                    path: input.path,
                  }),
              ),
            );
          threadId = launched.threadId;
        } else {
          host = input.target.host;
          const intents = yield* loadIntents;
          const existing = intents.find((intent) => intent.key === key);
          if (existing && existing.host !== host)
            return yield* new NoteError({
              reason: "launch_ambiguous",
              message:
                "This request already targeted another host. Check that host's threads before starting again.",
            });
          if (existing?.state === "launching")
            return yield* new NoteError({
              reason: "launch_ambiguous",
              message:
                "The launch may have started. Check the host's threads before starting again.",
            });
          if (existing?.threadId) threadId = existing.threadId;
          else {
            const intent: Intent = {
              key,
              requestId: input.requestId,
              notePath: input.path,
              host,
              state: "launching",
              threadId: null,
            };
            yield* saveIntents([...intents, intent]);
            // Once the remote may have received a request, interruption leaves the launching intent intact.
            const launched = yield* dispatch
              .launchThread(
                {
                  host,
                  cwd: input.target.projectPath,
                  workspace:
                    input.workspace?.type === "worktree"
                      ? {
                          ...input.workspace,
                          branch: input.workspace.branch ?? `note/${key.slice(0, 16)}`,
                        }
                      : { type: "cwd" },
                  title: note.title,
                  message,
                  modelSelection,
                  runtimeMode: defaults.defaultRuntimeMode,
                  callerRuntimeMode: "full-access",
                  interactionMode: "default",
                },
                Effect.void,
              )
              .pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (!error.launchMayHaveStarted) yield* saveIntents(intents);
                    if (error.launchMayHaveStarted)
                      return yield* new NoteError({
                        reason: "launch_ambiguous",
                        message:
                          "The launch may have started. Check the host's threads before starting again.",
                        path: input.path,
                      });
                    // Host lists are not probed, so an offline host first shows up here.
                    const offline =
                      error.reason === "host_unavailable" || error.reason === "ssh_failed";
                    return yield* new NoteError({
                      reason: offline ? "host_unavailable" : "launch_failed",
                      message: offline
                        ? "The host is unavailable. Nothing was started."
                        : "Starting work on the host failed.",
                      path: input.path,
                    });
                  }),
                ),
              );
            threadId = ThreadId.make(launched.threadId);
            yield* saveIntents([...intents, { ...intent, state: "launched", threadId }]);
          }
        }
        const linkedNote = yield* notes.link(input.path, { threadId, host, lastResult: null });
        yield* autoDone.reconcileNote(linkedNote.path);
        return { note: yield* notes.read({ path: linkedNote.path }), threadId, host };
      }),
    );
  return NoteWorkService.of({ workTargets, workTargetProjects, startWork });
});
export const layer = Layer.effect(NoteWorkService, make);
