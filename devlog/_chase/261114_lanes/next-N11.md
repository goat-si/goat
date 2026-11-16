# N11: terminal and SSH (lane record)

Lane branch: `chase/t3-261114-n11-terminal-ssh`, from origin/dev `02511156b0`, merged with origin/dev at `621e059da4` (merge `8e5d3cd774`). Lane head `8e5d3cd774e5ebc8d132376346db191f039bdda3` (fresh C4 review: APPROVE WITH NITS, P3 only) merged into the integration branch `chase/t3-261114-next` at `79b1f53bca` (draft PR [#3519](https://github.com/goat-si/goat/pull/3519)); not in dev until #3519 merges. Follow-up head `f5e6eea548c24e19f4f4734e5f3edd3fb097dcc9` (the review's nits, merged with origin/dev at `5688d26760`); follow-up f5e6eea548 merged into the integration branch at `e7b14604c2`; see Follow-up. Host pen-macbookair. Class: C4 for L27 (`93cbca3fcb`, persisted terminal log rewritten on load); the other rows are C3 or below.

## Rows

| card | upstream     | ruling              | GOAT commit  | summary                                                                        |
| ---- | ------------ | ------------------- | ------------ | ------------------------------------------------------------------------------ |
| L226 | `65716ba1d7` | C21 A               | `eb09fb2299` | fix(server): persist terminal output without rewriting all history             |
| L207 | `1721f187c6` | port (L16 retry)    | `657fbb38a2` | fix(web): clearing a running terminal keeps its screen and input modes         |
| L27  | `93cbca3fcb` | C21 A, C4           | `a4229c4d48` | fix(terminal): trimmed history no longer replays half of a control sequence    |
| L208 | `7aaf5ce21d` | port, adapted (L16) | `11a41c0dd7` | fix(ssh): a failed remote GOAT download says what failed and how to install it |
| L209 | `a5bd0ba526` | port, adapted (L16) | `dd666fcb0b` | fix(ssh): SSH setup on a host without gzip says gzip is missing                |
| L198 | `63edc304c0` | C16 A               | `959233ad2d` | fix(desktop): SSH suggestions from known_hosts keep their port                 |
| L203 | `25feac254d` | C16 A               | `29c00cf36c` | fix(ssh): an alias no longer hides known_hosts entries on other ports          |

The order follows upstream's own order (`1721f187c6` before `93cbca3fcb`), because 93cbca3fcb's client hunk extends the `clearOutput` and `textStartOffset` that 1721f187c6 adds.

Other commits:

- `255a488c60` refactor(server): move terminal history reads and test fixtures out of files at their budget. Verbatim move-out: Manager.test.ts was at its entry (2223 of 2223), and Manager.ts had 21 lines of room for about 45 new lines. `readHistoryTail` moved to terminal/terminalHistoryFile.ts and was renamed `readTerminalHistoryTail` (span name unchanged; it now takes the file system and byte limit as arguments). `openInput`, `historyLogPath`, `createManager` and `layerWithHostPlatform` moved to Manager.testkit.ts, and the two BoundedTerminalHistory unit tests with their helper moved to BoundedTerminalHistory.test.ts. The terminal suites ran the same 142 tests before and after. No scripts/lib/goat-rename rule names these files or titles (grep empty).
- `324faa07b1` refactor(ssh): move the runner's archive download and unpack steps out of tunnel.ts. Verbatim move-out: tunnel.ts was at its entry (4877 of 4877). Runner bytes unchanged; tunnel.core.test.ts still matched the baseline (132 pass).
- `1990d57165` chore(budgets): lower the code budgets of files this lane shrank.

## Decisions

- **C21 A (L226).** Saves append the output since the last save and rewrite the file when it would pass twice the byte limit, after a clear, a joined surrogate or a failed append. Opening a truncated or over-limit log compacts it through a temporary file and a rename. On a compaction failure at open, the server logs "failed to compact terminal history" and appends one line to the restored terminal output: `[GOAT] Could not shrink this terminal's saved history; it will be rewritten on the next save.` The byte cap still applies, so the line displaces the oldest bytes. The old file keeps its bytes, and the first full save of the new session rewrites it. A save failure while the terminal runs stays log-only, as before.
- **L27 (C4).** On open, the log tail's parser state is computed from the skipped bytes, and a tail that starts inside a sequence drops that sequence's remainder; the file is then rewritten to the restored text. GOAT has no `retainedTerminalHistory` (its upstream commit `c9f0caca1b` is deferred in #3176), so contracts gets only the parser helpers, and the client's `trimBufferToBytes` does the same trim.
- **L208/L209.** The download message names GOAT's installer `https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh` with `GOAT_HOME=$HOME/.goat` (added in the follow-up, 2b52ae76c1), `GOAT_VERSION` and `GOAT_RELEASE_BASE_URL`. With that home, the installer unpacks into the same `~/.goat/runtime/goat/versions/<version>` and `.install-complete` marker the runner checks (scripts/install.sh:16, :245-283); without it, the installer can choose `~/.t3` (scripts/install.sh:32-38), where the runner does not look. The gzip message is only on the `tar -xzf` branch; the win32 zip branch is unchanged and has a test that it never blames gzip. `fixtures/remote-runner-baseline.json` is regenerated in each of the two commits and again in 2b52ae76c1 (9 stored scripts embed the runner; only the changed line differs).
- **Same-version runner change (L208/L209 condition).** "does not restart an existing managed server after runtime preparation" (then tunnel.core.test.ts, the test the decision cites at :1111) was run once per commit with the persisted runner taken from the previous baseline (old bytes), and its runner-file assertion pointed at the new runner. It passed both times: one start, no stop, same PID and port, no upload, child still running, and the new runner published in place. The follow-up commits this as a test: "publishes changed runner bytes of the same version without restarting the managed server" in tunnel.managed-reuse.test.ts (bbeb656442).
- **C16 A (L198/L203).** The null-port assertions change only for bracketed entries; plain entries, including `port.example.com:22`, keep port null. Web (GOAT's ConnectionEnvironmentsSection, upstream's AddEnvironmentDialog): the suggestion value is `[host]:port` for a known_hosts entry with a port. A saved host hides such a suggestion only for that host and port, and choosing it fills the port and checks that port. A configured ssh-config alias still sends no override. The helpers are in ConnectionsSettings.logic.ts. Agents' `ssh.host_list` and SSH dispatch address hosts by alias, so the server lists and probes one entry per alias (sshRemote/sshHostAliases.ts; SshRemoteDispatch.ts is at its budget). The discovered-host contract already had `port: number | null`, so nothing on the wire changes.

## Rule 3 authorisation

The coordinator authorisation as received, verbatim:

```text
# N11 coordinator rulings (2026-11-16)

## Rule 3 authorisation (quote verbatim in next-N11.md)

Coordinator authorisation, 2026-11-16, rule 3, lane N11 (terminal and SSH). I read each upstream commit before answering. All four items are authorised, as upstream's own test edits in the commit being ported; nothing is dropped.
1. Upstream 1721f187c6 (clearing a running terminal keeps its screen and input modes). Its diff edits all four files itself: (a) packages/client-runtime/src/state/terminalSession.test.ts: the test is renamed to end "and erases on clear" and clear expects {type:"append", data: ESC[H ESC[2J ESC[3J} instead of {type:"reset", data:""}, plus upstream's added assertions; (b) apps/web/src/components/ThreadTerminalDrawer.test.ts: after clear, resetAndWrite is not called and write is last called with the erase sequence; (c) apps/web/src/terminal/ghostty/core.test.ts: the test is renamed "drops stale text in real Ghostty for a repeated snapshot, clear, restart, and a fresh attach" and expects "append" for a cleared event and "reset" otherwise, plus upstream's new test; (d) apps/mobile/src/features/terminal/NativeTerminalSurface.test.tsx: the harness renders terminalOutputReplay instead of terminalOutputText, plus upstream's added assertions. Carry each as upstream wrote it.
2. Upstream 93cbca3fcb (trimmed history no longer replays half of a control sequence), in the test "preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", wherever GOAT keeps it now: the retainedHistory helper drops the remainder of a cut control sequence, four fragments are added, and expected is recomputed from the full text. Carry upstream's edit unchanged.
3. Upstream 63edc304c0 (known_hosts suggestions keep their port), packages/ssh/src/config.test.ts: the null-to-port flips for the bracketed entries only ([bastion.example.com]:2222 becomes 2222, [ssh.example.com]:2200 becomes 2200; ruling C16), the rename parseKnownHostsHostnames to parseKnownHosts, and the expected list changing from strings to {hostname, port} objects with port null for every plain entry. The shape change is covered.
4. Upstream 7aaf5ce21d (a failed remote download says what failed), packages/ssh/src/remoteRunnerPlatform.test.ts "only downloads a release archive the host can run": the curl stub prints "curl: (6) Could not resolve host: github.com" and exits 6 instead of 22, which is upstream's own edit to the same stub in its tunnel.test.ts; the existing assertions stay and the new ones are added, with GOAT's installer and release URL in place of upstream's. fixtures/remote-runner-baseline.json is regenerated in the same commit with the reason, as the #3176 decision for L208 says.
Conditions: no existing assertion is deleted or loosened beyond what the upstream diff does; any GOAT-only test of the same behaviour that needs a different expectation is named in the record with its reason; if a test file moved, scripts/lib/goat-rename is updated in the same commit when a rule names it. No other expectation in an existing dev test may change in this lane without asking.
```

GOAT-specific differences under this authorisation:

- Item 4: GOAT's runner test downloads from `https://example.invalid/releases`, so the carried curl stub prints `curl: (6) Could not resolve host: example.invalid` (exit 6) instead of `github.com`. The test asserts that stderr contains the archive version, the release base URL and GOAT's installer URL.
- Item 2: the edited test now lives in apps/server/src/terminal/BoundedTerminalHistory.test.ts (moved verbatim in `255a488c60`).
- C21's notice line changes the expectation of upstream's own new test "persists small terminal updates without rewriting the retained history" for the failed write and rename cases: the history is the expected text plus the notice, still within the byte cap. That test is new in this lane, so no existing dev expectation changed.

## Upstream tests carried

- L226: "restores bounded history across append compaction, clears and split Unicode" (BoundedTerminalHistory.test.ts); "persists small terminal updates without rewriting the retained history" and "rewrites history after an append fails partway through" (Manager.history.test.ts, new, since Manager.test.ts is at its budget).
- L207: all four upstream test files, as authorised.
- L27: the edited property test and "does not retain the tail of a control sequence whose introducer was trimmed" (BoundedTerminalHistory.test.ts), "restores a log tail that starts inside a control sequence without its remainder" (Manager.history.test.ts), and the client-runtime test of the same name (terminalSession.test.ts).
- L208: the download assertions, in remoteRunnerPlatform.test.ts (GOAT's counterpart of upstream's runner test).
- L209: "names gzip when a host with tar but no gzip cannot unpack the release archive" in remoteRunnerPlatform.test.ts. Upstream's version needs GNU tar shelling out to gzip, which bsdtar on macOS cannot reproduce, so tar is a stub that fails the way GNU tar does, on a PATH without gzip. Added: the gzip-present case and the Windows zip case.
- L198/L203: config.test.ts as upstream, plus a browser test (a known_hosts suggestion on port 2223 is checked on 2223), a logic test for the saved-host filter, and a dispatch test (one listing and one probe per alias).

## C4 cases (L27)

- Old log: a log an older server left within the limit is read as is and not rewritten (no write or rename to its path).
- Truncated log: a tail that starts inside an OSC sequence is restored without the remainder and the file is rewritten to it (three cases, upstream's test).
- Negative, compaction fails: rename fails on a truncated log starting inside a sequence; the file keeps its original bytes, the directory holds one file, and the terminal shows the end of the notice line.
- Unreadable log: open of the log fails with PermissionDenied; the terminal open fails and the file is left in place with its bytes.
- Older client against this server: no wire schema change; it receives history that no longer starts mid-sequence. Older server against a log this server wrote: the file is plain text up to twice the byte limit, and older servers read its last `historyByteLimit` bytes and compact it as before.
- Atomicity (N11-P3-5): only the compaction on open is atomic (temporary file and rename). Full rewrites in the save worker (first save of a session; after clear, restart or close; after a joined surrogate pair or a failed append; and when the file would pass twice the limit) truncate and write the real path in place, as on dev and upstream. A crash during one can leave the log empty or partial. Dev did this on every 250 ms save, so the lane reduces the risk without removing it. A temp-file-and-rename full save would be a follow-up.

## Fail-first (code before each fix)

- L226: 3 failed. `TypeError: history.persistenceUpdate is not a function`; `expected 1114112 to be less than 131072` (bytes written for 80 KiB of output); `expected true to be false` (a partly failed append was never retried).
- L207: client-runtime `expected { type: 'reset', data: '', …(1) } to match object { type: 'append', …(1) }`; mobile `TypeError: terminalOutputReplay is not a function`; web `expected "vi.fn()" to not be called at all` (resetAndWrite), `expected 'reset' to be 'append'`, and `expected { alternateScreen: false, …(3) } to deeply equal { alternateScreen: true, …(3) }`.
- L27 (with the contracts helpers present, trimming at HEAD): server `expected '[0m' to be ''`, `expected '[31mOK' to be 'OK'`, `expected '0;x\u0007ABCD' to be 'ABCD'`; client `expected '[31mOK' to be 'OK'`.
- L208: `expected 'download attempt\ncurl: (6) Could not…' to include '1.2.3-preview.20260911.4'`.
- L209: `expected 'tar (child): gzip: Cannot exec: No su…' to match /(missing|needs) gzip/` (the gzip-present and Windows cases pass before and after).
- L198: ssh `expected [ '100.64.0.1 null', …(1) ] to deeply equal [ '100.64.0.1 2222', …(2) ]`, the bastion port, and `parseKnownHosts is not a function`; web preflight called with `{ host: '100.64.0.1' }` without `port: 2223`; dispatch `expected [ Array(2) ] to deeply equal [ 'ssh:box.example' ]`.
- L203: `expected [ 'box null', 'fixture null', …(1) ] to deeply equal [ '192.0.2.10 2222', …(4) ]`.

## Gate

- `8e5d3cd774` (pen-macbookair, after merging origin/dev at 621e059da4): `node scripts/goat-rename.ts --check` 0; `node scripts/agent-surface/audit.ts --check` 0; `node scripts/agent-surface/context-budget.ts --check` 0.
- `set -o pipefail; vp run check:changed` exit 1: format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget and typecheck (39 packages) pass; test 261 files, 7674 passed, 46 failed, 3 skipped. All 46 failures are known host failures that also fail with dev's code on this Mac:
  - goat#3479: 44 in apps/server/src/sshRemote/SshWorkspaceSync.test.ts (`git init` exits 127 through the `$HOME` git shim; same 44 failed with the lane's changes stashed).
  - goat#3418: packages/ssh/src/tunnel.client-session.test.ts "passes quoted values unchanged through the real runner and shell" ("Remote host is missing node on PATH"; also fails with dev's tunnel.ts, baseline and config.ts).
  - goat#3363: packages/ssh/src/runtimeFactsScripts.test.ts "reads a built runner in one call…" (also fails with the lane's changes stashed).
- One stray earlier `vp test run` of packages/ssh (my own, PID 30876, cwd this worktree, started by this lane) survived Ctrl-C and was stopped by those PIDs (30876, 30879, 30884). No other process was touched.
- origin/dev moved to cd58feb46e after the gate; not merged.

## Surfaces

- Terminal: the server persists and restores history for every client. Clear is in the client-runtime reducer used by web, desktop (wraps web) and mobile. The mobile native surface gets the replay; the text fallback gets display text.
- SSH: the runner messages show wherever an SSH setup error is shown (Connections row, preflight, agents' SSH tools through the same runner). The known_hosts port shows in desktop's Add device SSH suggestions (web UI over the desktop bridge); agents see one host per alias in `ssh.host_list`.
- Providers: none provider-specific.
- Real client: not run (see NOT RUN). No captures were taken, so none are waiting in /tmp.

Owed to #3519's integrated pass, by surface:

- Web and desktop: clear in a running TUI (vim or htop) keeps alternate screen and mouse modes; the Add device suggestion for a `[host]:port` known_hosts entry fills that port and checks it; the Connections row shows both setup messages (download failure with the installer advice, and gzip missing).
- Mobile: clear on the native terminal and on the text fallback.
- All surfaces: the compaction notice line, if it can be triggered.

## Code budgets

`git diff origin/dev -- oxlint-plugin-goat/code-budgets.json` lowers only files this lane changed: terminal/Manager.test.ts 2223 → 2019, terminal/Manager.ts 3225 → 3217, ssh/tunnel.ts 4877 → 4870, sshRemote/SshRemoteDispatch.ts 2054 → 2053, ConnectionEnvironmentsSection.tsx 1914 → 1889 (non-null 3 → 2), ConnectionEnvironmentsSection.browser.test.tsx 1101 → 1031. No entry raised. New files: terminalHistoryFile.ts, Manager.history.test.ts, BoundedTerminalHistory.test.ts, remoteArchiveScripts.ts, sshHostAliases.ts, all under 300 lines.

## Known limits

- The compaction notice is saved with the history (N11-P3-1). It shows again on later opens until the scrollback rolls it out, even after a rewrite succeeded, and each further failed open adds one more copy within the byte cap.
- Compaction on open now runs on a common path (N11-P3-4). A terminal that printed more than the limit since its last full save is compacted on its next open: up to twice the limit is read (16 MiB by default) and one compacted copy is written (up to 8 MiB), once per open. A crash in that window leaves a `.history-*` directory of up to 8 MiB that nothing removes, and a failed removal of that directory fails the open instead of showing the notice: goat#3538.
- A client that attaches after a clear (N11-P3-6), for example after a reload or on a second device, starts from the server's emptied history, so it shows a running TUI without its alternate-screen and mouse modes until the program redraws. Same as dev and upstream; the L207 fix is client-side.
- Outside this lane's diff: the server's history sanitizer keeps an unterminated control sequence with no length cap (`pendingHistoryControlSequence`). Measured on this Mac: 64 MiB pending after 64 MiB of an unterminated OSC, about 437 MiB more RSS, and quadratic time per chunk: goat#3539.
- The compaction notice covers compaction on open. A failed save while the terminal runs is logged only, as before.
- If restored history ends inside an open control sequence, the terminal may swallow the notice line that follows it.
- A client that receives a snapshot that already starts mid-sequence from an older server cannot detect it; only cuts the client or this server makes are tracked.
- The tar error captured on failure is printed only when gzip is present; a host missing both tar and gzip is told about gzip.
- SSH dispatch and `ssh.host_list` still reach a host by alias on its configured or default port; a known_hosts entry only on another port is listed but dialed as before.

## Follow-up (review of 8e5d3cd774)

Coordinator rulings: /Users/jun/handoff-in/chase/next-N11-coordinator-rulings.md (section "Review verdict and follow-up"); report: next-N11-review-8e5d3cd7.md. One commit per code or test item on top of 8e5d3cd774, then origin/dev merged last. Follow-up f5e6eea548 merged into the integration branch at `e7b14604c2` (which carries dev through `5688d26760`).

| item     | commit       | change                                                                                                                                                                            |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N11-P3-3 | `27bf56a860` | test(ssh): verbatim move-out of "does not restart an existing managed server after runtime preparation" to tunnel.managed-reuse.test.ts (tunnel.core.test.ts had 3 lines of room) |
| N11-P3-3 | `bbeb656442` | test(ssh): a second case saves a runner with one changed line and expects one start, no stop, the same PID and port, no upload, and the new runner on disk                        |
| N11-P3-2 | `2b52ae76c1` | fix(ssh): the download advice suggests `GOAT_HOME=$HOME/.goat`; baseline fixture regenerated (only that message line differs in its 9 scripts)                                    |
| N11-P3-7 | `21d159512a` | test(web): the known_hosts port suggestion test's last checks run in `vi.waitFor`; entry 1031 → 1029                                                                              |
|          | `c6293c9374` | chore(budgets): tunnel.core.test.ts 3012 → 2889 after the move-out                                                                                                                |
|          | `f5e6eea548` | merge of origin/dev `5688d26760` (no file of this lane changed on dev)                                                                                                            |

- P3-3 move: the test keeps its full title (same "runtime preparation" describe, skipped on win32, same fetch stubs). No scripts/lib/goat-rename rule names tunnel.core.test.ts or the title, so TEST_TITLES is unchanged. tunnel.core.test.ts runs 131 tests after the move (132 before) and the new file 1. P3-3 case: the existing case keeps its title and still saves the current runner, so its final file check compares the same bytes as before (`persistedRunner` was built from the same baseline string, now `currentRunner`). The fake CLI's script text is byte-identical; only the code around it is re-indented. Rule 3: no existing expectation changed. The P3-2 assertion was added to an existing test because the rulings ask for it ("assert the message contains it").
- Fail-first, P3-2: `expected 'download attempt\ncurl: (6) Could not…' to include 'GOAT_HOME=$HOME/.goat'` (1 failed, 4 passed). P3-3 and P3-7 change tests only; the new case passes on the code, as the review predicted.
- P3-1, P3-4, P3-5 and P3-6 are recorded under Known limits and C4 cases. Issues: goat#3538 (stray `.history-*` directories, and a failed removal fails the open) and goat#3539 (unbounded `pendingHistoryControlSequence`, verified with a probe: 64 MiB of an unterminated OSC gave 64 MiB pending, about 437 MiB more RSS, 0.27 ms → 5.6 ms per 64 KiB chunk, 4.0 s total, then 67,108,874 characters released at BEL).
- Checks on f5e6eea548 (focused, touched files only): `node scripts/goat-rename.ts --check` 0; lint of the touched files clean; `vp run typecheck` in packages/ssh 0 and in apps/web 0 (on 21d159512a); remoteRunnerPlatform.test.ts, tunnel.managed-reuse.test.ts and tunnel.core.test.ts 138 passed; ConnectionEnvironmentsSection.browser.test.tsx 25 passed.
- Budgets after the follow-up: tunnel.core.test.ts 3012 → 2889, ConnectionEnvironmentsSection.browser.test.tsx 1031 → 1029; new file tunnel.managed-reuse.test.ts at 162 lines. No entry raised.

## NOT RUN

- Real-client pass (test-goat-app) for terminal clear in a running TUI and for the Add device SSH suggestions; covered by the Ghostty core tests (real Ghostty) and the ConnectionEnvironmentsSection browser test.
- Mobile device pass for the native terminal replay (the unit test covers older binaries).
- A real remote host without gzip or without network; covered by the runner script tests on a stubbed PATH.
- Full suite (`ci:full`).
- `vp run check:changed` on the follow-up head: other lanes' vitest runs were active on pen-macbookair (N6 and another lane's server tests), so only the touched files were run.

## N11b: terminal cap (goat#3539)

Branch `chase/t3-261114-n11b-terminal-cap`, from the integration branch `chase/t3-261114-next` at `e7b14604c2` (coordinator decision: a server buffer without a limit is forbidden by docs/internals/server-resilience.md, "Every buffer the server holds has a bound"). Head `24e0d39ad7a454af7c4cdbf147e726c5a5c79529`, pushed, not merged yet; a fresh narrow review is due. Host pen-macbookair. goat#3538 stays an issue only.

| commit       | change                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `417bf95ef6` | fix(server): an unterminated control sequence no longer grows the terminal history buffer without limit (goat#3539)   |
| `24e0d39ad7` | fix(server): a terminal sequence past the history cap is swallowed to its end instead of replayed as text (goat#3539) |

The coordinator ruling on 417bf95ef6, verbatim:

```text
Coordinator ruling, 2026-11-16, lane N11b (goat#3539), on 417bf95ef6: the cap is right, the recovery is not yet. Not merged; one more commit, then READY, then a fresh narrow review (this is new parser code on untrusted terminal output).
Problem: past the cap the code drops what it held and returns to ground state, so the REST of that sequence's payload becomes visible history text. Real programs send sequences larger than 1 MiB of UTF-16 units in one piece (an iTerm2 inline image through OSC 1337 File=, a sixel picture in a DCS, a large OSC 52 copy); after this change a reconnect or a second device would replay up to the history cap of base64 or sixel bytes as text in the scrollback, where dev replays the picture or nothing. The Known limit you recorded is that defect.
Required: (1) the server holds at most the cap plus one chunk for an unfinished sequence (as now); (2) once a sequence passes the cap, the remainder of THAT sequence, up to the terminator the sanitizer already recognises for its kind (BEL or ST for OSC; ST for DCS, APC, PM, SOS; the final byte for CSI; and whatever the sanitizer treats as a restart or abort), is swallowed: it is emitted neither as visible text nor as a truncated sequence; the state kept while swallowing is O(1) (the kind of sequence and, if needed, a possible ESC before a backslash split across chunks), never the payload; (3) after the terminator, text and sequences are kept again exactly as before; (4) a sequence that never terminates swallows what follows, as a terminal in string state shows nothing either; say so in the record. If the session's pending state must change shape for this (a flag beside the string), keep it server-internal and in a GOAT-owned module where it fits; upstream's sanitizer body stays as it is.
Tests first, deterministic: an over-cap OSC, DCS and CSI each followed by its terminator and then "after": history holds the text before and "after", nothing of the payload, and the pending state is empty; the terminator split across two chunks (ESC at the end of one, backslash at the start of the next); an over-cap sequence followed by a second ESC that starts a new sequence; a sequence exactly at the cap is still kept whole (the existing 64 KiB OSC 52 and DCS test keeps passing); the 64 MiB probe again for memory. The comment on the constant must not claim the cap is above every real payload: say what happens to a larger one (history drops it; the live terminal already drew it).
```

- Upstream: pingdotgg/t3code main at `dfeaf7b137` has the same sanitizer (apps/server/src/terminal/Manager.ts:1374) with no cap, and no commit since `93cbca3fcb` touches it (`git log -S pendingControlSequence` and a message search are empty). Nothing to port; this is a GOAT fix.
- Cap: `MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH` (1 MiB of UTF-16 code units) in apps/server/src/terminal/terminalHistoryReplay.ts, a GOAT module (upstream keeps the sanitizer in Manager.ts). The server holds at most the cap plus one chunk for an unfinished sequence. A sequence exactly at the cap is kept whole; the existing 64 KiB OSC 52 and DCS test still passes. The constant's comment says what happens to a longer sequence: history leaves it out whole, since the live terminal already drew it.
- Swallowing (24e0d39ad7): once a sequence passes the cap, the rest of it is swallowed up to the end the sanitizer already recognises for its kind:
  - OSC: `findStringEnd` (BEL, ST, CAN/SUB, or an ESC that starts the next sequence).
  - DCS, PM and APC: `findStringEnd` (ST, CAN/SUB, an ESC that starts the next sequence, or a C1 control code point). SOS is not a string in this sanitizer (`ESC X` is a plain escape), so it ends like one.
  - CSI: the same ends as the CSI loop (final byte, CAN/SUB, an ESC that starts the next sequence, or a C1 control).
  - Plain escape: its final byte, or the first byte that is not an intermediate.
- What is emitted: nothing of the swallowed part, neither text nor a truncated sequence. A C1 control that ends it keeps the effect upstream keeps (`c1Effect`'s replayable effect and the sequence it starts). After the end, text and sequences are kept exactly as before.
- State while swallowing: the marker `swallowing:`, the kind, and at most one code unit split across chunks (an ESC that may begin ST, or a high surrogate that may begin a C1 code point). It is never the payload. It stays in the session's existing pending string. A held unfinished sequence always starts with ESC, so the marker cannot be confused with one, and Manager.ts and its resets to `""` are unchanged.
- Upstream's sanitizer body (now the private `sanitizeChunk`) is byte-identical to the integration branch's; only its header was renamed in 417bf95ef6.
- A sequence that never terminates swallows everything after it, as a terminal in string state shows nothing either. History stays as it was before the sequence until a terminator arrives or the terminal is cleared or restarted (both reset the pending state).
- Client: no matching buffer. client-runtime keeps only a parser state number for cut sequences (packages/client-runtime/src/state/terminalOutput.ts:21, `sequenceState`), so no client cap is needed.
- server-resilience.md: unchanged. It already states the rule, and the named constant shows this bound.
- Fail-first, 417bf95ef6 (only the constant present): 3 failed, `expected 1048580 to be less than or equal to 1048576`, `expected 1048579 …`, `expected 1048578 …`.
- Fail-first, 24e0d39ad7 (the new tests in terminalHistoryReplay.test.ts, on head 417bf95ef6): 8 failed, 14 passed.
  - "swallows the rest of an OSC ended by BEL / an OSC ended by ST / a DCS ended by ST / a CSI ended by its final byte past the pending cap, then keeps what follows": `expected 'beforeQUJDQUJD…' to be 'beforeafter\n'` (DCS `'before#0;2;0;0;0~…'`, CSI `'before1;1;1;…'`).
  - "ends a swallowed OSC / DCS at an ST split across chunks": `expected 'beforeQUJD\u001b\after\n' to be 'beforeafter\n'` (DCS `'before#0;2;0;0;0~\u001b\after\n'`).
  - "keeps the sequence that an ESC starts after a swallowed one, also across chunks": `expected 'QUJD\u001b[31mred\n??\u001b[0mplain\n' to be '\u001b[31mred\n\u001b[0mplain\n'`.
  - "swallows everything after a sequence that never terminates, as a terminal shows nothing": `expected 'beforexxxx…' to be 'before'`.
  - "keeps a sequence exactly at the pending cap whole" passed before and after.
  - The earlier N11b test, which expected "after" to be kept after a sequence that never ended, is replaced. It was this lane's own unmerged test, so rule 3 does not apply.
- Probe (/tmp/n11-probe/pending64.mts, 64 MiB of an unterminated OSC in 64 KiB chunks):
  - dev: 64 MiB pending, RSS 198 → 635 MiB, 0.27 → 5.6 ms per chunk, 4.0 s, then 67,108,874 characters released at BEL.
  - 417bf95ef6: no pending, 66,060,288 payload characters kept as text.
  - 24e0d39ad7: nothing visible while open, the held state is a few characters, RSS 197 → 207 MiB, 0.17 ms per chunk, 177 ms in total, and only "after" kept after BEL.
- Rule 3: no existing dev expectation changed.
- Checks on 24e0d39ad7: `vp test run src/terminal/` 159 passed (13 files); terminalHistoryReplay.test.ts 22 passed; `vp run typecheck` in apps/server 0; lint of the two files clean; `node scripts/goat-rename.ts --check` 0 (no test file moved).
- NOT RUN: `vp run check:changed` (lane N6 holds the heavy slot on pen-macbookair); a real-client pass (an inline image or sixel over 1 MiB in a GOAT terminal, then a reload); `ci:full`.
