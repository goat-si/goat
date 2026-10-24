import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { TestClock } from "effect/testing";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { liveThreadsLayer, layerPermissionProfilesOff } from "../mcp/McpToolAccess.testkit.ts";
import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as Routing from "../provider/ProviderDiagnosisRouting.ts";
import * as HostSync from "../provider/ProviderHostSync.ts";
import * as Onboarding from "../provider/ProviderOnboarding.ts";
import * as ProviderSettingsService from "../provider/ProviderSettings.ts";
import { ProviderToolkit } from "../mcp/toolkits/provider/tools.ts";
import * as ProviderHandlers from "../mcp/toolkits/provider/handlers.ts";
import * as CloudAgents from "./CloudAgentService.ts";
import {
  SECRET,
  projectId,
  agent,
  scope,
  makeWorld,
  storeCloudThread,
  layerFor,
  run,
  full,
} from "./CloudAgentService.testkit.ts";

it.effect("probes holders once a minute, falls back for old runtimes, and drops gone hosts", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.hosts.push("new", "old", "down");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const first = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          first.holders.map((holder) => [holder.host, holder.ready, holder.runtime]),
          [
            [null, true, "current"],
            ["down", false, "unreachable"],
            ["new", true, "current"],
            ["old", true, "update_required"],
          ],
        );
        assert.equal(first.holders[0]?.accountLabel, "Jun");
        assert.equal(first.holders[2]?.activeRuns, 3);
        assert.equal(
          world.matrixCalls.every((call) => call.localOnly === true && call.cloud === true),
          true,
        );
        assert.equal(
          world.hostReads
            .filter((read) => read.tool === "goat_provider_host_matrix")
            .every((read) => read.arguments.localOnly === true && read.arguments.cloud === true),
          true,
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "old").map((read) => read.tool),
          ["goat_provider_host_matrix", "goat_cloud_holders", "goat_provider_diagnose"],
        );
        const reads = world.hostReads.length;
        yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        // Only the unreachable host is asked again within the minute.
        assert.deepEqual(world.hostReads.slice(reads), [
          {
            host: "down",
            tool: "goat_provider_host_matrix",
            arguments: { localOnly: true, cloud: true },
          },
        ]);
        yield* TestClock.adjust("61 seconds");
        yield* service.holders(scope("full-access"), { provider: "cursorCloud", refresh: true });
        world.hosts.splice(0, world.hosts.length);
        const alone = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          alone.holders.map((holder) => holder.host),
          [null],
        );
      }),
    );
  }),
);

it.effect("routes through the matrix cloud column and falls back when a host omits it", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.readyDrivers.clear();
    world.hosts.push("new", "aged");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const table = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          table.holders.map((holder) => [
            holder.host,
            holder.ready,
            holder.runtime,
            holder.activeRuns,
          ]),
          [
            [null, false, "current", undefined],
            ["aged", true, "current", 0],
            ["new", true, "current", 3],
          ],
        );
        assert.equal(
          world.matrixCalls.every((call) => call.localOnly === true && call.cloud === true),
          true,
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "aged").map((read) => read.tool),
          ["goat_provider_host_matrix", "goat_cloud_holders"],
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "new").map((read) => read.tool),
          ["goat_provider_host_matrix"],
        );
        const dry = yield* service.launch(
          scope("full-access"),
          { provider: "cursorCloud", repo: "goat-si/goat", prompt: "Fix the flake", dryRun: true },
          full,
        );
        assert.equal(dry.holder.host, "aged");
        assert.equal(world.launches.length, 0);
      }),
    );
  }),
);

