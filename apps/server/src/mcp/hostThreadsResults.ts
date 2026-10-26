import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadRetryResult,
  type OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadStatusResult,
  OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpThreadWatch,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type LaunchWatch, replicaStatus } from "./launchWatch.ts";
import type * as LaunchWatchService from "./LaunchWatchService.ts";

export const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message: Array.from(message).slice(0, 2000).join("") });

export const withoutHost = <T extends { readonly host?: unknown; readonly allHosts?: unknown }>(
  input: T,
): Omit<T, "host" | "allHosts"> => {
  const { host: _host, allHosts: _allHosts, ...rest } = input;
  return rest;
};

/**
 * A host older than turn capabilities refuses an argument it does not declare, so an empty
 * request is left out; a real one reaches it and fails there with nothing sent.
 */
export const remoteSendArguments = (input: OrchestratorMcpThreadSendInput) => {
  const { capabilities, ...rest } = withoutHost(input);
  return capabilities === undefined || capabilities.length === 0 ? rest : { ...rest, capabilities };
};

/** Another machine's answer is untrusted: it must decode as the tool's own result. */
export const decodeRemote =
  <A, E>(decode: (value: unknown) => Effect.Effect<A, E>, host: string, tool: string) =>
  (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(() =>
        failure("orchestration_error", `${host} returned a result ${tool} could not read.`),
      ),
    );

export const decodeList = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
export const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
export const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
export const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
export const decodeInterrupt = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult);
export const decodeRetry = Schema.decodeUnknownEffect(OrchestratorMcpThreadRetryResult);
export const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);

export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A stored watch as the watch tools show it. */
export function watchView(watch: LaunchWatch): OrchestratorMcpThreadWatch {
  return {
    ...(watch.host === null ? {} : { host: watch.host }),
    threadId: watch.threadId,
    title: watch.title,
    pendingRunIds: watch.recovery === undefined ? [...watch.pendingRuns] : [],
    replicaStatus: replicaStatus(watch),
    lastReportedRunId: watch.reportedRuns.at(-1) ?? null,
    hostUnavailableSince: watch.outage === null ? null : iso(watch.outage.since),
    createdAt: iso(watch.createdAt),
    updatedAt: iso(watch.updatedAt),
  };
}

export const storeFailure = (error: LaunchWatchService.LaunchWatchStoreError) =>
  failure("orchestration_error", error.message);
