import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Relay from "./relay.ts";
import type * as Acp from "effect-acp/compat";
import { AcpRequestError } from "effect-acp/errors";
import { ProviderInstanceId } from "@goat/contracts";

const launch = {
  sourceInstanceId: ProviderInstanceId.make("devin-sibling"),
  command: "/selected/devin",
  cwd: "/trusted/project",
  env: { HOME: "/sibling-home" },
  binding: "fixture",
};
const source = {
  repository: "https://github.com/acme/example",
  branch: "published",
  sha: "a".repeat(40),
};
const repoOptions: ReadonlyArray<Extract<Acp.SessionConfigOption, { type: "select" }>> = [
  {
    id: "repos",
    name: "Repositories",
    type: "select",
    currentValue: "",
    options: [{ name: "Example", value: "acme/example" }],
  },
];
const sessionMeta = (status = "working") => ({
  "cognition.ai/session": {
    "cognition.ai/url": "https://app.devin.ai/sessions/fixture-session",
    "cognition.ai/statusEnum": status,
  },
});

const Rpc = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    method: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    error: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Rpc);
const isAcpRequestError = Schema.is(AcpRequestError);

it.effect(
  "real ACP boundary configures flat/grouped repos before prompt and rejects missing/mismatched choices",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const mode of [
          "flat",
          "grouped",
          "missing",
          "mismatch",
          "load-missing",
          "load-null",
          "load-mismatch",
          "no-load",
          "invalid-id",
          "new-error",
          "setter-error",
          "load-error",
          "prompt-error",
          "unoffered-version",
          "unoffered-platform",
          "version-mismatch",
          "platform-mismatch",
          "final-mismatch",
          "selected",
        ] as const)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const output = yield* Queue.unbounded<Uint8Array>();
              const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
              const cancellationSeen = yield* Deferred.make<void>();
              const pendingPrompt = yield* Deferred.make<void>();
              const replaySeen = yield* Deferred.make<void>();
              const earlyMetadataSeen = yield* Deferred.make<void>();
              const choices =
                mode === "grouped"
                  ? [
                      {
                        group: "fixture",
                        name: "Repositories",
                        options: [{ name: "Example", value: "acme/example" }],
                      },
                    ]
                  : [
                      {
                        name: "Example",
                        value: mode === "missing" ? "other/example" : "acme/example",
                      },
                    ];
              const selectionMode = [
                "unoffered-version",
                "unoffered-platform",
                "version-mismatch",
                "platform-mismatch",
                "final-mismatch",
                "selected",
              ].includes(mode);
              const options: ReadonlyArray<Acp.SessionConfigOption> = [
                ...repoOptions.map((option) =>
                  option.id === "repos"
                    ? ({ ...option, options: choices } as unknown as Acp.SessionConfigOption)
                    : option,
                ),
                ...(selectionMode
                  ? [
                      {
                        id: "devin_version",
                        name: "Version",
                        type: "select" as const,
                        currentValue: "devin-auto",
                        options: [
                          {
                            name: "Fusion",
                            value: mode === "unoffered-version" ? "other" : "devin-ultra",
                          },
                        ],
                      },
                      {
                        id: "platform",
                        name: "Platform",
                        type: "select" as const,
                        currentValue: "linux",
                        options: [
                          {
                            name: "macOS",
                            value: mode === "unoffered-platform" ? "other" : "macos",
                          },
                        ],
                      },
                    ]
                  : []),
              ];
              let currentOptions = options;
              const loadedOptions =
                mode === "load-missing"
                  ? undefined
                  : mode === "load-null"
                    ? null
                    : options.map((option) => ({
                        ...option,
                        currentValue: mode === "load-mismatch" ? "other/example" : "acme/example",
                      }));
              let prompts = 0;
              const notices: import("effect-acp/compat").SessionNotification[] = [];
              const methods: string[] = [];
              let advertised: unknown;
              let promptId: string | number | undefined;
              let refusedHostTerminal = false;
              let permissionDenied = false;
              let buffered = "";
              let spawnCount = 0;
              const send = (value: unknown) =>
                Queue.offer(output, new TextEncoder().encode(encode(value) + "\n")).pipe(
                  Effect.asVoid,
                );
              const stdin = Sink.forEach((bytes: Uint8Array) =>
                Effect.gen(function* () {
                  buffered += new TextDecoder().decode(bytes);
                  const lines = buffered.split("\n");
                  buffered = lines.pop()!;
                  for (const line of lines.filter(Boolean)) {
                    const rpc = decode(line);
                    if (!rpc.method) {
                      if (rpc.id === 900) {
                        refusedHostTerminal = rpc.error !== undefined;
                        yield* send({
                          jsonrpc: "2.0",
                          id: 901,
                          method: "session/request_permission",
                          params: {
                            sessionId: "devin-fixture-session",
                            toolCall: {
                              toolCallId: "fixture-tool",
                              title: "Host command",
                              kind: "execute",
                            },
                            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                          },
                        });
                      } else if (rpc.id === 901) {
                        permissionDenied = rpc.result?.outcome !== undefined;
                        assert.deepEqual(rpc.result, { outcome: { outcome: "cancelled" } });
                        yield* send({
                          jsonrpc: "2.0",
                          id: promptId,
                          result: { stopReason: "end_turn" },
                        });
                      }
                      continue;
                    }
                    methods.push(rpc.method);
                    if (
                      (mode === "new-error" && rpc.method === "session/new") ||
                      (mode === "setter-error" && rpc.method === "session/set_config_option") ||
                      (mode === "load-error" && rpc.method === "session/load") ||
                      (mode === "prompt-error" && rpc.method === "session/prompt")
                    ) {
                      yield* send({
                        jsonrpc: "2.0",
                        id: rpc.id,
                        error: { code: -32000, message: "Synthetic vendor diagnostic" },
                      });
                      continue;
                    }
                    if (rpc.method === "initialize") {
                      advertised = rpc.params?.clientCapabilities;
                      yield* send({
                        jsonrpc: "2.0",
                        id: rpc.id,
                        result: {
                          protocolVersion: 1,
                          agentCapabilities: { loadSession: mode !== "no-load" },
                          agentInfo: { name: "mock-cloud", version: "1" },
                        },
                      });
                    } else if (rpc.method === "session/new") {
                      assert.deepEqual(rpc.params?.mcpServers, []);
                      yield* send({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: {
                          sessionId: "devin-fixture-session",
                          update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: [],
                            _meta: sessionMeta(),
                          },
                        },
                      });
                      yield* send({
                        jsonrpc: "2.0",
                        id: rpc.id,
                        result: {
                          sessionId:
                            mode === "invalid-id"
                              ? "local-fixture-session"
                              : "devin-fixture-session",
                          configOptions: options,
                          _meta: sessionMeta(),
                        },
                      });
                    } else if (rpc.method === "session/set_config_option") {
                      const configId = rpc.params?.configId;
                      const value = rpc.params?.value;
                      assert.equal(rpc.params?.sessionId, "devin-fixture-session");
                      if (!selectionMode)
                        assert.deepEqual([configId, value], ["repos", "acme/example"]);
                      currentOptions = currentOptions.map((option) =>
                        option.type === "select" && option.id === configId
                          ? {
                              ...option,
                              currentValue:
                                mode === "mismatch" ||
                                (mode === "version-mismatch" && configId === "devin_version") ||
                                (mode === "platform-mismatch" && configId === "platform")
                                  ? ""
                                  : (value as string),
                            }
                          : option.type === "select" &&
                              mode === "final-mismatch" &&
                              configId === "repos" &&
                              option.id === "devin_version"
                            ? { ...option, currentValue: "devin-auto" }
                            : option,
                      );
                      yield* send({
                        jsonrpc: "2.0",
                        id: rpc.id,
                        result: {
                          configOptions: currentOptions,
                        },
                      });
                    } else if (rpc.method === "session/load") {
                      assert.equal(rpc.params?.sessionId, "devin-fixture-session");
                      yield* send({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: {
                          sessionId: "devin-fixture-session",
                          update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "Persisted history" },
                            _meta: { "cognition.ai/streamingMessageId": "fixture-message" },
                          },
                        },
                      });
                      yield* send({
                        jsonrpc: "2.0",
                        id: rpc.id,
                        result: {
                          _meta: sessionMeta("blocked"),
                          ...(loadedOptions === undefined ? {} : { configOptions: loadedOptions }),
                        },
                      });
                    } else if (rpc.method === "session/prompt") {
                      assert.equal(rpc.params?.sessionId, "devin-fixture-session");
                      promptId = rpc.id;
                      if (++prompts === 2) {
                        yield* Deferred.succeed(pendingPrompt, undefined);
                        continue;
                      }
                      // A misbehaving cloud agent must not be able to execute a command on the GOAT host.
                      yield* send({
                        jsonrpc: "2.0",
                        id: 900,
                        method: "terminal/create",
                        params: {
                          sessionId: "devin-fixture-session",
                          command: "must-not-execute",
                          args: [],
                        },
                      });
                    } else if (rpc.method === "session/cancel") {
                      assert.equal(rpc.params?.sessionId, "devin-fixture-session");
                      yield* Deferred.succeed(cancellationSeen, undefined);
                      yield* send({
                        jsonrpc: "2.0",
                        id: promptId,
                        result: { stopReason: "cancelled", _meta: sessionMeta() },
                      });
                    }
                  }
                }),
              );
              const spawner = ChildProcessSpawner.make((command) =>
                Effect.sync(() => {
                  spawnCount++;
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag === "StandardCommand") {
                    assert.equal(command.command, launch.command);
                    assert.deepEqual(command.args, ["acp", "--cloud"]);
                    assert.equal(command.options.shell, false);
                    assert.equal(command.options.cwd, launch.cwd);
                    assert.equal(command.options.env?.HOME, "/sibling-home");
                  }
                  return ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(42),
                    exitCode: Deferred.await(exit),
                    isRunning: Effect.succeed(true),
                    kill: () => Effect.void,
                    stdin,
                    stdout: Stream.fromQueue(output),
                    stderr: Stream.empty,
                    all: Stream.fromQueue(output),
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  });
                }),
              );
              const service = yield* Relay.DevinCloudRelay.pipe(
                Effect.provide(Relay.layer),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              const remote = yield* service.open(launch, (notice) =>
                Effect.gen(function* () {
                  notices.push(notice);
                  if (notice.update.sessionUpdate === "agent_message_chunk")
                    yield* Deferred.succeed(replaySeen, undefined);
                  if (notice.update.sessionUpdate === "available_commands_update")
                    yield* Deferred.succeed(earlyMetadataSeen, undefined);
                }),
              );
              if (mode === "invalid-id" || mode === "new-error") {
                const created = yield* Effect.result(remote.create);
                assert.isTrue(Result.isFailure(created));
                assert.deepEqual(methods, ["initialize", "session/new"]);
                return;
              }
              const receipt = yield* remote.create;
              const id = receipt.sessionId;
              assert.equal(id, "devin-fixture-session");
              // ACP v1 uses `group`; the compatibility type names the v2 `groupId` field.
              assert.deepEqual<unknown>(receipt.configOptions, options);
              assert.deepEqual(receipt._meta, sessionMeta());
              yield* Deferred.await(earlyMetadataSeen);
              assert.isTrue(
                notices.some(
                  (notice) =>
                    notice.update.sessionUpdate === "available_commands_update" &&
                    notice.update._meta?.["cognition.ai/session"] !== undefined,
                ),
              );
              const configured = yield* Effect.result(
                remote.configureSource(
                  id,
                  source,
                  selectionMode ? { model: "devin-ultra", platform: "macos" } : undefined,
                ),
              );
              if (selectionMode) {
                const expectedSetters =
                  mode === "unoffered-version"
                    ? []
                    : mode === "unoffered-platform" || mode === "version-mismatch"
                      ? ["devin_version"]
                      : mode === "platform-mismatch"
                        ? ["devin_version", "platform"]
                        : ["devin_version", "platform", "repos"];
                assert.deepEqual(methods, [
                  "initialize",
                  "session/new",
                  ...expectedSetters.map(() => "session/set_config_option"),
                ]);
                assert.equal(prompts, 0);
                assert.equal(Result.isSuccess(configured), mode === "selected");
                if (mode !== "selected") return;
                const sent = yield* remote.prompt(id, "task");
                assert.equal(sent.stopReason, "end_turn");
                assert.equal(prompts, 1);
                return;
              }
              if (mode === "missing" || mode === "mismatch" || mode === "setter-error") {
                assert.isTrue(Result.isFailure(configured));
                assert.equal(prompts, 0);
                assert.deepEqual(
                  methods,
                  mode === "missing"
                    ? ["initialize", "session/new"]
                    : ["initialize", "session/new", "session/set_config_option"],
                );
                return;
              }
              assert.isTrue(Result.isSuccess(configured));
              if (mode === "prompt-error") {
                const response = yield* Effect.result(remote.prompt(id, "task"));
                assert.isTrue(Result.isFailure(response));
                if (Result.isFailure(response)) {
                  assert.equal(response.failure.stage, "relay");
                  assert.notInclude(response.failure.message, "Synthetic vendor diagnostic");
                  const cause = response.failure.cause;
                  assert.isTrue(isAcpRequestError(cause));
                  if (isAcpRequestError(cause)) {
                    assert.equal(cause.code, -32000);
                    assert.equal(cause.method, "session/prompt");
                  }
                }
                assert.deepEqual(methods, [
                  "initialize",
                  "session/new",
                  "session/set_config_option",
                  "session/prompt",
                ]);
                return;
              }
              const response = yield* remote.prompt(id, "task");
              assert.equal(response.stopReason, "end_turn");
              assert.isTrue(refusedHostTerminal);
              assert.isTrue(permissionDenied);
              assert.deepEqual(advertised, {});
              if (mode === "no-load") {
                const loaded = yield* Effect.result(remote.attach(id));
                assert.isTrue(Result.isFailure(loaded));
                assert.notInclude(methods, "session/load");
                return;
              }
              if (mode === "load-error") {
                const loaded = yield* Effect.result(remote.attach(id));
                assert.isTrue(Result.isFailure(loaded));
                assert.deepEqual(methods, [
                  "initialize",
                  "session/new",
                  "session/set_config_option",
                  "session/prompt",
                  "session/load",
                ]);
                return;
              }
              const loaded = yield* remote.attach(id);
              assert.deepEqual(loaded._meta, sessionMeta("blocked"));
              assert.deepEqual<unknown>(loaded.configOptions, loadedOptions);
              yield* Deferred.await(replaySeen);
              assert.isTrue(
                notices.some((notice) => notice.update.sessionUpdate === "agent_message_chunk"),
              );
              assert.isTrue(
                notices.some(
                  (notice) =>
                    notice.update.sessionUpdate === "agent_message_chunk" &&
                    notice.update.messageId === "fixture-message",
                ),
              );
              assert.equal(
                Relay.validateRepositorySelection(loaded.configOptions, source),
                !mode.startsWith("load-"),
              );
              if (mode.startsWith("load-")) {
                assert.deepEqual(methods, [
                  "initialize",
                  "session/new",
                  "session/set_config_option",
                  "session/prompt",
                  "session/load",
                ]);
                return;
              }
              const pending = yield* remote.prompt(id, "follow-up").pipe(Effect.forkScoped);
              yield* Deferred.await(pendingPrompt);
              yield* remote.cancel(id);
              yield* Deferred.await(cancellationSeen);
              const cancelled = yield* Fiber.join(pending);
              assert.equal(cancelled.stopReason, "cancelled");
              assert.deepEqual(methods, [
                "initialize",
                "session/new",
                "session/set_config_option",
                "session/prompt",
                "session/load",
                "session/prompt",
                "session/cancel",
              ]);
              assert.equal(spawnCount, 1);
            }),
          );
      }),
    ),
);

