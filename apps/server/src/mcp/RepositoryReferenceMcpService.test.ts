import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as PermissionSettings from "../serverSettings.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RepositoryReferenceSnapshot,
  RunId,
  ThreadId,
  type RepositoryReferenceRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { referenceFixture, referenceTestLayer } from "../project/RepositoryReferences.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as ReferenceMcp from "./RepositoryReferenceMcpService.ts";
import * as Launch from "./ThreadLaunchMcpService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { prefixedSecretAssignments } from "../project/referenceSecretFixtures.testkit.ts";
import { SshToolkit } from "./toolkits/ssh/tools.ts";
import * as SshHandlers from "./toolkits/ssh/handlers.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../sshRemote/SshWorkspaceSync.ts";
import * as SshDeviceAdd from "../sshRemote/SshDeviceAdd.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RepositoryLaunchMcpService from "./RepositoryLaunchMcpService.ts";

const scope = (
  access: "read-only" | "full-access" = "full-access",
): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("reference-test"),
  requestNamespace: "reference-test",
  capabilities: new Set(["orchestration"]),
  grantedScopes: ["orchestration:read", "filesystem:read"],
  reauthorize: () => Effect.void,
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "reference-test", label: "Reference test", access },
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decodeSnapshots = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(RepositoryReferenceSnapshot)),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "reference-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "reference-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const toolkitFixture = Effect.gen(function* () {
  const f = yield* referenceFixture;
  const launched: Array<{ message: string | undefined }> = [];
  const referencesLayer = ReferenceMcp.layer.pipe(
    Layer.provide(f.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(HostThreads.HostThreadsMcpService)({
        readOnHost: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "host_unavailable",
              message: "Reference source is unavailable or lacks the snapshot tool.",
            }),
          ),
      }),
    ),
  );
  const registration = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
    McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer),
  ).pipe(
    Layer.provide(Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest()))),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        validateLaunchAttachments: (attachments) => Effect.succeed(attachments),
        launchThread: () => Effect.die("Reference refusal must precede SSH launch"),
      }),
    ),
    Layer.provide(Layer.mock(SshHostSetup.SshHostSetup)({})),
    Layer.provide(Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({})),
    Layer.provide(Layer.mock(SshDeviceAdd.SshDeviceAdd)({})),
    Layer.provide(Layer.mock(ServerEnvironment.ServerEnvironment)({})),
    Layer.provide(Layer.mock(CloudMachineService.CloudMachineService)({})),
    Layer.provide(Layer.mock(LaunchWatchService.LaunchWatchService)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({})),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(referencesLayer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(Projects.ProjectService)({})),
    Layer.provide(Layer.mock(Folders.ManagedProjectFolders)({ namedProjectsRoot: f.root })),
    Layer.provide(Layer.mock(Repositories.SourceControlRepositoryService)({})),
    Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
    Layer.provide(
      Layer.mock(Launch.ThreadLaunchMcpService)({
        launch: (_scope, input) =>
          Effect.sync(() => {
            launched.push({ message: input.message });
            return {
              threadId: ThreadId.make("worker"),
              projectId: ProjectId.make("worker-project"),
              modelSelection: { instanceId: ProviderInstanceId.make("fixture"), model: "fixture" },
              runId: RunId.make("worker-run"),
              status: "running" as const,
              watching: false,
              standingInstructionsVersion: null,
            };
          }),
      }),
    ),
  );
  const call = (name: string, args: Record<string, unknown>, caller = scope()) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(Invocation.McpInvocationContext, caller),
      Effect.provide(registration),
    );
  return { ...f, call, launched };
});

