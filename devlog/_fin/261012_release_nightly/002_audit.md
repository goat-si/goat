# 002 — Roadmap audit (wp0, A)

Auditor: gpt-6.1-sol (one reviewer reused for all rounds), builder: Claude. Full texts in `evidence/audit_r1.md` … `audit_r4.md`; design lanes for the two hardest blockers in `evidence/design_ssh_r1.md`, `evidence/design_updater_r1.md`.

| Round | Verdict  | Blockers             | Disposition                                                                                                                                                                    |
| ----- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| r1    | FAIL     | 11                   | 020 §1 rewritten (job-level cancellation, per-job checkout/setup, CLI→desktop graph, gate); 010 §7 guard rules; 030 A and B2 replaced by design-lane text; 020 §5–§7 rewritten |
| r2    | FAIL     | 4 unresolved + 1 new | downstream `if` rule; SshRemoteDispatch consumers; mutex rewritten (symlink + serialized recovery); builder payload hook; env binding table                                    |
| r3    | FAIL     | 1 small + 1 new      | `host_unavailable`; report contract bound to distributable artifacts with recorded DMG transform                                                                               |
| r4    | **PASS** | 0                    | —                                                                                                                                                                              |

Accepted residual risks (carried to wp3/wp4 D): running WSL postpones automatic restart; probe→stop race without server draining; legacy runtimes without the activity endpoint remain pending; a crashed recovery lock needs manual removal; older clients ignore the remote mutex (bootstrap quits both old apps first); the pre-push guard is advisory, hard enforcement is GitHub-side (user task).
