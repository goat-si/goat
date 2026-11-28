// Seam (lane F): replaces v1 packages/client-runtime/src/environment/index.ts @916b5cc. v1 also re-exports descriptor.ts, which reads environment descriptors over the v1 rpc/http server; GOAT 2 has no v1
// environment server, so only the pure modules (lifted byte-identical) are re-exported.
// Listed in docs/PROVENANCE.md (v1 bridge table).
export * from "../../../../../packages/client-runtime/src/environment/endpoint.ts";
export * from "../../../../../packages/client-runtime/src/environment/knownEnvironment.ts";
export * from "../../../../../packages/client-runtime/src/environment/scoped.ts";
