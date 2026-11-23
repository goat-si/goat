import {
  MemoryImportRpcError,
  WS_METHODS,
  WsMemoryImportRpcGroup,
  clientRpcRequiredScopes,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemoryService from "./memory/MemoryService.ts";
import { ProviderMemoryImportRuntime } from "./memory/imports/MemoryImportTypes.ts";
import { memoryLegacyError as memoryError } from "./mcp/toolkits/memory/handlers.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import { memorySessionPermit } from "./wsMemorySessionPermit.ts";

const isMemoryImportRpcError = Schema.is(MemoryImportRpcError);

/** Shared by the installed websocket route and the transport integration harness. */
export const makeMemoryImportHandlers = Effect.fn("MemoryImport.makeHandlers")(function* <E>(
  liveScopes: Effect.Effect<ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>, E>,
  capturedScopes: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>,
) {
  const memory = yield* MemoryService.MemoryService;
  const runtime = yield* Effect.serviceOption(ProviderMemoryImportRuntime);
  return WsMemoryImportRpcGroup.middleware(RpcInstrumentation).of({
    [WS_METHODS.memoryImportProvider]: (input) =>
      (runtime._tag === "Some"
        ? memory
            .importProvider(
              input,
              memorySessionPermit(
                liveScopes,
                capturedScopes,
                clientRpcRequiredScopes(WS_METHODS.memoryImportProvider, input),
              ),
            )
            .pipe(Effect.provideService(ProviderMemoryImportRuntime, runtime.value))
        : Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" }))
      ).pipe(
        Effect.mapError((error) => (isMemoryImportRpcError(error) ? error : memoryError(error))),
      ),
  });
});
