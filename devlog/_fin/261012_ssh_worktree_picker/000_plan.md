# 000 SSH worktree picker: plan

The composer workspace chip is hard to read: with several environments it shows only the machine
name, a new draft can silently inherit the previous draft's worktree mode, and "Previous worktree"
adds a third choice users do not need. This unit makes Local the plain default, labels the chip by
workspace mode, removes Previous worktree, and adds "Worktree on SSH": the local server snapshots
the project (HEAD plus uncommitted tracked and untracked changes, untracked gitignored files excluded), pushes
it over SSH into ~/.goat/repos on a saved SSH host, and starts a thread there in a new worktree that
the remote T3 owns. A fetch-back action brings that thread's branch home over SSH.

## Loop spec

- Archetype: satisfy-spec, multi-cycle (wp0 docs-first, then wp1-wp5).
- Trigger: user request on 2026-10-12, "6.1 sol 무제한 파견하면서 cxc-loop 로 구현 완료해서 dev에 머지까지해봐 pr 여러개 쌓고",
  after an Interview in the same thread (answers below).
- Goal: the four layers below merged into dev through a stacked PR chain, each layer reviewed and CI green.
- Non-goals: password SSH auth, rsync of ignored files (.env etc.), mobile SSH-worktree UI, browser-only SSH
  transport, persisted operation receipts, main/preview, releases, upstream t3code, other goat lanes.
- Verifier: per decade doc; shared floor is `vp test run <touched test files>`, targeted
  `vp run --filter <pkg> typecheck`, `vp lint <changed files>`, then hosted goat-ci (check, typecheck,
  test, build) on the exact PR head.
- Stop condition: goalplan criteria c-1..c-7 (.codexclaw/goalplans, mirrored in the goal objective) met, or NEEDS_HUMAN recorded.
- Memory artifact: this directory; scratch evidence in /tmp/ssh-wt.
- Terminal outcomes: DONE; NEEDS_HUMAN (merge blocked by an owner-only policy); UNSAFE (a push would carry
  a credential file); BLOCKED (repeated identical CI infrastructure failure).
- Authority: the user authorized subagent dispatch (gpt-6.1-sol, unbounded), pushes, PR creation and merging into
  dev. Resource bounds: none stated; host limits apply. Recording the unit under devlog/_plan follows the fork's
  convention (see 261011_goat_ci_speedup), a task-specific override of AGENTS.md's default against committing plans.

## Interview answers (2026-10-12, this thread)

| ID   | Question                    | Answer                                                                                                                                                |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-u1 | Default for new threads     | Always Local; label clearly                                                                                                                           |
| D-u2 | Chip label                  | Local / New worktree / Worktree · host instead of the machine name                                                                                    |
| D-u3 | Previous worktree           | Remove                                                                                                                                                |
| D-u4 | Who owns an SSH thread      | The remote T3 (existing goat_ssh_thread_launch path)                                                                                                  |
| D-u5 | How code reaches the remote | Local state copied into the remote ~/.goat (user wanted rsync-like; agreed on git push) with commits plus uncommitted changes, ignored files excluded |
| D-u6 | How results return          | Fetch the remote branch to the local repo over SSH                                                                                                    |
| D-u7 | Hosts in the submenu        | Only hosts saved in Settings → Connections                                                                                                            |

## Consultation

Explorers (gpt-6.1-sol): web/mobile map /tmp/ssh-wt/E1-web.md, server map /tmp/ssh-wt/01a12bef-11a5-7f71-8bb1-debbb865eb09.md.
Architect: handle 01a12bef-12af-7953-b80e-586c1e221b17 (Lorentz, gpt-6.1-sol), proposal A1-A14 at
/tmp/ssh-wt/01a12bef-12af-7953-b80e-586c1e221b17.md.

