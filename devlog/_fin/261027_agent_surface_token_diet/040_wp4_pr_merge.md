# wp4: PR and merge

- Commit per work phase; push `codex/agent-surface-token-diet`.
- PR to `dev`: title `chore(agent-surface): outside clients list core tools; stale docs and finished plans tidied`
  or similar; body states the problem (outside clients pay ~210 KB per listing), the fix, the
  measurement, the docs and devlog moves, and ends with the model and harness. No UI change, so no
  screenshot.
- Wait for `goat-ci-result` on the exact head; fix real failures; then
  `gh pr merge <pr> --admin --squash --match-head-commit <sha>`.
- Record with `cxc loop pr-record`.
