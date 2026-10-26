import {
  deprecatedReplacement,
  listedToolName,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";

import { makeHostConditions } from "../../hostConditions.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as Handoffs from "../../../handoffs/Handoffs.ts";
import { makeHandoffReader } from "../../operations/handoffReads.ts";
import { makeOperationTokens } from "../../operations/OperationTokens.ts";
import { ToolDispatch } from "../../ToolDispatch.ts";
import { dispatchEnvelope, envelopeError } from "./dispatchEnvelope.ts";
import { makeOperations } from "./operations.ts";
import { makeDescribe } from "./describe.ts";
import { makeHostDescribe } from "./hostDescribe.ts";
import { AgentSurfaceToolkit } from "./tools.ts";

// Calling these through goat_call would only nest the same checks, or recurse.
const NOT_CALLABLE: ReadonlySet<string> = new Set(["surface.call", "surface.eval"]);

export const layer = McpToolAccess.toLayer(
  AgentSurfaceToolkit,
  Effect.gen(function* () {
    const dispatch = yield* ToolDispatch;
    const operations = makeOperations(
      dispatch,
      yield* makeOperationTokens,
      makeHandoffReader(yield* Effect.serviceOption(Handoffs.Handoffs)),
    );

    const permissions = yield* Profiles.PermissionProfiles;
    const describe = makeDescribe(dispatch, permissions, yield* makeHostConditions);
    const describeOnHost = makeHostDescribe(dispatch, permissions);

    const call = Effect.fn("AgentSurface.call")(function* (input: {
      readonly path: string;
      readonly args?: Readonly<Record<string, unknown>> | undefined;
    }) {
      const entry = resolveAgentSurfaceEntry(input.path);
      if (entry === undefined)
        return envelopeError(
          "not_found",
          "unknown_path",
          `No GOAT path or tool is named ${input.path}. Search with goat_describe { query }.`,
        );
      const name = listedToolName(entry);
      if (NOT_CALLABLE.has(entry.path))
        return envelopeError(
          "invalid_request",
          "not_callable",
          `${name} cannot run inside goat_call. Call it directly.`,
        );
      if (dispatch.served(name) === undefined)
        return envelopeError("not_found", "not_served", `This GOAT server does not serve ${name}.`);
      const args = input.args ?? {};
      const host = entry.hostRoutable && typeof args.host === "string" ? args.host : undefined;
      // Work that runs on needs a handle; without one, starting it would strand the caller (D1).
      if (yield* operations.unready(entry))
        return {
          status: "error",
          error: {
            code: "unavailable",
            reason: "operation_unavailable",
            message: `GOAT could not prepare a handle for this work, so ${name} did not run. Try again.`,
            retryable: true,
          },
        } satisfies AgentSurfaceResult;
      const result = yield* dispatchEnvelope(dispatch, name, args, entry.effect, host);
      const finished = yield* operations.withOperation(entry, result);
      // The envelope names paths, so a deprecated name or path points at the current path.
      return deprecatedReplacement(input.path) === undefined
        ? finished
        : { ...finished, meta: { ...finished.meta, deprecated: entry.path } };
    });

    return {
      // Another machine is reached with this machine's credentials, under the host-reading gate.
      goat_describe: McpToolAccess.readsOrReachesHost(
        (input) => input.host !== undefined,
        ({ host, ...input }) =>
          Effect.gen(function* () {
            if (host === undefined) return yield* describe(input);
            return yield* describeOnHost({ ...input, host });
          }),
      ),
      // Destructive so clients that prompt on destructive tools still prompt for the targets that are.
      goat_call: McpToolAccess.destructive(McpToolAccess.dispatches(call)),
      goat_operation_read: McpToolAccess.reads(operations.read),
      goat_operation_wait: McpToolAccess.reads(operations.wait),
      // The kind's own cancel tool holds the checks, as goat_call's targets do.
      goat_operation_cancel: McpToolAccess.destructive(McpToolAccess.dispatches(operations.cancel)),
    };
  }),
);
