# wp2 record: stale agent-surface docs

Built by two sol worker lanes and a follow-up lane, then fixed in place after three review rounds.

| Round | Verdict | Findings                                                                                                                                                                                       | Resolution                                                                             |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | FAIL    | The audit flagged real CLI paths (`goat service install --no-start`, `goat storage --dry-run/--clean`, `goat cua-lease-proxy --control`); shipped provider-sync operations were still Proposed | Parser-aware checks; Proposed text cut to what remains                                 |
| 2     | FAIL    | Registry flags were taken from the whole parser; the `meta.operation` rule ignored unregistered kinds; shipped describe and help sat under Proposed                                            | Registry commands judged by `agentSurfaceInvocation`; rule limited to registered kinds |
| 3     | PASS    | None                                                                                                                                                                                           |                                                                                        |

`scripts/agent-surface/audit.ts` passed its code budget only after the CLI check moved to
`scripts/agent-surface/cliDrift.ts`.

Did not improve: the audit still checks flag names, not flag values or required arguments; the
server judges those when a call runs.
