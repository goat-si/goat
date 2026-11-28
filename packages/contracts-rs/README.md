# @goat2/contracts-rs

TypeScript types and JSON Schemas generated from the Rust crate `crates/goat2-contracts`, the single
source of the GOAT 2 host/UI wire and disk contracts. Do not edit `src/generated/` or `schema/` by hand.

Regenerate after changing the Rust types:

```sh
GOAT2_CONTRACTS_BLESS=1 cargo test -p goat2-contracts --test generated
pnpm --filter @goat2/contracts-rs typecheck
```

`cargo test -p goat2-contracts` fails when these files are out of date.

- `src/generated/<Type>.ts`: one file per type (ts-rs), `index.ts` re-exports all of them, `limits.ts`
  holds the Rust constants and `LOG_EVENT_TYPES`.
- `schema/<Root>.schema.json`: JSON Schema draft 2020-12 per root type. Schemas describe what readers
  accept (serde deserialize contract): fields with defaults may be omitted, and a missing nullable field
  reads as `null` because the log is never migrated. Every `uint64` carries `maximum: 2^53-1`
  (`MAX_SAFE_WIRE_INTEGER`) so JavaScript numbers stay exact; the Rust types enforce the same bound when
  encoding and decoding (`serde_util::safe_u64`), so serde, the schemas and the TypeScript `number` agree.
