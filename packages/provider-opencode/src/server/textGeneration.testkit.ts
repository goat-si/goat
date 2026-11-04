import * as Effect from "effect/Effect";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

export const runtimeMock = {
  state: {
    environments: [] as NodeJS.ProcessEnv[],
    startCalls: [] as string[],
    promptUrls: [] as string[],
    promptParts: [] as ReadonlyArray<unknown>[],
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    directories: [] as string[],
    promptInputs: [] as Array<{
      tools?: Record<string, boolean>;
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
    }>,
    deleted: [] as string[],
    aborted: [] as string[],
    denied: [] as string[],
    eventScenario: undefined as "tool" | "permission" | undefined,
    config: {} as { mcp?: Record<string, { enabled?: boolean }>; plugin?: string[] },
    stall: false,
    sessionCreateCalls: 0,
    connectCalls: 0,
    clientCalls: 0,
    abortCalls: [] as string[],
    sessionCalls: [] as string[],
    onSessionCreate: undefined as ((signal?: AbortSignal) => Promise<never>) | undefined,
    onPrompt: undefined as
      | ((signal?: AbortSignal) => void | Promise<{ data: { parts: ReadonlyArray<unknown> } }>)
      | undefined,
    onAbort: undefined as ((signal?: AbortSignal) => Promise<never>) | undefined,
    connectionError: undefined as Error | undefined,
    startError: undefined as OpenCodeRuntime.OpenCodeRuntimeError | undefined,
    sessionCreateError: undefined as unknown,
    sessionResult: undefined as { data?: { id: string } } | undefined,
    promptRequestError: undefined as unknown,
    promptResult: undefined as
      | {
          data?: {
            info?: { error?: unknown; modelID?: string; providerID?: string; variant?: string };
            parts?: Array<unknown>;
          };
        }
      | undefined,
  },
  reset() {
    this.state.environments.length = 0;
    this.state.startCalls.length = 0;
    this.state.promptUrls.length = 0;
    this.state.promptParts.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.directories.length = 0;
    this.state.promptInputs.length = 0;
    this.state.deleted.length = 0;
    this.state.aborted.length = 0;
    this.state.denied.length = 0;
    this.state.eventScenario = undefined;
    this.state.config = {};
    this.state.stall = false;
    this.state.sessionCreateCalls = 0;
    this.state.connectCalls = 0;
    this.state.clientCalls = 0;
    this.state.abortCalls.length = 0;
    this.state.sessionCalls.length = 0;
    this.state.onSessionCreate = undefined;
    this.state.onPrompt = undefined;
    this.state.onAbort = undefined;
    this.state.connectionError = undefined;
    this.state.startError = undefined;
    this.state.sessionCreateError = undefined;
    this.state.sessionResult = undefined;
    this.state.promptRequestError = undefined;
    this.state.promptResult = undefined;
  },
};

export const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword, environment }) =>
    Effect.gen(function* () {
      if (runtimeMock.state.startError) return yield* runtimeMock.state.startError;
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      runtimeMock.state.environments.push(environment ?? {});
      // The production runtime binds server lifetime to the caller's scope.
      // Mirror that here so the closeCalls probe observes scope close.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      const effectiveServerPassword = OpenCodeRuntime.resolveOpenCodeServerPassword({
        external: false,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return {
        url,
        ...(effectiveServerPassword !== undefined
          ? { serverPassword: effectiveServerPassword }
          : {}),
        version: "1.14.19",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) => {
    runtimeMock.state.connectCalls++;
    return runtimeMock.state.connectionError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "global.health",
            detail: runtimeMock.state.connectionError.message,
            cause: runtimeMock.state.connectionError,
          }),
        )
      : Effect.succeed({
          url: serverUrl ?? "http://127.0.0.1:4301",
          ...(serverPassword ? { serverPassword } : {}),
          version: "1.14.19",
          exitCode: null,
          external: Boolean(serverUrl),
        });
  },
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword, directory }) => {
    runtimeMock.state.clientCalls++;
    runtimeMock.state.directories.push(directory);
    let begin: (() => void) | undefined;
    let handled: (() => void) | undefined;
    const prompting = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const eventsHandled = new Promise<void>((resolve) => {
      handled = resolve;
    });
    return {
      config: { get: async () => ({ data: runtimeMock.state.config }) },
      mcp: { status: async () => ({ data: {} }) },
      tool: { ids: async () => ({ data: ["read", "bash", "question"] }) },
      permission: {
        reply: async ({ requestID }: { requestID: string }) => {
          runtimeMock.state.denied.push(requestID);
          return { data: true };
        },
      },
      event: {
        subscribe: async (_input: unknown, options: { signal: AbortSignal }) => ({
          stream: (async function* () {
            const stopped = new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await Promise.race([prompting, stopped]);
            if (runtimeMock.state.eventScenario === "tool")
              yield {
                type: "message.part.updated",
                properties: { part: { type: "tool", sessionID: `${baseUrl}/session` } },
              };
            if (runtimeMock.state.eventScenario === "permission")
              yield {
                type: "permission.asked",
                properties: { id: "permission-1", sessionID: `${baseUrl}/session` },
              };
            handled?.();
            await stopped;
          })(),
        }),
      },
      session: {
        abort: async (
          { sessionID }: { sessionID: string },
          options?: { readonly signal?: AbortSignal },
        ) => {
          runtimeMock.state.aborted.push(sessionID);
          runtimeMock.state.abortCalls.push(sessionID);
          runtimeMock.state.sessionCalls.push(`abort ${sessionID}`);
          if (runtimeMock.state.onAbort) return runtimeMock.state.onAbort(options?.signal);
          return { data: true };
        },
        delete: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.deleted.push(sessionID);
          runtimeMock.state.sessionCalls.push(`delete ${sessionID}`);
          return { data: true };
        },
        create: async (_input: unknown, options?: { readonly signal?: AbortSignal }) => {
          runtimeMock.state.sessionCreateCalls += 1;
          if (runtimeMock.state.onSessionCreate) {
            return runtimeMock.state.onSessionCreate(options?.signal);
          }
          if (runtimeMock.state.sessionCreateError !== undefined) {
            throw runtimeMock.state.sessionCreateError;
          }
          return runtimeMock.state.sessionResult ?? { data: { id: `${baseUrl}/session` } };
        },
        prompt: async (
          input: {
            readonly parts: ReadonlyArray<unknown>;
            tools?: Record<string, boolean>;
            model?: { providerID: string; modelID: string };
            agent?: string;
            variant?: string;
          },
          options?: { readonly signal?: AbortSignal },
        ) => {
          runtimeMock.state.promptInputs.push(input);
          const promptOverride = runtimeMock.state.onPrompt?.(options?.signal);
          begin?.();
          if (runtimeMock.state.eventScenario) await eventsHandled;
          if (runtimeMock.state.stall) await new Promise<void>(() => {});
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.promptParts.push(input.parts);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          if (promptOverride !== undefined) return promptOverride;
          if (runtimeMock.state.promptRequestError !== undefined) {
            throw runtimeMock.state.promptRequestError;
          }
          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    } as unknown as ReturnType<
      OpenCodeRuntime.OpenCodeRuntime["Service"]["createOpenCodeSdkClient"]
    >;
  },
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
  loadSkillsFromCli: () => Effect.succeed([]),
};
