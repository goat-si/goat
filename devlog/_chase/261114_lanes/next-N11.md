# N11: terminal and SSH (lane record)

Lane branch: `chase/t3-261114-n11-terminal-ssh`, from origin/dev `02511156b0`, merged with origin/dev at `621e059da4` (merge `8e5d3cd774`). Lane head `8e5d3cd774e5ebc8d132376346db191f039bdda3`, pushed. Not merged anywhere yet; the coordinator merges reviewed lane heads into `chase/t3-261114-next`. Host pen-macbookair. Class: C4 for L27 (`93cbca3fcb`, persisted terminal log rewritten on load); the other rows are C3 or below.

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

- `255a488c60` refactor(server): move terminal history reads and test fixtures out of files at their budget. Verbatim move-out: Manager.test.ts was at its entry (2223 of 2223), and Manager.ts had 21 lines of room for about 45 new lines. `readHistoryTail` moved to terminal/terminalHistoryFile.ts (now taking the file system and byte limit as arguments), `openInput`, `historyLogPath` and `createManager` moved to Manager.testkit.ts, and the two BoundedTerminalHistory unit tests with their helper moved to BoundedTerminalHistory.test.ts. The terminal suites ran the same 142 tests before and after. No scripts/lib/goat-rename rule names these files or titles (grep empty).
- `324faa07b1` refactor(ssh): move the runner's archive download and unpack steps out of tunnel.ts. Verbatim move-out: tunnel.ts was at its entry (4877 of 4877). Runner bytes unchanged; tunnel.core.test.ts still matched the baseline (132 pass).
- `1990d57165` chore(budgets): lower the code budgets of files this lane shrank.

## Decisions

- **C21 A (L226).** Saves append the output since the last save and rewrite the file when it would pass twice the byte limit, after a clear, a joined surrogate or a failed append. Opening a truncated or over-limit log compacts it through a temporary file and a rename. On a compaction failure at open, the server logs "failed to compact terminal history" and appends one line to the restored terminal output: `[GOAT] Could not shrink this terminal's saved history; it will be rewritten on the next save.` The byte cap still applies, so the line displaces the oldest bytes. The old file keeps its bytes, and the first full save of the new session rewrites it. A save failure while the terminal runs stays log-only, as before.
- **L27 (C4).** On open, the log tail's parser state is computed from the skipped bytes, and a tail that starts inside a sequence drops that sequence's remainder; the file is then rewritten to the restored text. GOAT has no `retainedTerminalHistory` (its upstream commit `c9f0caca1b` is deferred in #3176), so contracts gets only the parser helpers, and the client's `trimBufferToBytes` does the same trim.
- **L208/L209.** The download message names GOAT's installer `https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh` with `GOAT_VERSION` and `GOAT_RELEASE_BASE_URL`. That installer unpacks into the same `~/.goat/runtime/goat/versions/<version>` and `.install-complete` marker the runner checks (scripts/install.sh:16, :245-283). The gzip message is only on the `tar -xzf` branch; the win32 zip branch is unchanged and has a test that it never blames gzip. `fixtures/remote-runner-baseline.json` is regenerated in each of the two commits (9 stored scripts embed the runner; only the changed branch differs).
- **Same-version runner change (L208/L209 condition).** "does not restart an existing managed server after runtime preparation" (tunnel.core.test.ts, the test the decision cites at :1111) was run once per commit with the persisted runner taken from the previous baseline (old bytes), and its runner-file assertion pointed at the new runner. It passed both times: one start, no stop, same PID and port, no upload, child still running, and the new runner published in place. The edit was temporary; logs in /tmp/n11-proof-same-version-no-restart.log and /tmp/n11-proof-same-version-no-restart-gzip.log.
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

## Code budgets

`git diff origin/dev -- oxlint-plugin-goat/code-budgets.json` lowers only files this lane changed: terminal/Manager.test.ts 2223 → 2019, terminal/Manager.ts 3225 → 3217, ssh/tunnel.ts 4877 → 4870, sshRemote/SshRemoteDispatch.ts 2054 → 2053, ConnectionEnvironmentsSection.tsx 1914 → 1889 (non-null 3 → 2), ConnectionEnvironmentsSection.browser.test.tsx 1101 → 1031. No entry raised. New files: terminalHistoryFile.ts, Manager.history.test.ts, BoundedTerminalHistory.test.ts, remoteArchiveScripts.ts, sshHostAliases.ts, all under 300 lines.

## Known limits

- The compaction notice covers compaction on open. A failed save while the terminal runs is logged only, as before.
- If restored history ends inside an open control sequence, the terminal may swallow the notice line that follows it.
- A client that receives a snapshot that already starts mid-sequence from an older server cannot detect it; only cuts the client or this server makes are tracked.
- The tar error captured on failure is printed only when gzip is present; a host missing both tar and gzip is told about gzip.
- SSH dispatch and `ssh.host_list` still reach a host by alias on its configured or default port; a known_hosts entry only on another port is listed but dialed as before.

## NOT RUN

- Real-client pass (test-goat-app) for terminal clear in a running TUI and for the Add device SSH suggestions; covered by the Ghostty core tests (real Ghostty) and the ConnectionEnvironmentsSection browser test.
- Mobile device pass for the native terminal replay (the unit test covers older binaries).
- A real remote host without gzip or without network; covered by the runner script tests on a stubbed PATH.
- Full suite (`ci:full`).