| ID                                                                                                       | Disposition        | Reason                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 resolve project default on every new-thread request, built-in Local                                   | Accept             | D-u1 "always Local" is read as "the resolved default, built-in local": a user who set worktree as a project default keeps it. Today the default is applied only to fresh drafts (apps/web/src/hooks/useHandleNewThread.ts:363); reused empty drafts and background follow-ups carry the old mode (:223, :329, apps/web/src/components/ChatView.tsx:10020).           |
| A2 draft keeps envMode local/worktree plus optional sshDestination                                       | Accept             | SSH is a destination for a new worktree, not a third git mode; settings and git consumers keep two modes.                                                                                                                                                                                                                                                            |
| A3 full field chain for sshDestination                                                                   | Accept             | Enumerated in 030.                                                                                                                                                                                                                                                                                                                                                   |
| A4 saved catalog SSH profiles, right submenu, labels, remove previous worktree, retire persisted binding | Accept             | Menu primitives exist (apps/web/src/components/ui/menu.tsx:264-320). Retirement: server drops `composer.previousWorktree` entries silently instead of warning (apps/server/src/keybindings.ts:395).                                                                                                                                                                  |
| A5 service apps/server/src/sshRemote/SshWorkspaceSync.ts                                                 | Accept             | Transports stay thin.                                                                                                                                                                                                                                                                                                                                                |
| A6 contracts + RPCs launch/readOperation/connect/fetchBack                                               | Amend              | Only `sshWorkspace.launch` and `sshWorkspace.fetchBack`. readOperation and connect belong to A11/A12, both rejected.                                                                                                                                                                                                                                                 |
| A7 scopes                                                                                                | Amend              | launch: source-control write + orchestration operate; fetchBack: source-control write. The exact scope literals are taken from clientRpcPermissions.ts in 020.                                                                                                                                                                                                       |
| A8 reuse private-index checkpoint core                                                                   | Accept             | apps/server/src/vcs/GitVcsDriver.ts:811-1082 already leaves index/HEAD/merge state alone.                                                                                                                                                                                                                                                                            |
| A9 non-bare remote repo ~/.goat/repos/<slug>-<hash8>, immutable pushed ref, no force                     | Accept, simplified | No anchor branch; the repo stays unborn and refs arrive by push. Ownership marker `git config goat.managed true`; a path that exists without it is refused.                                                                                                                                                                                                          |
| A10 flow via SshRemoteDispatch.launchThread with full saved target                                       | Accept             | Dispatch learns to take a full DesktopSshEnvironmentTarget (keeps alias callers). Local project scripts are passed to goat_project_create (ProjectCreatePayload.scripts, packages/contracts/src/project.ts:204) so the remote setup script runs on worktree creation; without this the new remote project has no scripts (packages/shared/src/projectScripts.ts:17). |
| A11 persisted operation receipts + remote launch idempotency                                             | Reject             | YAGNI. No automatic retry; a lost launch response surfaces "may have started on <host>; check its threads" and keeps the draft.                                                                                                                                                                                                                                      |
| A12 SshClientGateway for browser clients                                                                 | Reject             | Saved SSH connections exist only in the desktop app (apps/web/src/connection/platform.ts:279), so the submenu is empty in a plain browser and the feature is desktop-first as agreed.                                                                                                                                                                                |
| A13 fetch-back into refs/remotes/goat-ssh/...                                                            | Accept, amended    | No receipt: input is the remote project's workspaceRoot, the remote branch and the saved target; the local server finds its own project whose derived remote path equals that root, else refuses.                                                                                                                                                                    |
| A14 typed errors with stage; stack boundaries                                                            | Accept             |                                                                                                                                                                                                                                                                                                                                                                      |

## Main decisions

- M1 Chip label rule: mode text is always shown: `Local`, `New worktree`, `Worktree`; when the active environment
  is not this device, append ` · <environment label>`; a pending SSH destination reads `Worktree · <saved label>`.
  The machine/auto-balance name moves to the icon tooltip and the Run on menu only.
- M2 `Current checkout`, `Local checkout` → `Local` on web, settings and mobile. `Current worktree` → `Worktree`.
- M3 Remote repo name: `<basename-slug>-<first 8 hex of sha256(local workspaceRoot)>` under `$HOME/.goat/repos`.
  Pushed ref `refs/heads/goat/ssh-base/<opId>`; thread branch `goat/ssh/<opId>`; opId = 8 hex from the server.
