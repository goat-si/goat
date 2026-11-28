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
- Optional fields backed by a Rust `Option` (`field?: T` in TypeScript, for example `RequestOpened.item`,
  `context`, `options`): writers omit them when absent, and the generated TypeScript types describe that
  written shape. Readers (serde and the schemas) also accept an explicit `null` there and read it as absent,
  so a validator built from the schemas is slightly looser than the TypeScript type. Optional fields backed by
  a defaulted collection (for example `Fold.steeredInputs`) accept only the collection, never `null`. Code
  that builds frames or lines must omit an absent field, not send `null`.

## Format freeze

Format v1 of `goat.jsonl` lines and `card.json` freezes at the goat2 merge where the thread store (lane A)
first writes these files; `cards.sqlite` is a cache and may change freely. Before that, contract changes
need no legacy readers. After it, persisted shapes change only additively (new optional fields, new event
types that readers skip; Rust readers use `parse_log_line`) or bump `v` with a reader for the old version.
`crates/goat2-contracts/tests/frozen_v1.rs` pins a sample log and card file, so a breaking change fails CI.
