# 002 — Architect consultation

Architect gpt-6.1-sol 01a12885-294a (read-only) reviewed 000/001; returned A1–A6.

| ID    | Verdict                   | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 D1 | AMEND                     | Accept: verify candidate runs and reports the expected version before publish; never remove a version dir the old runner uses (install into staging, publish by rename); stale-forward cleanup closes only the local forward; server dispatch (leaveRemoteServerRunning) never stops the shared server on disconnect either; add competing-client + pairing/MCP failure tests.                                                                                         |
| A2 D2 | AMEND                     | Accept: bundled archives require canonical sidecars and version = packaged server version, rejected before install when incomplete/mismatched; reuse the WSL linux archive instead of duplicating it on Windows; record app size; release DAG uploads before cross-platform downloads (release.yml caller DAG); release workflows disabled → validated by tests + packaging smoke only (limitation recorded); dev archive destination uses dev-runner home precedence. |
| A3 D3 | AMEND                     | Accept: keep the Electron runtime name (Safe Storage key) unchanged so saved SSH secrets stay decryptable; change bundle id, product name, artifact prefix and Electron profile dir; URL handler collision noted; passkey provisioning opt-in.                                                                                                                                                                                                                         |
| A4 D4 | AMEND                     | Accept: gate the retained-ready early return on protocol compatibility; check the live server descriptor, not only files; secondary clients (keepExistingRunner) never upgrade a shared server; missing signals → exact-version only.                                                                                                                                                                                                                                  |
| A5 D5 | AMEND                     | Accept: push the reviewed branch, require goat-ci green on that SHA, fast-forward dev only if dev is an ancestor (never force); keep the previous app for rollback; replace only the dev desktop we spawned. Destination authority: user said "푸시해" for this work; branch push + dev fast-forward recorded as the interpretation and reported.                                                                                                                      |
| A6 D9 | recommend ~/.goat/desktop | Accept: packaged GOAT desktop home = ~/.goat/desktop (SSH-host state stays ~/.goat); one-time snapshot import like migrate-dev-db (no pending work, schedules, outbox, auth sessions, runtime/PID files) from an explicitly chosen source; source bytes untouched. User's import choice pending (asked).                                                                                                                                                               |

Reflection: requested after writers finish.

- Reflection 1: MISALIGNED (010 disconnect/version dir, 020 dedupe/size, 030 import filter, 050 rollback/credentials/version sync/cold host/incompat). Folded at the end of each doc.
- Reflection 2: MISALIGNED (050 app name with V=0.0.45). Folded: install /Applications/GOAT.app. All reflection gaps resolved.

## Audit 1 (01a12892) — FAIL; dispositions

1–3 (010 shell `$$`, non-owner disconnect, expected version): folded into 010 by amender 01a1289x before re-audit.
4–5 (030 home ~/.goat/desktop, filtered import): folded at wp3 P (030 re-written against post-wp2 source); recorded here so wp3 cannot start without them.
6 (040 integration with 010 staging): 040 is rewritten at wp4 P against post-010/020 source (stage → validate → protocol guard → publish across launch/pairing/MCP).
7 (020 WSLENV suffix cleanup): folded at wp2 P.
8–9 (050 steps/push policy): folded now.
