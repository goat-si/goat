# 065 — Cycle 6 record (closes goalplan wp6) and unit summary

Commit `96c828db0`: 11 MCP identity strings say GOAT. Audit 01a12812 FAIL→PASS (possessive strings), review 01a12813 PASS. Receipt: server 33+88, acp 66, opencode 51; tsc 3 packages.

## Unit result (branch codex/goat-release-rename, local only, base dfd768cb5)

- fe8df0d3a fix(ssh): GOAT runtimes via local gh from goat-si/goat
- f08a410af feat(mcp): goat_* tools, server GOAT
- cd1dfd752 feat(mcp): provider key goat
- 852ebfb51 feat(cli): goat executable, ~/.goat on SSH hosts
- 6c38060e0 docs(remote): SSH guide
- 96c828db0 fix(mcp): GOAT MCP error strings

## Residuals / follow-ups

- Claude (claudeAgent) on SSH-launched macOS hosts: keychain not readable in SSH sessions → "Not logged in" (pre-existing; needs token-based auth or another provider).
- Anonymous release consumers (t3 update, pinned runtime, installers, mobile) cannot read the private repo (D4).
- No goat-si/goat release exists; live gh success path unobserved; publishing needs authorization.
- OpenCode own-thread wildcard overlap for readable ids ≤ 56 (pre-existing).
- Product brand text in provider instructions still says "T3 Code"; model manifest still from upstream raw URL.
- The user's running dev app (t3code-lanes/ssh-dispatch-goat) still runs the old build; restart it on this branch to use the changes.
- A GOAT server keeps running on juns-macbook-pro from ~/.goat (pid recorded in evidence/wp5-probe.txt).
- `git fetch` of the lane branch into the goat clone also copied upstream tags locally (not pushed).