it.live("both actual MCP launch tools refuse prefixed secret blobs without partial briefs", () =>
  Effect.gen(function* () {
    const f = yield* toolkitFixture;
    for (const [index, text] of prefixedSecretAssignments.entries())
      yield* f.fs.writeFileString(f.repo + `/settings-${index}.txt`, text);
    yield* f.git(["add", "."]);
    yield* f.git(["commit", "-m", "synthetic prefixed assignments"]);
    const before = yield* f.state;
    for (const [index] of prefixedSecretAssignments.entries())
      for (const tool of ["goat_thread_launch", "goat_ssh_thread_launch"]) {
        const result = yield* f.call(tool, {
          title: "Must not launch",
          ...(tool === "goat_ssh_thread_launch" ? { host: "worker", cwd: "/worker" } : {}),
          references: [{ ...f.source, host: null, files: ["source.ts", `settings-${index}.txt`] }],
        });
        expect(result.isError).toBe(true);
        const output = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        expect(output).toContain("credential_content");
        expect(output).not.toContain("fixture-only-value");
        expect(output).not.toContain("export const result");
      }
    expect(f.launched).toEqual([]);
    expect(yield* f.state).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "actual read-only MCP reads committed text and rejects write/root/traversal attempts without touching source",
  () =>
    Effect.gen(function* () {
      const f = yield* toolkitFixture;
      const before = yield* f.state;
      const read = yield* f.call("goat_repository_snapshot", f.source, scope("read-only"));
      expect(read.isError).not.toBe(true);
      const text = read.content.find((item) => item.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type === "text")
        expect(decodeJson(text.text)).toMatchObject({
          files: [{ path: "source.ts", text: "export const result = 42;\n" }],
        });
      for (const request of [
        { ...f.source, operation: "write", content: "overwrite" },
        { ...f.source, patch: "overwrite" },
        { ...f.source, mode: "read-only-root", root: f.repo },
        { ...f.source, files: ["../outside.txt"] },
        { ...f.source, files: [".git/config"] },
      ])
        expect((yield* f.call("goat_repository_snapshot", request)).isError).toBe(true);
      expect(
        (yield* f.call(
          "goat_repository_snapshot",
          { ...f.source, host: "other" },
          scope("read-only"),
        )).isError,
      ).toBe(true);
      expect(yield* f.state).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "a launch delivers usable bounded snapshots to the worker without source paths or write grants",
  () =>
    Effect.gen(function* () {
      const f = yield* toolkitFixture;
      const before = yield* f.state;
      const result = yield* f.call("goat_thread_launch", {
        title: "Use sibling",
        message: "Review the sibling result",
        references: [f.source, { ...f.source, files: ["source.ts", "source.ts"] }],
      });
      expect(result.isError).not.toBe(true);
      expect(f.launched).toHaveLength(1);
      const brief = f.launched[0]!.message!;
      const snapshots = decodeSnapshots(brief.slice(brief.indexOf("\n[{") + 1));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.files).toHaveLength(1);
      expect(snapshots[0]?.files[0]?.text).toBe("export const result = 42;\n");
      expect(brief).not.toContain(f.repo);
      expect(brief).not.toContain("fixture-password");
      expect(yield* f.state).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live("a missing or newly unregistered source prevents launching a worker", () =>
  Effect.gen(function* () {
    const f = yield* toolkitFixture;
    f.unregister();
    const result = yield* f.call("goat_thread_launch", {
      title: "No source",
      references: [f.source],
    });
    expect(result.isError).toBe(true);
    expect(f.launched).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "unavailable remote references fail closed before launching and do not broaden authority",
  () =>
    Effect.gen(function* () {
      const f = yield* toolkitFixture;
      const result = yield* f.call("goat_thread_launch", {
        title: "Missing source",
        references: [{ ...f.source, host: "unavailable" }],
      });
      expect(result.isError).toBe(true);
      expect(f.launched).toEqual([]);
      expect(f.commands).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "metadata-only or non-reauthorizable credentials cannot gain repository content access",
  () =>
    Effect.gen(function* () {
      const f = yield* toolkitFixture;
      const { reauthorize: _reauthorize, ...unverifiable } = scope();
      for (const caller of [
        { ...scope("read-only"), grantedScopes: ["orchestration:read"] as const },
        unverifiable,
      ]) {
        expect((yield* f.call("goat_repository_snapshot", f.source, caller)).isError).toBe(true);
      }
      expect(f.commands).toEqual([]);
      const required: Array<ReadonlyArray<string>> = [];
      const full = {
        ...scope(),
        grantedScopes: [
          "orchestration:read",
          "orchestration:operate",
          "source-control:write",
        ] as const,
        reauthorize: (scopes: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>) =>
          Effect.sync(() => {
            required.push(scopes);
          }),
      };
      expect((yield* f.call("goat_repository_snapshot", f.source, full)).isError).not.toBe(true);
      expect(required).toEqual([
        ["orchestration:read", "orchestration:operate", "source-control:write"],
        ["orchestration:read", "orchestration:operate", "source-control:write"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live("MCP launch rejects nested unsupported grants before capturing or launching", () =>
  Effect.gen(function* () {
    const f = yield* toolkitFixture;
    for (const extra of [
      { roots: [f.root] },
      { access: "read-write" },
      { write: { path: "source.ts", text: "overwrite" } },
    ]) {
      expect(
        (yield* f.call("goat_thread_launch", {
          title: "Invalid grant",
          references: [{ ...f.source, ...extra }],
        })).isError,
      ).toBe(true);
    }
    expect(f.launched).toEqual([]);
    expect(f.commands).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live("credential content fails before worker launch", () =>
  Effect.gen(function* () {
    const f = yield* toolkitFixture;
    yield* f.fs.writeFileString(f.repo + "/settings.ini", "password = exampleSecret123\n");
    yield* f.git(["add", "settings.ini"]);
    yield* f.git(["commit", "-m", "synthetic sensitive assignment"]);
    const result = yield* f.call("goat_thread_launch", {
      title: "Blocked content",
      references: [{ ...f.source, files: ["settings.ini"] }],
    });
    expect(result.isError).toBe(true);
    expect(f.launched).toEqual([]);
    for (const item of result.content)
      if (item.type === "text") expect(item.text).not.toContain("exampleSecret123");
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "remote reads keep caller scope, require ready hosts, validate exact content and honor revocation",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      const good = yield* f.capture();
      const caller = scope();
      const reads: Array<Parameters<HostThreads.HostThreadsMcpServiceShape["readOnHost"]>[1]> = [];
      const run = (
        answer: unknown,
        input: RepositoryReferenceRequest = { ...f.source, host: "source-host" },
        invocation = caller,
      ) =>
        ReferenceMcp.RepositoryReferenceMcpService.pipe(
          Effect.flatMap((service) => service.read(invocation, input)),
          Effect.provide(
            ReferenceMcp.layer.pipe(
              Layer.provide(f.layer),
              Layer.provide(liveThreadsLayer),
              Layer.provide(
                Layer.mock(HostThreads.HostThreadsMcpService)({
                  readOnHost: (received, request, decode) => {
                    expect(received).toBe(invocation);
                    reads.push(request);
                    return decode(answer).pipe(
                      Effect.map((value) => ({ ...value, host: request.host })),
                      Effect.mapError(
                        () =>
                          new OrchestratorMcpFailure({
                            code: "orchestration_error",
                            message: "invalid remote snapshot",
                          }),
                      ),
                    );
                  },
                }),
              ),
            ),
          ),
        );
      expect((yield* run(good)).files[0]?.text).toBe(good.files[0]?.text);
      expect(reads[0]).toMatchObject({
        tool: "goat_repository_snapshot",
        host: "source-host",
        requireReady: true,
        arguments: f.source,
      });
      for (const invalid of [
        { ...good, repositoryKey: "invalid.example/other/repo" },
        { ...good, files: [{ ...good.files[0]!, path: "extra.ts" }] },
        { ...good, files: [...good.files, ...good.files] },
        ...[
          "https://user:password@example.test/private",
          "password = exampleSecret123",
          "api_key: exampleSecret123",
          ...prefixedSecretAssignments,
        ].map((text) => ({
          ...good,
          files: [{ ...good.files[0]!, text }],
          totalBytes: text.length,
        })),
        { ...good, totalBytes: good.totalBytes + 1 },
      ])
        expect((yield* run(invalid).pipe(Effect.result))._tag).toBe("Failure");
      let checks = 0;
      const revoked = {
        ...caller,
        reauthorize: () =>
          ++checks === 1
            ? Effect.void
            : Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "revoked",
                  requiredScope: "orchestration:read",
                }),
              ),
      };
      expect(
        (yield* run(good, { ...f.source, host: "source-host" }, revoked).pipe(Effect.flip)).code,
      ).toBe("capability_denied");
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.live(
  "SSH briefs resolve omitted source hosts on the destination and explicit null locally",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      const snapshot = yield* f.capture();
      const hosts: Array<string> = [];
      const layer = ReferenceMcp.layer.pipe(
        Layer.provide(f.layer),
        Layer.provide(liveThreadsLayer),
        Layer.provide(
          Layer.mock(HostThreads.HostThreadsMcpService)({
            readOnHost: (_scope, request, decode) => {
              hosts.push(request.host);
              return decode(snapshot).pipe(
                Effect.map((value) => ({ ...value, host: request.host })),
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "invalid remote snapshot",
                    }),
                ),
              );
            },
          }),
        ),
      );
      yield* ReferenceMcp.RepositoryReferenceMcpService.pipe(
        Effect.flatMap((service) =>
          service.prepareBrief(scope(), {
            defaultHost: "worker-host",
            references: [f.source, { ...f.source, host: null }],
          }),
        ),
        Effect.provide(layer),
      );
      expect(hosts).toEqual(["worker-host"]);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);