it("repository readback requires one exact offered selection and a canonical GitHub source", () => {
  const selected: Acp.SessionConfigOption = {
    id: "repos",
    name: "Repositories",
    type: "select",
    currentValue: "acme/example",
    options: [{ name: "Example", value: "acme/example" }],
  };
  assert.isTrue(Relay.validateRepositorySelection([selected], source));
  assert.isTrue(
    Relay.validateRepositorySelection(
      [
        {
          ...selected,
          options: [
            {
              groupId: "acme",
              name: "Acme",
              options: [{ name: "Example", value: "acme/example" }],
            },
          ],
        },
      ],
      { ...source, repository: "https://github.com/acme/example.git" },
    ),
  );
  for (const options of [
    undefined,
    null,
    [],
    [{ ...selected, currentValue: "" }],
    [{ ...selected, currentValue: "other/example" }],
    [{ ...selected, options: [] }],
    [selected, selected],
    [
      {
        id: "other",
        name: "Other",
        type: "select" as const,
        currentValue: "acme/example",
        options: selected.options,
      },
    ],
  ]) {
    assert.isFalse(Relay.validateRepositorySelection(options, source));
  }
  for (const repository of [
    "acme/example",
    "http://github.com/acme/example",
    "https://example.com/acme/example",
    "https://github.com/acme/example/tree/main",
    "https://github.com/acme/example?token=synthetic",
    "https://user@github.com/acme/example",
    "https://github.com/acme/example#fragment",
  ]) {
    assert.isFalse(Relay.validateRepositorySelection([selected], { ...source, repository }));
  }
});
