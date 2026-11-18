import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useThreadTranscriptSkills } from "./use-thread-transcript-skills";

const fixture = vi.hoisted(() => ({ scan: vi.fn() }));

vi.mock("../../state/provider-workspace-snapshot-refresh", async () => {
  const { createProviderWorkspaceSnapshotRefreshAtomFamily } =
    await import("@goat/client-runtime/providerSkills");
  return {
    providerWorkspaceSnapshotRefresh: createProviderWorkspaceSnapshotRefreshAtomFamily({
      providers: () => providersAtom,
      refreshProviders: {
        label: "load workspace skills",
        run: async (registry) => {
          const providers: ReadonlyArray<ServerProvider> = await fixture.scan();
          registry.set(providersAtom, providers);
          return AsyncResult.success({ providers });
        },
      },
    }),
  };
});

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const cwd = "/checkout";
const skillPath = "/checkout/.agents/skills/review/SKILL.md";
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  catalogDigest: "A",
} as const satisfies ServerProvider;
const providersAtom = Atom.make<ReadonlyArray<ServerProvider>>([provider]);

function Transcript({
  connected,
  withoutComposer,
}: {
  readonly connected: boolean;
  readonly withoutComposer: boolean;
}) {
  const providers = useAtomValue(providersAtom);
  const skills = useThreadTranscriptSkills(
    {
      environmentId,
      connectionStateLabel: connected ? "connected" : "offline",
      selectedThread: {
        modelSelection: { instanceId },
        projectId: ProjectId.make("project"),
      },
      threadCwd: cwd,
      projectWorkspaceRoot: "/project",
      serverConfig: { providers },
    },
    withoutComposer,
  );
  return (
    <>
      {skills.map((skill) => (
        <a key={skill.path} href={skill.path}>
          {skill.name}
        </a>
      ))}
    </>
  );
}

it("restores a project skill link in a cold connected transcript without a composer", async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const element = document.createElement("div");
  const root = createRoot(element);
  const reply = Promise.withResolvers<ReadonlyArray<ServerProvider>>();
  fixture.scan.mockReset().mockReturnValue(reply.promise);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Transcript connected withoutComposer />
        </RegistryContext.Provider>,
      ),
    );
    expect(element.textContent).toBe("");
    await act(async () => {
      reply.resolve([
        {
          ...provider,
          workspaceSnapshots: [
            {
              cwd,
              checkedAt: "2026-01-01T00:00:01.000Z",
              slashCommands: [],
              skills: [{ name: "review", path: skillPath, enabled: true }],
            },
          ],
        },
      ]);
    });
    expect(element.querySelector(`a[href="${skillPath}"]`)?.textContent).toBe("review");
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    if (previousAct === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
