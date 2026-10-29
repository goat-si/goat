// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@goat/contracts";
import { AcpRegistrySettings } from "@goat/provider-acp-registry/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AcpSessionService from "./AcpSessionService.ts";
import { catalog as mcpCatalog, client, dependencies } from "../mcp/agentSurface.testkit.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
} from "@goat/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";

const instanceId = ProviderInstanceId.make("acpRegistry_codex");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const sessionListCatalog = (count: number, scenario?: string) =>
  AcpRegistrySupport.AcpRegistryCatalog.of({
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.die("unused inspect"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
    resolve: () =>
      Effect.succeed({
        agent: {
          id: "mock-agent",
          name: "Mock Agent",
          version: "1.0.0",
          description: "ACP session management test agent",
          distribution: { npx: { package: "mock-agent@1.0.0" } },
        },
        distribution: "npx" as const,
        spawn: {
          command: "node",
          args: [mockAgentPath],
          env: {
            ...process.env,
            GOAT_ACP_SESSION_LIFECYCLE: "1",
            GOAT_ACP_SESSION_LIST_COUNT: String(count),
            ...(scenario === undefined ? {} : { GOAT_ACP_SESSION_LIST_SCENARIO: scenario }),
            GOAT_ACP_AUTH_METHOD_ID: "mock-login",
          },
        },
      }),
  });

describe("ACP Registry probe", () => {
  it("returns advertised auth methods and de-duplicated models", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          auth: { logout: {} },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [
          { id: "chatgpt", name: "ChatGPT" },
          {
            id: "api-key",
            name: "API key",
            type: "env_var",
            vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API key" }],
          },
          { id: "login", name: "Terminal login", type: "terminal" },
        ],
      },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gpt-5.4",
            options: [
              { value: "gpt-5.4", name: "GPT-5.4" },
              { value: "gpt-5.4", name: "Duplicate" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result).toEqual({
      instanceId,
      ready: true,
      icon: null,
      authMethods: [
        { id: "chatgpt", name: "ChatGPT", description: null, type: "agent" },
        {
          id: "api-key",
          name: "API key",
          description: null,
          type: "env_var",
          envVarNames: ["OPENAI_API_KEY"],
        },
        { id: "login", name: "Terminal login", description: null, type: "terminal" },
      ],
      models: [{ id: "gpt-5.4", name: "GPT-5.4", description: null }],
      currentModelId: "gpt-5.4",
      configOptions: [],
      sessionManagement: {
        canList: true,
        canLoad: true,
        canResume: true,
        canLogout: true,
        canDelete: false,
        canConfigureProviders: false,
      },
    });
  });

  it("composes runnable terminal auth commands from the resolved spawn recipe", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["auth", "log in"],
          env: { FORCE_TTY: "1" },
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods).toEqual([
      {
        id: "login",
        name: "Terminal login",
        description: null,
        type: "terminal",
        command: "FORCE_TTY=1 /opt/agents/devin --acp auth 'log in'",
      },
    ]);
  });

  it("omits unsafe truncated auth commands instead of publishing broken shell", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["x".repeat(2_048)],
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods[0]).not.toHaveProperty("command");
  });

  it("omits overlong opaque model ids instead of publishing mutated ids", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "x".repeat(129),
            options: [
              { value: "x".repeat(129), name: "Too long" },
              { value: "valid", name: "Valid" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([{ id: "valid", name: "Valid", description: null }]);
    expect(result.currentModelId).toBeNull();
  });

  it("preserves grouped model values and advertises reasoning choices", () => {
    const codexModel = '["codex","gpt-6.1-sol"]';
    const goModel = '["opencode-go","deepseek-v4.1-flash"]';
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: goModel,
            options: [
              {
                groupId: "codex",
                name: "Codex",
                options: [{ value: codexModel, name: "GPT-6.1 Sol" }],
              },
              {
                groupId: "opencode-go",
                name: "OpenCode Go",
                options: [{ value: goModel, name: "DeepSeek V4.1 Flash" }],
              },
            ],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              {
                groupId: "effort",
                name: "Effort",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: codexModel, name: "GPT-6.1 Sol", description: null },
      { id: goModel, name: "DeepSeek V4.1 Flash", description: null },
    ]);
    expect(result.currentModelId).toBe(goModel);
    expect(result.configOptions).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it.each(["config option", "session model state"] as const)(
    "retains the current model beyond the catalog cap from %s",
    (source) => {
      const models = Array.from({ length: 257 }, (_, index) => ({
        modelId: `model-${index}`,
        name: `Model ${index}`,
      }));
      const result = acpRegistryProbeResult(instanceId, {
        sessionId: "probe-session",
        initializeResult: { protocolVersion: 1 },
        sessionSetupResult: {
          sessionId: "probe-session",
          ...(source === "config option"
            ? {
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "model-256",
                    options: models.map(({ modelId, name }) => ({ value: modelId, name })),
                  },
                ],
              }
            : { models: { currentModelId: "model-256", availableModels: models } }),
        },
        modelConfigId: source === "config option" ? "model" : undefined,
      } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

      expect(result.models).toHaveLength(256);
      expect(result.models[0]?.id).toBe("model-0");
      expect(result.models.at(-1)?.id).toBe("model-256");
      expect(result.currentModelId).toBe("model-256");
    },
  );

  it("bounds and de-duplicates advertised commands", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "create_plan",
        description: " Create a plan ",
        input: { type: "text", hint: " topic " },
      },
      { name: "CREATE_PLAN", description: "duplicate" },
      ...Array.from({ length: 140 }, (_, index) => ({
        name: `command_${index}`,
        description: "",
      })),
    ]);

    expect(commands.slashCommands).toHaveLength(128);
    expect(commands.slashCommands[0]).toEqual({
      name: "create_plan",
      description: "Create a plan",
      input: { hint: "topic" },
    });
    expect(
      commands.slashCommands.filter((command) => command.name.toLowerCase() === "create_plan"),
    ).toHaveLength(1);
    expect(commands.skills).toEqual([]);
  });

  it("routes dollar-prefixed ACP commands to the provider skill menu", () => {
    expect(
      normalizeAcpRegistryCommands([
        { name: "$workspace-skill", description: "Run the workspace skill" },
        { name: "$WORKSPACE-SKILL", description: "duplicate" },
        { name: "$", description: "empty" },
        { name: "review", description: "Review changes" },
      ]),
    ).toEqual({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ],
    });
  });

  it.effect("lists native sessions and logs out through generic ACP lifecycle methods", () => {
    const catalog = sessionListCatalog(1);
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };

    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed).toMatchObject({
        canLoad: true,
        canResume: true,
        nextCursor: null,
        sessions: [
          {
            sessionId: "mock-session-1",
            cwd: process.cwd(),
            importedThreadId: null,
          },
        ],
      });
      expect(listed.truncated).toBeUndefined();
      yield* logoutAcpRegistry(input);
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it.effect("reports an oversized provider page instead of silently losing sessions", () => {
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };
    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed.sessions).toHaveLength(256);
      expect(listed).toMatchObject({ truncated: true, nextCursor: "after-page" });
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, sessionListCatalog(257)),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it.effect.each(["id-whitespace", "id-oversized", "cwd-whitespace", "cwd-oversized"])(
    "marks a short page incomplete when %s removes a session",
    (scenario) => {
      const input = {
        instanceId,
        settings: decodeSettings({ agentId: "mock-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      };
      return Effect.gen(function* () {
        const listed = yield* listAcpRegistrySessions(input);
        expect(listed.sessions.map((session) => session.sessionId)).toEqual(["mock-session-2"]);
        expect(listed.truncated).toBe(true);
        expect(listed.nextCursor).toBeNull();
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          sessionListCatalog(2, scenario),
        ),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
  );

  it.effect.each([
    ["cursor-whitespace", "next-page"],
    ["cursor-oversized", "x".repeat(2_048)],
    ["cursor-blank", null],
  ] as const)(
    "marks a page incomplete when %s changes the provider cursor",
    ([scenario, expectedCursor]) => {
      const input = {
        instanceId,
        settings: decodeSettings({ agentId: "mock-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      };
      return Effect.gen(function* () {
        const listed = yield* listAcpRegistrySessions(input);
        expect(listed.sessions).toHaveLength(1);
        expect(listed.nextCursor).toBe(expectedCursor);
        expect(listed.truncated).toBe(true);
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          sessionListCatalog(1, scenario),
        ),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
  );

  it.effect("keeps an unchanged provider cursor and complete page unmarked", () => {
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };
    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed.sessions).toHaveLength(1);
      expect(listed.nextCursor).toBe("next-page");
      expect(listed.truncated).toBeUndefined();
    }).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        sessionListCatalog(1, "cursor-unchanged"),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it.effect("refuses a short page with an invalid session through the served MCP path", () => {
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };
    return Effect.gen(function* () {
      const page = yield* listAcpRegistrySessions(input);
      const registered = mcpCatalog.pipe(
        Layer.provide(
          Layer.mergeAll(
            dependencies,
            Layer.mock(AcpSessionService.AcpSessionService)({ list: () => Effect.succeed(page) }),
          ),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      const result = yield* McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({
            name: "goat_acp_session_list",
            arguments: { instanceId, projectId: ProjectId.make("fixture-project") },
          }),
        ),
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("fixture-environment"),
          requestNamespace: "fixture",
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "reader", label: "fixture", access: "read-only" },
          grantedScopes: ["orchestration:read"],
          reauthorize: () => Effect.void,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provide(registered),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("could not list this ACP agent's sessions completely"),
          }),
        ]),
      );
    }).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        sessionListCatalog(2, "id-whitespace"),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it("distinguishes authentication failures from generic probe failures", () => {
    const advertised = normalizeAcpRegistryAuthMethods([
      { id: "grok-login", name: "Log in with Grok" },
    ]);
    const cause = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "login required",
    });
    const authFailure = acpRegistryProbeFailure(cause, advertised);
    expect(authFailure.reason).toBe("authentication_failed");
    expect(authFailure.message).toBe("The ACP agent could not complete authentication.");
    expect(authFailure.cause).toBe(cause);
    expect(authFailure.authMethods).toEqual([
      {
        id: "grok-login",
        name: "Log in with Grok",
        description: null,
        type: "agent",
      },
    ]);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Authentication required",
          cause: "credentials missing",
        }),
      ).reason,
    ).toBe("authentication_failed");
    const genericCause = new EffectAcpErrors.AcpTransportError({
      detail: "connection closed",
      cause: "closed",
    });
    const genericFailure = acpRegistryProbeFailure(genericCause);
    expect(genericFailure.reason).toBe("probe_failed");
    expect(genericFailure.message).toBe("The ACP agent could not create a test session.");
    expect(genericFailure.cause).toBe(genericCause);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed while logging request",
          cause: "logging failed",
        }),
      ).reason,
    ).toBe("probe_failed");
  });
});