- M4 Secret guard: before pushing, the snapshot's added untracked paths are checked against a small name list
  (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`); a hit fails with stage `snapshot`,
  code `secret_candidate` and the file names. Bypass fields: tier E3 (server code); surface SshWorkspaceSync.launch;
  known bypass: commit the file first (tracked files are not checked) or rename it; residual risk: secrets
  already in history travel with the push; wording: "early warning", not enforcement.
- M5 Fetch-back writes only `refs/remotes/goat-ssh/<alias>/<branch>`; never touches HEAD, index or working tree.
- M6 Stack and landing: four PRs chained by base; land child-first with merge commits (PR4→PR3→PR2→PR1),
  then PR1 → dev after goat-ci passes on PR1's final head; verify every link with `git merge-base --is-ancestor`.

## Phase map (dependency order)

| Phase | Doc                                 | Branch / PR base                     | Thesis                                                               |
| ----- | ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| wp0   | this dir                            | coordinator branch                   | roadmap, audited                                                     |
| wp1   | 010_phase1_local_default.md         | goat/ws-picker-1-local-default → dev | Local default, plain labels, remove Previous worktree                |
| wp2   | 020_phase2_ssh_workspace_service.md | goat/ws-picker-2-ssh-service → wp1   | contracts + SshWorkspaceSync (launch, fetchBack) + RPC + tests       |
| wp3   | 030_phase3_ssh_picker_ui.md         | goat/ws-picker-3-ssh-ui → wp2        | draft sshDestination, Worktree on SSH submenu, send path, navigation |
| wp4   | 040_phase4_fetch_back_ui.md         | goat/ws-picker-4-fetch-back → wp3    | fetch-back action, user docs                                         |
| wp5   | 050_phase5_land.md                  | —                                    | land the chain into dev                                              |

Stacking is justified (DEV-STACK-01): wp3 consumes wp2's contracts, wp4 consumes wp2's fetchBack and wp3's
draft provenance, and each layer is reviewable alone. This plan document itself lands with PR1.

## Open assumptions

| Assumption                                                                                        | Source                             | Confidence | If wrong                                                                                   | Status   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | -------- |
| A remote T3 accepts an unborn non-bare repo as a project and creates a worktree from a pushed ref | ThreadLaunchService.ts:267,393,445 | medium     | launch fails at stage launch; fallback: check out the pushed ref detached in the repo root | proposed |
| Saved SSH targets authenticate from the server with keys/agent                                    | SshRemoteDispatch.ts:202-206       | high       | password hosts fail with a clear error                                                     | proposed |
| Saved connection environmentId equals the remote T3 environment that owns the thread              | catalog.ts:44                      | medium     | navigation waits time out; UI offers "Open remote thread" with host + id                   | proposed |

## Decade-doc conflict dispositions (wp0)

| Conflict (020 "Plan conflicts")                                                                                                                                              | Disposition                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scripts passed to goat_project_create are ignored on a remote whose settings are folded (packages/shared/src/projectScripts.ts:23 returns settings.defaultProjectScripts) | Amend A10: pass scripts anyway (they apply on unfolded remotes); the remote setup otherwise follows that environment's own default project scripts. No settings-policy change. User docs (040) say so.                                                                                                  |
| 2. SSH destination is selected by alias, not the saved hostname (packages/ssh/src/command.ts:86-91)                                                                          | Accept: git push/fetch and the tunnel manager use the same user@alias + port; hostname stays informational.                                                                                                                                                                                             |
| 3. git add -A keeps tracked files that match ignore rules                                                                                                                    | Accept native semantics. Wording everywhere: "untracked gitignored files are excluded".                                                                                                                                                                                                                 |
| Baseline: apps/server/src/vcs/GitVcsDriverCore.test.ts:1968 fails locally before any change (stat.previousPath undefined)                                                    | Pre-existing, outside this unit; excluded from PR2's focused runs by -t filters and reported, never claimed green. goat-ci's test job does not run server tests (.github/workflows/goat-ci.yml:65-70), so server/contracts/client-runtime behavior is proven by local focused runs (050 "CI coverage"). |

| Audit round 3 (desktop capture bypassed the composer lock, SnapShotCoordinator.tsx:141-180) | LOOP-REPAIR-01 after three failed rounds: returned to P with a changed plan. The submission lock is withdrawn; 030 consumes the draft only when its content equals the snapshot taken at send, so every input path (typing, paste, capture, context insertion) is preserved without per-path guards. |
