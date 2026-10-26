/**
 * Both of its `generate` endpoints answer 403 on OpenCode's free tier ("free tier can only be
 * used from within OpenCode"), so each request runs as a prompt in a temporary session, as 1.x
 * does, and the session is removed afterwards.
 */
/**
 * Both of its `generate` endpoints answer 403 on OpenCode's free tier ("free tier can only be
 * used from within OpenCode"), so each request runs as a prompt in a temporary session, as 1.x
 * does, and the session is removed afterwards.
 */
import { AbsolutePath, Location, Model, Provider, Session } from "@opencode/client/effect";
import { ProviderDriverKind, TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  withMemoryExecution,
  type MemoryGenerationRunnerContext,
} from "@goat/provider-core/server/memoryGenerationRunner";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as TextGenerationOperations from "@goat/provider-core/server/textGenerationOperations";
import { requireOpenCodeMemoryIsolation } from "../textGeneration.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

const GENERATION_TIMEOUT = "3 minutes";

// Free models refuse denied read/shell permissions; ask and reject requests as they arrive.
const GENERATION_PERMISSIONS = [{ action: "*", resource: "*", effect: "ask" }] as const;

// Provider error text stays in cause, outside detail.
type Outcome =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "failed"; readonly detail: string; readonly cause?: unknown };

const runOnServer = Effect.fn("Opencode2TextGeneration.runOnServer")(function* (
  connection: OpenCode2Server.OpenCode2Connection,
  input: TextGenerationOperations.Request<Schema.Top>,
) {
  const memory = TextGenerationOperations.isMemoryOperation(input.operation);
  if (memory && connection.external) return yield* requireOpenCodeMemoryIsolation(input.operation);
  const fs = yield* FileSystem.FileSystem;
  const cwd = memory
    ? yield* fs.makeTempDirectoryScoped({ prefix: "goat-opencode2-memory-" })
    : input.cwd;
  const { resolveAttachmentPath } = yield* ProviderHost.ProviderHost;
  const { client } = connection;
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
  if (parsed === null) {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: "OpenCode model selection must use the 'provider/model' format.",
      ...(memory ? { cause: new MemoryGenerationRunnerError({ code: "unavailable" }) } : {}),
    });
  }
  const location = { directory: AbsolutePath.make(cwd) };
  if (memory) {
    const isolationFailure = new TextGenerationError({
      operation: input.operation,
      detail: "OpenCode could not verify memory helper configuration or MCP isolation.",
      cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
    });
    const config = yield* client.config
      .get({ location })
      .pipe(Effect.mapError(() => isolationFailure));
    if (
      config.some(
        (entry) =>
          entry.type === "document" &&
          ((entry.info.plugins?.length ?? 0) > 0 ||
            Object.values(entry.info.mcp?.servers ?? {}).some(
              (server) => server.disabled !== true,
            )),
      )
    ) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode memory generation requires no active MCP servers in its helper location.",
        cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
      });
    }
    const servers = yield* client.mcp
      .list({ location })
      .pipe(Effect.mapError(() => isolationFailure));
    if (servers.data.some((server) => server.status.status !== "disabled"))
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode memory helper has connected MCP servers.",
        cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
      });
  }
  const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
  const outcome = yield* Deferred.make<Outcome>();
  let sessionId: string | undefined;
  let rejected = false;
  let effectiveModel: string | undefined;
  const texts = new Map<string, string>();
  // Subscribed first: the stream is volatile, and the reply arrives on it.
  const events = yield* connection.events;
  yield* events.pipe(
    Stream.runForEach((event) => {
      // An execution end a newer server sent in a shape this build cannot
      // read still ends the generation, as it ends a turn in the adapter.
      if (event.type === "unreadable.execution.ended") {
        if (event.sessionID !== sessionId) return Effect.void;
        return Deferred.succeed(
          outcome,
          event.executionType === "session.execution.succeeded"
            ? { _tag: "text", text: [...texts.values()].join("\n").trim() }
            : {
                _tag: "failed",
                detail: "OpenCode ended the generation in a way this version cannot read.",
                cause: event,
              },
        );
      }
      if (
        sessionId === undefined ||
        !("data" in event) ||
        !("sessionID" in event.data) ||
        event.data.sessionID !== sessionId
      ) {
        return Effect.void;
      }
      if (
        memory &&
        (event.type.startsWith("session.tool.") ||
          event.type === "permission.asked" ||
          event.type === "form.created")
      ) {
        rejected = true;
        const fail = Deferred.succeed(outcome, {
          _tag: "failed",
          detail: "OpenCode attempted a tool or permission request during memory generation.",
        });
        if (event.type === "permission.asked")
          return client.permission
            .reply({
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              decision: "reject",
            })
            .pipe(Effect.timeout("5 seconds"), Effect.ignore, Effect.andThen(fail));
        return fail;
      }
      if (memory && event.type === "session.step.started") {
        const model = event.data.model;
        if (
          model.providerID !== parsed.providerID ||
          model.id !== parsed.modelID ||
          model.variant !== variant
        ) {
          rejected = true;
          return Deferred.succeed(outcome, {
            _tag: "failed",
            detail: "OpenCode used a different memory model.",
            // The server substitutes the same model on every try.
            cause: new MemoryGenerationRunnerError({ code: "identity_mismatch" }),
          });
        }
        effectiveModel = `${model.providerID}/${model.id}`;
      }
      switch (event.type) {
        case "session.text.ended":
          texts.set(`${event.data.assistantMessageID}:${event.data.ordinal}`, event.data.text);
          return Effect.void;
        case "permission.asked":
          return client.permission
            .reply({
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              decision: "reject",
              message: "Tools are not available while generating text.",
            })
            .pipe(Effect.ignore({ log: true }));
        case "session.execution.succeeded":
          return Deferred.succeed(outcome, {
            _tag: "text",
            text: [...texts.values()].join("\n").trim(),
          });
        case "session.execution.failed":
          return Deferred.succeed(outcome, {
            _tag: "failed",
            detail: "OpenCode could not generate the text.",
            cause: event.data.error,
          });
        case "session.execution.interrupted":
          return Deferred.succeed(outcome, {
            _tag: "failed",
            detail: "OpenCode stopped the generation.",
          });
        default:
          return Effect.void;
      }
    }),
    // The reply only arrives on this stream, so a lost stream ends the wait.
    Effect.exit,
    Effect.flatMap((exit) =>
      Deferred.succeed(outcome, {
        _tag: "failed",
        detail: "The OpenCode event stream was lost.",
        cause: exit,
      }),
    ),
    Effect.forkScoped,
  );
  const session = yield* client.session.create({
    title: `GOAT ${input.operation}`,
    location: Location.PublicRef.make(location),
    model: Model.Ref.make({
      providerID: Provider.ID.make(parsed.providerID),
      id: Model.ID.make(parsed.modelID),
      ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
    }),
    permissions: memory ? [{ action: "*", resource: "*", effect: "deny" }] : GENERATION_PERMISSIONS,
  });
  sessionId = session.id;
  yield* Effect.addFinalizer(() =>
    (memory
      ? client.session
          .interrupt({ sessionID: session.id })
          .pipe(Effect.timeout("5 seconds"), Effect.ignore)
      : Effect.void
    ).pipe(
      Effect.andThen(
        client.session
          .remove({ sessionID: session.id })
          .pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true })),
      ),
    ),
  );
  const images = (input.attachments ?? []).flatMap((attachment) => {
    if (attachment.type !== "image") return [];
    const path = resolveAttachmentPath(attachment);
    return path === null ? [] : [{ uri: `file://${path}`, name: attachment.name }];
  });
  yield* client.session
    .prompt({
      sessionID: session.id,
      text: input.prompt,
      ...(images.length === 0 ? {} : { files: images }),
    })
    .pipe(Effect.asVoid, Effect.raceFirst(Deferred.await(outcome).pipe(Effect.asVoid)));
  const result = yield* Deferred.await(outcome).pipe(
    Effect.timeoutOrElse({
      duration: GENERATION_TIMEOUT,
      orElse: () =>
        client.session.interrupt({ sessionID: Session.ID.make(session.id) }).pipe(
          Effect.ignore,
          Effect.as<Outcome>({
            _tag: "failed",
            detail: "OpenCode did not finish generating in time.",
          }),
        ),
    }),
  );
  if (result._tag === "failed") {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: result.detail,
      ...(result.cause === undefined ? {} : { cause: result.cause }),
    });
  }
  if (memory && (rejected || effectiveModel === undefined))
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: rejected
        ? "OpenCode attempted a tool or permission request during memory generation."
        : "OpenCode did not confirm its effective memory model.",
      // A server that omits the effective model omits it every time.
      ...(rejected ? {} : { cause: new MemoryGenerationRunnerError({ code: "unavailable" }) }),
    });
  if (result.text.length === 0) {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: "OpenCode returned empty output.",
    });
  }
  return { text: result.text, effectiveModel: effectiveModel ?? input.modelSelection.model };
}, Effect.scoped);

