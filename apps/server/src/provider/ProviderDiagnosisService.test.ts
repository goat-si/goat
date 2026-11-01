import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
import * as Diagnosis from "./ProviderDiagnosisService.ts";
import * as RegistryMock from "./testUtils/providerRegistryMock.ts";

const decodeProject = Schema.decodeUnknownSync(ProjectStore.ProjectRow);

it.effect("diagnoses project-disabled instances before automatic placement can select them", () => {
  const projectId = ProjectId.make("project:placement");
  const primary = ProviderInstanceId.make("grok");
  const alternate = ProviderInstanceId.make("grok-work");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [primary]: { driver: ProviderDriverKind.make("grok"), config: {}, enabled: true },
      [alternate]: { driver: ProviderDriverKind.make("grok"), config: {}, enabled: true },
    },
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { [primary]: { enabled: false } } },
    },
  };
  const snapshots: ServerProvider[] = [primary, alternate].map((instanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }));
  const project = decodeProject({
    projectId,
    title: "Fixture",
    workspaceRoot: "/fixture/repo",
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    deletedAt: null,
  });
  return Effect.gen(function* () {
    const diagnosis = yield* Diagnosis.ProviderDiagnosisService;
    const result = yield* diagnosis.diagnose({
      cwd: "/fixture/repo",
      driver: ProviderDriverKind.make("grok"),
    });
    expect(result.diagnoses.map((entry) => [entry.instanceId, entry.ready])).toEqual([
      [primary, false],
      [alternate, true],
    ]);
    expect(result.diagnoses[0]?.checks).toContainEqual({
      id: "project_provider",
      status: "fail",
      summary: "Provider is disabled for this project.",
      reason: "disabled",
    });
    const unknown = yield* diagnosis.diagnose({
      cwd: "/unregistered",
      driver: ProviderDriverKind.make("grok"),
    });
    expect(
      unknown.diagnoses[0]?.checks.find((check) => check.id === "project_provider")?.status,
    ).toBe("unknown");
  }).pipe(
    Effect.provide(
      Diagnosis.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            RegistryMock.layer(snapshots),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              findActiveByWorkspaceRoot: (cwd) =>
                Effect.succeed(
                  cwd === project.workspaceRoot ? Option.some(project) : Option.none(),
                ),
            }),
            Layer.mock(HomeRoute.OpenCodexRoute)({}),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
            Layer.mock(ProviderHost.ProviderHost)({
              paths: {
                cwd: "/fixture",
                baseDir: "/fixture",
                stateDir: "/fixture/userdata",
                providerStatusCacheDir: "/fixture/cache",
                attachmentsDir: "/fixture/attachments",
              },
              resolveAttachmentPath: () => null,
              settings: {
                get: Effect.succeed(settings),
                withSnapshot: (use) => use(settings),
                changes: Stream.empty,
                subscribe: Effect.succeed(Stream.empty),
              },
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );
});
