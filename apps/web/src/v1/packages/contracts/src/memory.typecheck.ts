import type { MemoryOperationId, MemorySourceReadRequestId } from "./memory.ts";

// Compiler-only fixtures: source relay requests and durable operations cannot share ids.
type Operation<T extends MemoryOperationId> = T;
type SourceRequest<T extends MemorySourceReadRequestId> = T;

// @ts-expect-error -- a transient source request is not a durable operation.
export type SourceRequestCannotBeOperation = Operation<MemorySourceReadRequestId>;
// @ts-expect-error -- a durable operation is not a transient source request.
export type OperationCannotBeSourceRequest = SourceRequest<MemoryOperationId>;
