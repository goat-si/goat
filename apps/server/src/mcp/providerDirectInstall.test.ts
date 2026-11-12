import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  type HubNode,
  type RuntimeMode,
  ThreadId,
  type ProviderInteractionMode,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as HubNodes from "../hubNodes/HubNodes.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { threadScope } from "../provider/ProviderHostSync.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { directInstallCheck } from "./providerDirectInstall.ts";

const threadId = ThreadId.make("agent-thread");
const node = (target: HubNode["routes"][number]["target"]) =>
  ({ routes: [{ target }] }) as unknown as HubNode;

const fixture = (options: {
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly goatclaw?: { readonly profile: string; readonly hosts?: ReadonlyArray<string> };
}) =>
  Effect.gen(function* () {
    const modes = yield* Ref.make({
      runtimeMode: options.runtimeMode ?? "full-access",
      interactionMode: options.interactionMode ?? "default",
    });
    const nodes = yield* Ref.make<ReadonlyArray<HubNode>>([
      node({ kind: "ssh", alias: "pen-vm1", hostname: null, username: null, port: null }),
      node({ kind: "cloud", alias: "boat-1" as never }),
    ]);
    const settings = ServerSettings.layerTest(
      options.goatclaw === undefined
        ? {}
        : {
            goatclaw: {
              enabled: true,
              defaultProfile: options.goatclaw.profile,
              profiles: {
                [options.goatclaw.profile]: {
                  ...BUILTIN_PERMISSION_PROFILES[options.goatclaw.profile]!,
                  ...(options.goatclaw.hosts === undefined
                    ? {}
                    : { hosts: options.goatclaw.hosts }),
                },
              },
            },
          },
    );
    const layer = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        ...threadScope,
        thread: { ...threadScope.thread!, threadId },
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(modes).pipe(Effect.map((current) => liveThreadShell(threadId, current))),
      }),
      // Only the snapshot is read; add has generic parameters a partial mock cannot type.
      Layer.succeed(HubNodes.HubNodes, {
        snapshot: Ref.get(nodes).pipe(
          Effect.map((current) => ({
            hubEnvironmentId: "hub" as never,
            nodes: current,
            notices: [],
          })),
        ),
      } as unknown as HubNodes.HubNodes["Service"]),
      Profiles.layer.pipe(Layer.provide(settings)),
    );
    return { modes, nodes, layer };
  });

it.effect("a full-access thread installs without a card on machines saved here", () =>
  Effect.gen(function* () {
    const f = yield* fixture({});
    const check = yield* directInstallCheck({ hosts: ["pen-vm1", "boat-1"], login: false }).pipe(
      Effect.provide(f.layer),
    );
    expect(check).toBeDefined();
    // This machine needs the same thread, and no catalog entry.
    expect(yield* directInstallCheck({ login: false }).pipe(Effect.provide(f.layer))).toBeDefined();
  }),
);

it.effect.each([
  {
    name: "an approval-required thread",
    fixture: { runtimeMode: "approval-required" as const },
    input: {},
  },
  { name: "an auto thread", fixture: { runtimeMode: "auto" as const }, input: {} },
  { name: "a thread in plan mode", fixture: { interactionMode: "plan" as const }, input: {} },
  { name: "a request that also signs in", fixture: {}, input: { login: true } },
  { name: "a request that leaves login to its default", fixture: {}, input: { login: undefined } },
  { name: "an alias only in SSH config", fixture: {}, input: { hosts: ["box"] } },
  {
    name: "a profile without threads.launch",
    fixture: { goatclaw: { profile: "observer" } },
    input: {},
  },
  {
    name: "a profile whose hosts leave this one out",
    fixture: { goatclaw: { profile: "owner", hosts: ["other"] } },
    input: {},
  },
])("$name still asks a person", ({ fixture: options, input }) =>
  Effect.gen(function* () {
    const f = yield* fixture(options);
    const check = yield* directInstallCheck({ hosts: ["pen-vm1"], login: false, ...input }).pipe(
      Effect.provide(f.layer),
    );
    expect(check).toBeUndefined();
  }),
);

it.effect("the check refuses once the thread drops to approvals or the machine is removed", () =>
  Effect.gen(function* () {
    const f = yield* fixture({});
    const check = (yield* directInstallCheck({ hosts: ["pen-vm1"], login: false }).pipe(
      Effect.provide(f.layer),
    ))!;
    yield* check;
    yield* Ref.update(f.modes, (current) => ({
      ...current,
      runtimeMode: "approval-required" as const,
    }));
    expect((yield* Effect.flip(check))._tag).toBe("EnvironmentAuthorizationError");
    yield* Ref.update(f.modes, (current) => ({ ...current, runtimeMode: "full-access" as const }));
    yield* check;
    yield* Ref.set(f.nodes, []);
    expect((yield* Effect.flip(check)).message).toBe(
      "pen-vm1 is not a machine saved in this server's connections.",
    );
  }),
);
