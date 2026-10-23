import { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AcpMcpBridgeError, mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import {
  type AgentSurfaceInvocation,
  type CallEffect,
  type CallFailure,
  EXIT,
  exitCodeOf,
  failureResult,
  toolResultEnvelope,
} from "./agentSurfaceCommand.ts";
import { formatDescribe } from "./agentSurfaceFormat.ts";
import {
  type CliCredential,
  type CliCredentialError,
  resolveCliCredential,
  type StoredLogin,
  threadEnvironmentFrom,
} from "./cliCredential.ts";

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

export interface AgentSurfaceIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Read only outside a thread; see resolveCliCredential. */
  readonly loadLogin: Effect.Effect<Option.Option<StoredLogin>, CliCredentialError>;
  readonly fetchImplementation?: FetchImplementation;
}

const encodeEnvelope = Schema.encodeSync(Schema.fromJsonString(AgentSurfaceResult));
const encodePretty = (value: unknown) => JSON.stringify(value, null, 2);

const failureOf = (phase: CallFailure["phase"], error: AcpMcpBridgeError): CallFailure => ({
  phase,
  kind: error.kind,
  status: error.status,
  rpcCode: error.rpcCode,
  message: error.message,
});

/**
 * One goat_call on the origin's /mcp: the same handle, argument refusal, access checks and
 * host routing a direct call gets. --host is just the call's host argument.
 */
const callOrigin = (
  credential: CliCredential,
  invocation: Extract<AgentSurfaceInvocation, { kind: "call" }>,
  effect: CallEffect,
  fetchImplementation: FetchImplementation | undefined,
) =>
  mcpToolSession({
    endpoint: credential.endpoint,
    authorization: credential.authorization,
    clientName: "goat-cli",
    ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
  }).pipe(
    Effect.flatMap((session) =>
      session.call("goat_call", { path: invocation.path, args: invocation.args }).pipe(
        Effect.map((raw) =>
          Option.getOrElse(toolResultEnvelope(raw), () =>
            failureResult(
              {
                phase: "dispatch",
                kind: "protocol",
                message: "GOAT answered without a result envelope.",
              },
              effect,
            ),
          ),
        ),
        Effect.catchTags({
          AcpMcpBridgeError: (error) =>
            Effect.succeed(failureResult(failureOf("dispatch", error), effect)),
        }),
      ),
    ),
    Effect.catchTags({
      AcpMcpBridgeError: (error) =>
        Effect.succeed(failureResult(failureOf("connect", error), effect)),
    }),
    Effect.scoped,
  );

/** A refused thread credential says so: the CLI never retries it with another one. */
const noFallbackNote = (
  result: AgentSurfaceResult,
  credential: CliCredential,
): AgentSurfaceResult =>
  credential.source === "thread" &&
  result.status === "error" &&
  result.error.code === "unauthenticated"
    ? {
        ...result,
        error: {
          ...result.error,
          message: `${result.error.message} This shell's thread credential was refused; the CLI does not fall back to another credential.`,
        },
      }
    : result;

const report = (
  result: AgentSurfaceResult,
  invocation: Extract<AgentSurfaceInvocation, { kind: "call" }>,
  io: AgentSurfaceIo,
): number => {
  if (invocation.json) io.stdout(`${encodeEnvelope(result)}\n`);
  else if (result.status === "ok")
    io.stdout(
      `${
        invocation.format === "describe"
          ? formatDescribe(result.value)
          : typeof result.value === "string"
            ? result.value
            : encodePretty(result.value)
      }\n`,
    );
  else if (result.status === "error")
    io.stderr(`error: ${result.error.code} (${result.error.reason}): ${result.error.message}\n`);
  else {
    const { handoff, next } = result;
    io.stderr(
      [
        `A person must act: ${handoff.title} (${handoff.kind} ${handoff.handoffId}, ${handoff.state}${handoff.expiresAt === null ? "" : `, expires ${handoff.expiresAt}`}).`,
        ...(next === undefined ? [] : [`After that, call ${next.path}.`]),
      ].join("\n") + "\n",
    );
  }
  return exitCodeOf(result);
};

export const runAgentSurfaceInvocation = Effect.fn("cli.agentSurface.run")(function* (
  invocation: AgentSurfaceInvocation,
  io: AgentSurfaceIo,
): Effect.fn.Return<number> {
  if (invocation.kind === "help") {
    io.stdout(`${invocation.text}\n`);
    return EXIT.ok;
  }
  if (invocation.kind === "usage") {
    io.stderr(`${invocation.message}\n`);
    return EXIT.usage;
  }
  const credential = yield* resolveCliCredential(threadEnvironmentFrom(io.env), io.loadLogin).pipe(
    Effect.result,
  );
  if (credential._tag === "Failure")
    return report(
      {
        status: "error",
        error: {
          code: "unauthenticated",
          reason: credential.failure.reason,
          message: credential.failure.message,
          retryable: false,
        },
      },
      invocation,
      io,
    );
  const result = yield* callOrigin(
    credential.success,
    invocation,
    invocation.effect,
    io.fetchImplementation,
  );
  return report(noFallbackNote(result, credential.success), invocation, io);
});

/** The process entry: bin.ts runs it before the operator CLI loads. */
export const runAgentSurfaceCliMain = (invocation: AgentSurfaceInvocation): Promise<number> =>
  Effect.runPromise(
    runAgentSurfaceInvocation(invocation, {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      // Only outside a thread, so an agent's call never loads the server's config modules.
      loadLogin: Effect.promise(() => import("./login.ts")).pipe(
        Effect.flatMap((login) => login.loadDefaultStoredLogin),
      ),
    }),
  );
