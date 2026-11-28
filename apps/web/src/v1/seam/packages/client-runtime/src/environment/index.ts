// Bridge for v1 @goat/client-runtime/environment (packages/client-runtime/src/environment/index.ts, docs/PROVENANCE.md).
// Re-exports the three pure, byte-identical lifted modules. v1's descriptor.ts (environment descriptor fetch over the
// v1 HTTP RPC client) is left out: GOAT 2 has one local host and no v1 environment HTTP API.
export * from "../../../../../packages/client-runtime/src/environment/endpoint.ts";
export * from "../../../../../packages/client-runtime/src/environment/knownEnvironment.ts";
export * from "../../../../../packages/client-runtime/src/environment/scoped.ts";
