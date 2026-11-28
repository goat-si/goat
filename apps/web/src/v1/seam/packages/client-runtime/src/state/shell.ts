// Seam (lane F): replaces v1 packages/client-runtime/src/state/shell.ts @916b5cc. v1 shell.ts is the environment shell runtime (connections, snapshot loading, reducers over the v1 rpc stream).
// Lifted code reads only the shell model types, which live in the lifted models.ts (v1 shell.ts re-exports it too).
// Listed in docs/PROVENANCE.md (v1 bridge table).
export * from "../../../../../packages/client-runtime/src/state/models.ts";
