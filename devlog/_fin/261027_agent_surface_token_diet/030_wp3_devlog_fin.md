# wp3: devlog/_fin

Owner lane: sol worker W-DEVLOG.

- NEW `devlog/_fin/README.md`, modeled on `devlog/_chase/_fin/README.md`.
- MOVE (git mv) the 18 finished units R4 confirmed, plus `261012_goat-unify-host-environment`
  with a superseded note (desktop keeps stable and nightly homes apart; SSH reuse landed in #1709).
- KEEP in `_plan`: `261013_goat_bot_cluster_mobile`, `261021_goatclaw_hub`, and this unit until
  its PR merges.
- FIX every `devlog/_plan/<moved unit>` reference (release runner doc and script, goat-rename
  rules, legacyT3Names comment, fork delta, hub design) and cross-tree relative links.
- FIX the dangling `261026_goat-identity-cleanup` pointer in `rules-relay.ts`.

Proof: `rg 'devlog/_plan/<moved unit>'` returns nothing; every relative Markdown link in
`devlog/` and `docs/` that points into `devlog/` resolves to an existing file; goat-rename tests
pass if their data changed.