it.effect(
  "reports this environment not ready when its matrix fails, and an unreadable host as unreachable",
  () =>
    Effect.gen(function* () {
      const denied = makeWorld();
      denied.matrixFailure = "auth";
      yield* run(
        denied,
        Effect.gen(function* () {
          const service = yield* CloudAgents.CloudAgentService;
          const error = yield* service
            .holders(scope("full-access"), { local: true })
            .pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
        }),
      );
      const broken = makeWorld();
      broken.matrixFailure = "settings";
      broken.hosts.push("garbled");
      yield* run(
        broken,
        Effect.gen(function* () {
          const service = yield* CloudAgents.CloudAgentService;
          const holders = yield* service.holders(scope("full-access"), {});
          assert.deepEqual(
            holders.holders.map((holder) => [
              holder.host,
              holder.ready,
              holder.runtime,
              holder.reason,
            ]),
            [
              [null, false, "current", "Could not read this environment's provider settings."],
              [null, false, "current", "Could not read this environment's provider settings."],
              [null, false, "current", "Could not read this environment's provider settings."],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
            ],
          );
          assert.deepEqual(broken.hostReads, [
            {
              host: "garbled",
              tool: "goat_provider_host_matrix",
              arguments: { localOnly: true, cloud: true },
            },
          ]);
        }),
      );
    }),
);

it.effect("a Claude Cloud dry run says folder trust is accepted automatically", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.readyDrivers.add("claudeCloud");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const input = { repo: "goat-si/goat", prompt: "Probe", dryRun: true } as const;
        const claude = yield* service.launch(
          scope("full-access"),
          { ...input, provider: "claudeCloud" },
          full,
        );
        const cursor = yield* service.launch(
          scope("full-access"),
          { ...input, provider: "cursorCloud" },
          full,
        );
        assert.deepEqual(
          [claude.dryRun, claude.holder.ready, claude.note, cursor.note],
          [true, true, CloudAgents.CLAUDE_TRUST_NOTE, undefined],
        );
        assert.equal(world.launches.length, 0);
      }),
    );
  }),
);

it.effect("launches on the chosen holder: dry run, a preferred host, and this environment", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.hosts.push("new", "old");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const input = {
          provider: "cursorCloud",
          repo: "goat-si/goat",
          prompt: "Fix the flake",
        } as const;
        const dry = yield* service.launch(scope("full-access"), { ...input, dryRun: true }, full);
        assert.deepEqual([dry.dryRun, dry.holder.host], [true, null]);
        assert.equal(world.launches.length, 0);
        const refused = yield* service
          .launch(scope("full-access"), { ...input, holder: "old" }, full)
          .pipe(Effect.flip);
        assert.match(refused.message, /^Update GOAT on old/u);
        const remote = yield* service.launch(
          scope("full-access"),
          { ...input, holder: "new" },
          full,
        );
        assert.equal(remote.holder.host, "new");
        assert.deepEqual(world.hostWrites, [
          { host: "new", tool: "goat_cloud_launch", arguments: { ...input, holder: "local" } },
        ]);
        const local = yield* service.launch(scope("full-access"), input, full);
        assert.equal(local.holder.host, null);
        assert.deepEqual(world.launches[0]?.input, {
          projectId,
          title: "Cursor Cloud: Fix the flake",
          modelSelection: { instanceId: "cursorCloud", model: "composer-2" },
          workspaceStrategy: { type: "root" },
          message: "Fix the flake",
          standingInstructions: false,
        });
        const outdated = yield* service
          .launch(scope("full-access"), { ...input, provider: "claudeCloud" }, full)
          .pipe(Effect.flip);
        assert.match(outdated.message, /exist on old, but GOAT there is too old/u);
        world.hosts.splice(0, world.hosts.length);
        const noLogin = yield* service
          .launch(scope("full-access"), { ...input, provider: "claudeCloud" }, full)
          .pipe(Effect.flip);
        assert.match(noLogin.message, /No connected host holds a Claude Cloud login/u);
      }),
    );
  }),
);

it.effect("finds a registered project whose identity cache is cold, with or without a branch", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.coldIdentity = true;
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const input = { provider: "cursorCloud", repo: "goat-si/goat", prompt: "Probe" } as const;
        const withBranch = yield* service.launch(
          scope("full-access"),
          { ...input, branch: "dev" },
          full,
        );
        const without = yield* service.launch(scope("full-access"), input, full);
        assert.deepEqual(
          [withBranch.holder.host, without.holder.host, world.identityLookups],
          [null, null, ["/fixture/goat", "/fixture/goat"]],
        );
        assert.deepEqual(
          world.launches.map((launch) => launch.input.workspaceStrategy),
          [{ type: "root", branch: "dev" }, { type: "root" }],
        );
        assert.match(withBranch.note ?? "", /from dev;/u);
      }),
    );
  }),
);

