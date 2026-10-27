# 000 — Make GOAT SSH dispatch usable now

Reader summary: the new build launched as a dev desktop asked gh for goat-si/goat v44.4.5 because unpackaged Electron reports its own version; the desktop SSH runner must use the server package version (0.0.45) when not packaged. After that, the new app (state copied from the lane .t3) should connect to juns-macbook-pro and dispatch works with codex/claude-opus-5-5. Claude itself needs the user to re-login (expired OAuth on this Mac).

Loop spec: satisfy-spec, single cycle (C2). Trigger: user "너가 좀 되게해놔 임시라도". Goal: working dispatch now. Non-goals: kill user's old app, release, push. Verifier: cd apps/desktop && vp test run <new test>; tsc apps/desktop; live log shows ensure-ssh-environment success + probe completion. Stop: committed + review PASS + live evidence. Outcomes: DONE / NEEDS_HUMAN. Escalation: anything requiring user credentials.

## Diff (apps/desktop)

NEW apps/desktop/src/ssh/desktopSshCliRunner.ts — export resolveDesktopSshCliRunner(environment, archiveOptions, serverPackage) with archiveVersion = environment.isPackaged ? environment.appVersion : serverPackage.version (dev source-checkout path unchanged).
MODIFY apps/desktop/src/main.ts — import and use it (remove local function).
NEW apps/desktop/src/ssh/desktopSshCliRunner.test.ts — packaged uses appVersion; unpackaged uses server version even when appVersion is Electron's 44.4.5; dev remote entry path keeps node runner.

## Claude SSH prep (no code)

~/.goat/claude-home holds copies of ~/.claude/settings.json, ~/.claude.json and the keychain credentials (0600). Set the remote GOAT claudeAgent homePath to it once the user re-logs in and the credentials are recopied.
