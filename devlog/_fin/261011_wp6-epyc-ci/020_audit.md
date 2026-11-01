# wp6 audit (auditor: Hume, gpt-6.1-sol)

Raw verdict: FAIL (1 BLOCKER, 3 FIX, 2 NOTE). All findings are resolved in-plan below; B implements against 000 + 010 + this file (this file wins).

## Findings and resolutions

1. BLOCKER: registration stdin framing depends on sudo auth state (cached credentials or NOPASSWD would let the password line reach the token read).
   Resolution: every sudo call uses `sudo -S -k -p ""`; with a command, `-k` ignores cached credentials, so sudo always reads the password line. Immediately before each registration, preflight `ssh epyc 'sudo -n true'` must FAIL (proves no NOPASSWD rule; verified 2026-10-11 that it fails). epyc-register.v2.sh additionally validates the token line shape (nonempty, no whitespace, [A-Za-z0-9]+, length 20..64) and exits 3 without printing it if not, so a misframed password can never be sent to config.sh. Tokens are fetched fresh per runner and never touch disk/argv/env outside the runner process.

2. FIX: fresh-host prerequisites. epyc-prepare.v2.sh preflights (tarball present, ghrunner exists, neither goat dir exists, apt-get present), then installs `build-essential pkg-config libsecret-1-dev curl python3 git ca-certificates` (already-present packages are no-ops), then creates the dirs. After registration, a smoke as ghrunner with the runner HOME checks cc, c++, make, pkg-config --exists libsecret-1, curl, python3, node.

3. FIX: hook integration coverage. Tests also run through the installed shim path `.vite-hooks/_/pre-push` (via a fixture repo with core.hooksPath=.vite-hooks/_ and a real git push to a bare remote whose URL contains goat-si/goat), plus: new branch with zero remote_sha; deletion followed by a valid tip; several valid tips with exactly one gh lookup; named remote and direct URL argument forms.

4. FIX: whitespace-split traversal. Workflow enumeration moves into the Node validator using `git ls-tree -rz --name-only <sha> -- .github/workflows` with NUL parsing. The shell hook keeps remote selection, bypass, lazy single gh lookup, and the stdin record loop; it passes the disabled path list to the validator via env `GOAT_DISABLED_WORKFLOWS` (newline-separated). Validator CLI: `node .vite-hooks/goat-workflow-guard.mjs <sha> <ref>`; it reports unregistered workflows with the audited message and validates goat-ci.yml structurally. Add a quoted-filename regression (name with tab/newline ending in .yml).

5. NOTE: rollout gate. Before enabling Actions, a fresh paginated snapshot must show every one of the 18 expected upstream paths present and disabled_manually and no other active workflow; goat-ci is not yet on GitHub at that time (it appears with the first push). Capture post-enable and post-run snapshots. Single operator, sequential; no concurrent workflow edits.

6. NOTE: workflow parses with yaml@2.9.0; artifact paths match build outputs. Completion evidence stays as listed in 010 section 4.

## Effective verdict

PASS after resolutions (resolutions are mechanical, no design change). Phase B scope:

- `.github/workflows/goat-ci.yml` (handoff body + trigger diff)
- `.vite-hooks/pre-push`, `.vite-hooks/goat-workflow-guard.mjs`
- `scripts/goat-workflow-guard.test.ts`
- devlog only (not committed to goat-si/goat source): `handoff/epyc-prepare.v2.sh`, `handoff/epyc-register.v2.sh`