it.effect("registers outside runs: validated, deduplicated, followed or link-only", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const base = { repo: "goat-si/goat", launchedBy: "Grok Bot" } as const;
        const bad = yield* service
          .register(
            scope("full-access"),
            { ...base, provider: "cursorCloud", url: "https://169.254.169.254/agents/bc-12345678" },
            full,
          )
          .pipe(Effect.flip);
        assert.equal(bad.code, "invalid_request");
        assert.equal(world.launches.length, 0);

        const followed = yield* service.register(
          scope("full-access"),
          { ...base, provider: "cursorCloud", externalId: agent, notifyWebhook: true },
          full,
        );
        assert.deepEqual([followed.created, followed.tracking], [true, "polled"]);
        assert.equal(followed.url, `https://cursor.com/agents/${agent}`);
        const launch = world.launches[0]!;
        assert.equal(launch.input.notifyWebhook, true);
        assert.equal(launch.cloudRun?.externalLauncher, "Grok Bot");
        assert.equal(launch.cloudRun?.importedNativeThread?.cloudTask?.attach, "registered");

        const again = yield* service.register(
          scope("full-access"),
          { ...base, provider: "cursorCloud", url: `https://cursor.com/agents/${agent}` },
          full,
        );
        assert.deepEqual([again.created, again.threadId], [false, followed.threadId]);
        assert.equal(world.launches.length, 1);

        const devin = yield* service.register(
          scope("full-access"),
          { ...base, provider: "devinCloud", externalId: "abc123def456" },
          full,
        );
        assert.equal(devin.tracking, "link-only");
        assert.isUndefined(world.launches[1]?.input.message);

        const claude = yield* service.register(
          scope("full-access"),
          { ...base, provider: "claudeCloud", externalId: "session_ABCdef123" },
          full,
        );
        assert.equal(claude.tracking, "link-only");
        assert.match(claude.note ?? "", /Not signed in/u);

        const listed = yield* service.list({});
        assert.deepEqual(
          listed.runs
            .map((entry) => [entry.provider, entry.tracking, entry.launchedBy, entry.registered])
            .toSorted(),
          [
            ["claudeCloud", "link-only", "Grok Bot", true],
            ["cursorCloud", "polled", "Grok Bot", true],
            ["devinCloud", "link-only", "Grok Bot", true],
          ],
        );
        assert.notInclude(JSON.stringify([followed, again, devin, claude, listed]), SECRET);

        // The caller's modes dropped while it waited: nothing starts.
        const downgraded = yield* service
          .register(
            scope("full-access"),
            { ...base, provider: "cursorCloud", externalId: "bc-0a1b2c3d4e5f6a7b" },
            Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: "Now plan mode." }),
            ),
          )
          .pipe(Effect.flip);
        assert.equal(downgraded.code, "capability_denied");
        assert.equal(world.launches.length, 3);
      }),
    );
  }),
);

it.effect("forgets only registered runs, by deleting their thread", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const registered = yield* service.register(
          scope("full-access"),
          {
            provider: "devinCloud",
            externalId: "abc123def456",
            repo: "goat-si/goat",
            launchedBy: "GOAT Bot",
          },
          full,
        );
        const own = ThreadId.make("thread:goat-launched");
        yield* storeCloudThread({
          threadId: own,
          title: "Launched here",
          driver: "cursorCloud",
          nativeId: agent,
          cloudTask: {
            taskId: "run-1",
            status: "running",
            tracking: "live",
            source: { repository: "https://github.com/goat-si/goat", branch: "dev" },
            localChangesExcluded: true,
            updatedAt: "2026-10-20T00:00:00.000Z",
          },
          active: true,
        });
        const refused = yield* service.forget({ threadId: own }).pipe(Effect.flip);
        assert.equal(refused.code, "invalid_request");
        assert.deepEqual(yield* service.forget({ threadId: registered.threadId }), {
          threadId: registered.threadId,
          forgotten: true,
        });
        assert.deepEqual(
          world.dispatched.map((command) => (command as { type: string; threadId: string }).type),
          ["thread.delete"],
        );
        assert.deepEqual(yield* service.forget({ threadId: ThreadId.make("thread:none") }), {
          threadId: ThreadId.make("thread:none"),
          forgotten: false,
        });
      }),
    );
  }),
);