/** Text generation for an instance whose server is OpenCode 2. */
export const make = Effect.fn("OpenCode2TextGeneration.make")(function* (
  options: {
    readonly memoryRunnerContext?: MemoryGenerationRunnerContext;
    readonly external?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* OpenCode2Server.OpenCode2Server;
  const host = yield* ProviderHost.ProviderHost;
  const runSelected = <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) =>
    (TextGenerationOperations.isMemoryOperation(input.operation) && options.external
      ? requireOpenCodeMemoryIsolation(input.operation)
      : TextGenerationOperations.isMemoryOperation(input.operation)
        ? server.withMemoryConnection === undefined
          ? requireOpenCodeMemoryIsolation(input.operation)
          : server.withMemoryConnection(
              input.operation,
              input.modelSelection.model.split("/")[0] ?? "",
              (connection) => runOnServer(connection, input),
            )
        : server.withConnection((connection) => runOnServer(connection, input))
    ).pipe(
      Effect.timeoutOrElse({
        duration: GENERATION_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode text generation timed out.",
            }),
          ),
      }),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ProviderHost.ProviderHost, host),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode text generation failed.",
              // A runtime that cannot start or is too old fails every memory request; a held
              // database lock clears on its own.
              cause:
                TextGenerationOperations.isMemoryOperation(input.operation) &&
                OpenCodeRuntime.isOpenCodeRuntimeError(cause) &&
                cause.reason !== "databaseLocked"
                  ? new MemoryGenerationRunnerError({ code: "unavailable" })
                  : cause,
            }),
      ),
      Effect.flatMap((raw) =>
        TextGenerationOperations.decodeJsonReply(input, "OpenCode", raw.text).pipe(
          Effect.map((result) => ({ result, effectiveModel: raw.effectiveModel })),
        ),
      ),
    );
  return TextGenerationOperations.fromRunner(
    "OpenCode2TextGeneration",
    TextGenerationOperations.withoutInvestigation("OpenCode", (input) =>
      runSelected(input).pipe(Effect.map((selected) => selected.result)),
    ),
    {
      memoryRunner: withMemoryExecution(
        options.memoryRunnerContext,
        ProviderDriverKind.make("opencode"),
        runSelected,
      ),
    },
  );
});