const cloudRun = (
  threadId: string,
  driver: "claudeCloud" | "cursorCloud" | "devinCloud",
  attach?: "registered",
) =>
  storeCloudThread({
    threadId: ThreadId.make(threadId),
    title: threadId,
    driver,
    nativeId: `native-${threadId}`,
    cloudTask: {
      taskId: `task-${threadId}`,
      status: "running",
      tracking: "link-only",
      ...(attach === undefined ? {} : { attach }),
      source: { repository: "https://github.com/goat-si/goat", branch: "dev" },
      localChangesExcluded: true,
      updatedAt: "2026-10-20T00:00:00.000Z",
    },
    active: false,
  }).pipe(Effect.andThen(TestClock.adjust("1 second")));

it.effect("lists a provider's run that sits behind newer runs of another provider", () =>
  Effect.gen(function* () {
    yield* run(
      makeWorld(),
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        yield* cloudRun("thread:claude-old", "claudeCloud");
        yield* cloudRun("thread:cursor-new", "cursorCloud");
        yield* cloudRun("thread:cursor-newest", "cursorCloud");

        const claude = yield* service.list({ provider: "claudeCloud", limit: 1 });
        assert.deepEqual(
          [claude.runs.map((entry) => entry.threadId), claude.truncated],
          [["thread:claude-old"], false],
        );
        const newest = yield* service.list({ limit: 2 });
        assert.deepEqual(
          [newest.runs.map((entry) => entry.threadId), newest.truncated],
          [["thread:cursor-newest", "thread:cursor-new"], true],
        );
        const everything = yield* service.list({ limit: 3 });
        assert.deepEqual([everything.runs.length, everything.truncated], [3, false]);
      }),
    );
  }),
);

it.effect("forgets a registered run that has more than 200 newer runs ahead of it", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const old = ThreadId.make("thread:registered-old");
        yield* cloudRun(old, "devinCloud", "registered");
        yield* Effect.forEach(
          Array.from({ length: 201 }, (_, index) => index),
          (index) => cloudRun(`thread:newer-${index}`, "cursorCloud"),
        );

        assert.deepEqual(yield* service.forget({ threadId: old }), {
          threadId: old,
          forgotten: true,
        });
        assert.deepEqual(
          world.dispatched.map((command) => {
            const { type, threadId } = command as { type: string; threadId: string };
            return [type, threadId];
          }),
          [["thread.delete", old]],
        );
      }),
    );
  }),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-agents", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-agents", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("MCP writes need a full-access caller; reads and dry runs answer without secrets", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const registered = McpHttpServer.toolkitRegistration(
      ProviderToolkit,
      ProviderHandlers.layer,
    ).pipe(
      Layer.provide(layerPermissionProfilesOff),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(liveThreadsLayer),
      Layer.provide(Layer.mock(HomeRequests.CodexHomeRequests)({})),
      Layer.provide(Layer.mock(Routing.ProviderDiagnosisRouting)({})),
      Layer.provide(Layer.mock(HostSync.ProviderHostSync)({})),
      Layer.provide(Layer.mock(Onboarding.ProviderOnboarding)({})),
      Layer.provide(
        Layer.mock(ProviderSettingsService.ProviderSettings)({
          presentDiagnosis: (result) => Effect.succeed(result),
        }),
      ),
      Layer.provide(layerFor(world)),
    );
    const call = (
      access: "read-only" | "approval-required" | "full-access",
      name: string,
      args: object,
    ) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name, arguments: args })),
        Effect.provideService(Invocation.McpInvocationContext, scope(access)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    yield* Effect.gen(function* () {
      const writes = [
        ["goat_cloud_agent_launch", { provider: "cursorCloud", repo: "goat-si/goat", prompt: "x" }],
        [
          "goat_cloud_agent_run_register",
          {
            provider: "devinCloud",
            externalId: "abc123def456",
            repo: "goat-si/goat",
            launchedBy: "Bot",
          },
        ],
        ["goat_cloud_agent_run_forget", { threadId: "thread:any" }],
      ] as const;
      for (const access of ["read-only", "approval-required"] as const) {
        for (const [name, args] of writes) {
          const result = yield* call(access, name, args);
          assert.isTrue(result.isError, `${access} ${name}`);
          assert.include(JSON.stringify(result.content), "capability_denied");
        }
      }
      assert.equal(world.launches.length, 0);
      const outputs = [
        yield* call("read-only", "goat_cloud_agent_holders", { local: true }),
        yield* call("read-only", "goat_cloud_agent_run_list", {}),
        yield* call("full-access", "goat_cloud_agent_launch", {
          provider: "cursorCloud",
          repo: "goat-si/goat",
          prompt: "x",
          dryRun: true,
        }),
      ];
      for (const output of outputs) assert.isFalse(output.isError);
      const text = JSON.stringify(outputs);
      assert.notInclude(text, SECRET);
      assert.notMatch(
        text,
        /sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|"(?:apiKey|token|password)"/u,
      );
    }).pipe(Effect.provide(registered));
  }),
);

it.effect.each(["worker", "manager", "owner"])(
  "cloud launch checks profile %s before choosing or launching a holder",
  (profile) => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* CloudAgents.CloudAgentService;
      const sql = yield* SqlClient.SqlClient;
      const input = {
        provider: "cursorCloud",
        repo: "goat-si/goat",
        prompt: "Inspect",
        holder: "local",
      } as const;
      // A decision this caller filed itself approves no launch, even once a person answers it.
      yield* sql`INSERT INTO decision_items (id, title, context, options_json, required_profile, status, answer, answered_by, created_at, updated_at)
        VALUES ('go', 'Launch?', '', '[]', 'owner', 'answered', 'approve', 'client:phone', '2026-10-21', '2026-10-21')`;
      let decisionId = "go";
      if (profile === "owner") {
        const unapproved = yield* service
          .launch(scope("full-access"), input, full)
          .pipe(Effect.flip);
        assert.include(unapproved.message, "bills a paid account");
        assert.equal(world.launches.length, 0);
        // A person approves the decision GOAT filed for exactly this launch.
        decisionId = /decision (decision:\S+) for/.exec(unapproved.message)![1]!;
        yield* sql`UPDATE decision_items SET status = 'answered', answer = 'approve',
          answered_by = 'client:phone' WHERE id = ${decisionId}`;
        // The approval covers the branch checked out when GOAT asked, not whatever is there later.
        world.checkedOut = "feature";
        const moved = yield* service
          .launch(scope("full-access"), { ...input, decisionId }, full)
          .pipe(Effect.flip);
        assert.include(moved.message, "was not filed by GOAT for this launch");
        world.checkedOut = "main";
      }
      const result = yield* service
        .launch(scope("full-access"), { ...input, decisionId }, full)
        .pipe(Effect.result);
      if (profile === "owner") {
        assert.equal(result._tag, "Success");
        assert.deepEqual(
          world.launches.map((l) => l.input["workspaceStrategy"]),
          [{ type: "root", branch: "main" }],
        );
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "capability_denied");
        assert.equal(world.launches.length, 0);
        assert.equal(world.hostWrites.length, 0);
      }
    }).pipe(Effect.provide(layerFor(world, profile)));
  },
);

it.effect(
  "refuses an enabled remote cloud holder before forwarding outside the lane ledger",
  () => {
    const world = makeWorld();
    world.hosts.push("new");
    return Effect.gen(function* () {
      const service = yield* CloudAgents.CloudAgentService;
      const error = yield* service
        .launch(
          scope("full-access"),
          { provider: "cursorCloud", repo: "goat-si/goat", prompt: "Inspect", holder: "new" },
          full,
        )
        .pipe(Effect.flip);
      assert.equal(error.code, "capability_denied");
      assert.equal(world.hostWrites.length, 0);
      assert.equal(world.launches.length, 0);
    }).pipe(Effect.provide(layerFor(world, "owner")));
  },
);
