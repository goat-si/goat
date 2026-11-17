# next3 K4: checkpoints and worktrees, plan for the coordinator's ruling

Lane K4, host pen-macmini, branch chase/t3-261114-next3-k4-checkpoints (GOAT-managed worktree), written by claude-opus-5-5 through the Codex harness in GOAT, 2026-11-18. PLAN ONLY: no code commit and no code push before the ruling. Code starts after #3696 is on dev and the coordinator has merged dev into chase/t3-261114-next3; I then run git merge --ff-only origin/chase/t3-261114-next3 on the commitless branch and report the sha.

Base check (git rev-parse, fresh fetch): HEAD = origin/chase/t3-261114-next3 = origin/dev = a608046c519b9377be3f03a5cdd6b376dd1b5c3f. Planned against that dev and #3696's head b7672aa5f88cde6cf5851abc9197ff19fba2e71f (fetched as pull/3696/head; 13 files, among them terminal/Manager.ts, terminalLeaseOrder.ts, ProjectSetupScriptRunner.ts, ThreadWorkspaceService.setupLockOrder.test.ts, pullRequestSetup.lockOrder.test.ts).

Worktree state: .goat/setup-failed says setup ran under a Node other than 26.12.1. Before the first code commit I run vp env exec --node 26.12.1 -- node scripts/setup-worktree.ts. Nothing was installed or built for this plan.

## 1. Ancestry check

Command per row: git log origin/dev --oneline --grep=<sha> (dev holds #3519 = 3ecea04f19 and #3660 = 42bf8633ce), then the lines on dev that the upstream diff changes.

| Row | On dev? | Evidence on dev a608046c |
| --- | --- | --- |
| 0c4b1d8f27 new turns wait for overlapping checkpoint file restores | no | no reservation in workspace/workspaceLease.ts; CheckpointRollbackService.ts:437-441 leases only the thread's own worktree; ProviderTurnStartService.ts:518 prepares (and leases) only when worktreePath !== null |
| 14978e35a5 PR worktrees keep local commits on an existing branch | no | GitManager.ts:2794 materializePullRequestHeadBranch runs for an existing, unchecked-out branch before createWorktree at :2826 |
| 1a4a29998b checkpoint revert restores skip-worktree files | no | GitVcsDriver.ts:1520-1533 restoreCheckpoint runs a plain git restore (no --ignore-skip-worktree-bits). #3660's N4 work changed the Storage Cleanup snapshot path (captureSnapshot.ts:118, restoreSnapshot.ts:150-162), which this row does not touch |
| 1da05a8a98 a default branch the remote deleted no longer starts worktree threads | no | GitVcsDriverCore.ts:1547 still symbolic-ref refs/remotes/<remote>/HEAD |
| 7bd9134824 turn diffs follow branch switches | no | GitVcsDriver.ts:1395 single parent (HEAD); :1670 reads "%P %ct" |
| 9402dc39bf fetched upstream commits no longer show as agent changes | no | GitVcsDriver.ts:1709-1715 still lists every commit since the capture time |
| a0844eaec6 merged-PR threads no longer re-read git state every minute | no | GitManager.ts:148-151 has no confirmTerminal; ThreadSettlementService.ts:658-666 (branch path) asks for confirmed state every sweep. The reference path already gates on wouldSettle (:641), a GOAT analogue, not this row |
| f4cf69f522 selecting a remote branch lands on its local branch | PART | the lookup half is on dev: #3218 (08fb33f2a8, port 8dce681b98) at GitVcsDriverCore.ts:5141 (lstrip=2 and refs/remotes/ match), test switchTagCollision.test.ts. Not on dev: creation from refs/remotes/<ref>, --no-track then --set-upstream-to, cleanup on failure (createTrackingBranch.ts:54 still runs branch --track -- <branch> <refName>) |
| 18aeb0fb91 new worktrees show submodule downloads | no | ThreadLaunchService.ts:428 stages lack "submodules"; GitVcsDriverCore.ts:4436-4438 no --progress; gitCloneProgress.ts:19 old PERCENT regex |
| 76d0fff5fd include symlinks in workspace search | no | no IgnorePatterns.ts; WorkspaceSearchIndex.ts has no symlink scan |
| note (viii) | no | restoreSnapshot.ts:156 filters entry.startsWith("S ") only |
| goat#3690 | no | issue OPEN; Manager.ts launchContextChanged (#3696 head :2280) compares paths only |
| goat#3681 | no | issue OPEN; workspaceLease.ts:50-58 HeldLease keeps live, inFlight, drained; asHolder :229-241 waits for the drain |

goat#3671 (sparse snapshot misses edits) is still OPEN although #3660 fixed it (5c8f12ec1d capture --sparse, 6b5d97be8c restore of deletions outside the patterns, follow-ups up to c3fd17ba86). Decision D7.

## 2. Rows

Every row below is C4 (person's files under checkpoints or worktrees, a persisted format, or a protective lock) unless it says otherwise. None changes a wire schema; the older-client column is "nothing changes" unless stated.

### Note (viii): restoreSnapshot.ts:156 misses "s"
- What: in applySnapshotToWorktree, the deleted paths the index tags "S " or "s " are unflagged. "s" carries skip-worktree and assume-unchanged together, so those paths get --no-assume-unchanged too. Without it, verify's add -A --sparse skips them and restore fails with worktree-tree, the restored checkout is discarded.
- Prior art: git-ls-files documents lowercase tags for assume-unchanged, so "s" is skip-worktree plus assume-unchanged; upstream 1a4a29998b matches both bytes 83 and 115 for the same reason. GOAT's own capture already treats "s" apart (GitVcsDriver.ts:1041). The N4b narrow review named this case (next2-N4.md:399).
- Deleted, moved, rewritten: nothing new. Only index flags change, on paths the snapshot deleted.
- Older server against today's snapshots: fails loudly as now (no bytes lost, worktree discarded, snapshot kept). Newer server reads every existing snapshot (no format change).
- Negative cases: an "h" entry (assume-unchanged only) among the deleted paths: the test shows what restore does with it today, and if it fails the same way its flag is cleared in the same commit; a non-deleted "s" path stays flagged; a non-sparse worktree is unchanged; a locked index fails loudly as before.
- Test first: storageCleanup.sparseSnapshot.test.ts (105 lines) new case "a sparse worktree's deletion outside its patterns flagged both ways is restored as a deletion": fails first with RestoreSnapshotError 'worktree-tree'.
- Budget: restoreSnapshot.ts 259, no entry.

### 1a4a29998b: checkpoint revert restores skip-worktree files
- What: restoreCheckpoint (GitVcsDriver.ts:1500) restores with --ignore-skip-worktree-bits outside a sparse checkout; in a sparse one it restores as now, then restores again only the skip-worktree paths the sparse rules select (ls-files --sparse -v -z, tags S and s, then sparse-checkout check-rules -z). Git without those commands keeps today's result.
- With N4's sparse findings: the three sparse shapes N4 tested (cone, --no-cone with sparse.expectFilesOutsideOfPatterns=true, a deletion outside the patterns) are this row's negative cases, on the checkpoint path. Sparse exclusions stay excluded (not written to disk), matching GOAT capture's classification (GitVcsDriver.ts:1033-1041), which records hand-flagged entries and treats in-sparse S as exclusions.
- Rewritten: a file a person flagged skip-worktree by hand is now written back to its checkpoint content by Edit from here. Today it silently keeps its later content. Decision D2.
- Older server: leaves such files as they are (today). Newer server: restores them. No stored format change.
- Negative cases: hand-flagged file edited after the checkpoint (reverted, D2); sparse exclusion (not materialised); sparse directory entries (trailing /) skipped; a non-UTF-8 name skipped (as today); Git without check-rules (plain result, logged); a huge index (streamed, 4 KiB truncated stdout as upstream).
- Test first: new sibling vcs/GitVcsDriver.skipWorktreeRestore.test.ts (GitVcsDriver.test.ts is at its entry 1781): upstream's two cases plus a --no-cone sparse case with an edit outside the patterns that must stay excluded.
- Budget: GitVcsDriver.ts at its entry 1765. Move-out commit first (verbatim): listAuthoredPaths (:1662-1716) into vcs/checkpointAuthoredPaths.ts as a factory taking execute; that frees room for this row, 7bd9134824 and 9402dc39bf. The new restore logic lives in vcs/checkpointSkipWorktreeRestore.ts.

### 7bd9134824 then 9402dc39bf: turn diffs follow branch switches; fetched commits are not agent changes
- What (7bd9134824): capture reads HEAD's reflog (512 entries) before staging; a checkpoint taken after a checkout switch gets a second parent, a "turn start" commit (the previous checkpoint with the switch applied), and a trailer marking where the reflog stood. listAuthoredPaths and diffCheckpoints start from that turn start; "%P %ct" becomes "%ct %P". CheckpointService passes previousCheckpointRef when ordinalWithinScope > 0; VcsDriver and CheckpointStore inputs gain the optional field.
- What (9402dc39bf): commits newer than the capture that a fetch delivered (remote-tracking reflogs) and that no local reflog shows being created are not attributed to the turn.
- Stored data: checkpoint commits under GOAT's checkpoint refs gain a second parent and a trailer. No migration; restore reads only the tree (restoreCheckpoint, :1503), so restores are unaffected either way.
- Older server reading a newer checkpoint (downgrade, or an older GOAT on the same repository): GitVcsDriver.ts:1675 takes the second parent's sha as capturedAt. Git accepts --since=@<sha> silently (checked here: git rev-list --since=@0123456789abcdef0123456789abcdef01234567 HEAD exits 0), so that turn's authored-path filter is wrong: upstream files may show or hide in that one turn's diff. No error, no file touched. Decision D1.
- Newer server reading older checkpoints: no trailer, so no turn start; resolveTurnStart's ^2 lookup fails and falls back to the from ref (today's behaviour).
- Trailer name: upstream writes T3-Head-Moved-At; GOAT's message is "goat checkpoint ref=" (:1394). Decision D1.
- Negative cases: reflog off (core.logAllRefUpdates=false: no mark, as today); scan limit hit inside the marked second (no turn start); switch plus reset; detached HEAD; submodule gitlinks (left out); sparse index (index.sparse=false); turn-start failure (logged, single-parent commit, as today); 9402: a push ("update by push") is not an import; a commit made here, pushed, fetched on another branch stays own; reflog output over the cap (falls back to attributing all, as today).
- Tests first: CheckpointStore.test.ts (598 lines, no entry; +117 keeps it under 800) gets upstream's cases; the GitVcsDriver cases go to the sibling file above. One extra GOAT case: a checkpoint written by the new capture still restores byte-identically.
- Budget: GitVcsDriver.ts net 0 or less per commit after the move-out; the turn-start builder goes to vcs/checkpointTurnStart.ts and the import detection to vcs/checkpointAuthoredPaths.ts.

### 1da05a8a98: a deleted remote default branch
- What: resolveDefaultBranchName (GitVcsDriverCore.ts:1540-1556) and listRefs' default ref use rev-parse --verify --quiet --symbolic-full-name, which fails when origin/HEAD points at a deleted branch; parseDefaultBranchFromRemoteHeadRef rejects "HEAD"; resolveWorktreeBaseRemote refuses <remote>/HEAD as a branch.
- GOAT adaptation: GOAT has no upstream preflight hunk; ThreadLaunchService.ts:521-548 fetches the base at creation, and a null fetch leaves startRef as the name. The failing test decides whether ThreadLaunchService needs a line; the MCP hint copy is at ThreadLaunchMcpService.ts:523-525 ("no origin remote to fetch it from"), changed to say no remote has it.
- Older server: offers the deleted default branch and the launch fails at worktree add. Older client: nothing changes.
- Negative cases: dangling origin/HEAD; no origin; a branch literally named HEAD on a remote; startFromOrigin false.
- Test first: new sibling vcs/remoteDefaultBranch.test.ts (GitVcsDriverCore.test.ts at entry 6275): "does not report a default branch the remote deleted after the clone".
- Budget: GitVcsDriverCore.ts at entry 5401. Move-out commit first: resolveDefaultBranchName and parseDefaultBranchFromRemoteHeadRef verbatim into vcs/remoteDefaultBranch.ts.

### f4cf69f522 (the rest): a tag that shares the remote ref's name
- What: createTrackingBranch.ts:54 creates from refs/remotes/<ref> with --no-track, then --set-upstream-to with writesSharedConfig (GOAT's shared-config lock stands in for upstream's retryWhileConfigLocked, which GOAT does not have); on failure update-ref -d refs/heads/<b> <startRef> removes the branch only if it still points at the start.
- Older server: a tag named like origin/foo makes the new branch start at the tag. Older client: nothing changes.
- Negative cases: .git/config.lock held by another process (branch removed, error shown, HEAD not moved since this runs before the checkout); the branch moved meanwhile (kept); no tag (unchanged).
- Test first: switchTagCollision.test.ts (27 lines, #3218's file): "a branch created from a remote ref starts at the remote, not a tag of that name", plus the lock case.
- Budget: createTrackingBranch.ts 60, no entry; call site GitVcsDriverCore.ts:5179 keeps its line count.

### 18aeb0fb91: submodule progress in new worktrees (visible: a P1 row)
- What: ThreadLaunchService adds the "submodules" stage and wires onSubmodulesStarted, Disabled, Line (throttled to one update a second) and Finished; createWorktree passes --progress and keeps line callbacks after output truncation; gitCloneProgress.ts PERCENT becomes linear on hostile remote output; WorktreeSetupCard.tsx trailing text max-w-1/2.
- Contract: "submodules" is already a stage id (packages/contracts/src/worktreeSetup.ts:13, label :98, since b59034d2b3), so every GOAT client renders it; an older server never sends it.
- Negative cases: no submodules (stage skipped "none"); submodules disabled in settings (skipped with the source); submodule update fails (warning, thread continues as today); output past the cap (truncated, no failure); a path with a quote.
- Tests first: ProjectCloneTracker.test.ts (369) for the regex; new sibling orchestration-v2/ThreadLaunchService.submodules.test.ts (ThreadLaunchService.test.ts at entry 2594). P1 row: web capture of a new worktree on a repository with a submodule, before and after, plus mobile if it shows setup stages.
- Budget: ThreadLaunchService.ts at entry 1461: the callbacks live in orchestration-v2/goat/worktreeSubmoduleProgress.ts; if the hook adds lines, a verbatim move-out first. GitVcsDriverCore.ts covered by the move-out above.

### 14978e35a5: PR worktrees keep local commits on an existing branch
- Moved and rewritten: today an existing local PR branch that is not checked out is forced to the PR head (GitManager.ts:2794) before the worktree is made, so unpublished local commits leave the branch (only the reflog keeps them). After: the worktree is made on the branch as it is; in onWorktreeClaimed GOAT sets the upstream, fetches the PR head ref (checked against headSha, else the configured upstream), then refreshCheckedOutBranch (GitVcsDriverCore.ts:4554) fast-forwards when behind and resets only when HEAD was published (in refs/remotes or in the upstream's reflog) or equals the upstream before the fetch; otherwise the local commits stay and isOnPullRequestHead is false.
- Older client: isOnPullRequestHead already exists (contracts git.ts:305, decoding default true); web shows offHeadPullRequestCheckoutToast; mobile restores the queued message with its existing "has local changes" text (threadOutboxDelivery.ts:467). Older server: forces the branch (today's loss).
- Negative cases: upstream's seven (ahead kept, behind fast-forwarded, rewritten, rewritten-fetched, wrong-ref, stale-head kept, checkout race), plus GOAT's: the branch checked out in another worktree (reuse path unchanged), refresh failure (warning, branch untouched, off head), setup after the refresh under #3696's lock order (pullRequestSetup.lockOrder.test.ts unchanged).
- Test first: new sibling git/GitManager.prExistingBranch.test.ts (GitManager.test.ts at entry 5165): ahead and stale-head fail first.
- Rule 3 risk: GitManager.test.ts:3951 "local PR checkout lands cleanly (existing branch: %s)" covers the Local mode; if any worktree-mode expectation moves, I stop and send it.
- Budget: GitManager.ts at entry 3124. Move-out commit first, verbatim, from preparePullRequestThread into git/pullRequestWorktree.ts; the new refresh lives there.

### a0844eaec6: merged-PR threads stop re-reading git state each sweep
- What: branchPullRequest gains confirmTerminal (default true). ThreadSettlementService's branch path (:658-666) reads the remembered answer and confirms with fresh git state only when wouldSettle (:584) says it would settle; ThreadPullRequestService's backfill (:216) passes confirmTerminal false only if its save path confirms before persisting (checked in code; otherwise it keeps confirming).
- Removal safety: a thread is settled (and may lose its worktree) only after fresh git state agrees, as today. Negative cases: a reused branch with a new open PR (periodic fresh lookup stays); a remembered merged PR whose branch moved (fresh check refuses); refresh requests unchanged; the reference path unchanged.
- Test first: new sibling orchestration-v2/ThreadSettlementService.mergedSweep.test.ts (the test file is at entry 1599) counting git reads; ThreadPullRequestService.test.ts is 976 lines (cap 1000), so its cases also go to a sibling.
- Budget: GitManager.ts after the move-out above.

### 76d0fff5fd: symlinks in workspace search
- What: search lists symlinks found in folders the index already holds, without following them, kept only when the real target is inside the workspace's real root, not in .git, and a file or folder; .ignore files (nearest wins) and git check-ignore per nested repository decide; a check-ignore failure inside a repository hides its links. Results merge by subsequence score.
- Containment: opening a listed link still goes through WorkspaceFileSystem's realpath checks (WorkspaceFileSystem.ts:283-320), unchanged.
- Negative cases: link out of the root (../ and absolute), into .git, dangling, a loop, to a fifo or socket, ignored by .gitignore, .ignore, info/exclude or a nested repo's rules, created after the scan (watcher marks stale).
- Performance: scan concurrency 16, paged directory listing, a 2 s reuse window when unwatched, a 5 ms wait for a rescan; the first search waits for the full scan, a latency risk on a large repository, measured on GOAT's own checkout before READY.
- Tests first: new workspace/IgnorePatterns.test.ts; WorkspaceSearchIndex.test.ts (389, +248); WorkspaceEntries cases in a sibling (WorkspaceEntries.test.ts is 943, cap 1000).
- Budget: WorkspaceSearchIndex.ts 737 has no entry but must stay under 1000: the scan goes to workspace/workspaceSymlinkScan.ts, IgnorePatterns.ts is new (~170).
- Dependencies present: scoreSubsequenceMatch (packages/shared/src/searchRanking.ts); @ff-labs/fff-node 0.11.0 is upstream's version too.

### 0c4b1d8f27: new turns wait for overlapping file restores
- What: process-local reservations over overlapping folders (same, parent, child, a symlink alias, canonicalised through the nearest existing ancestor). A file restore (restoreFiles !== false) is exclusive; turn starts do not exclude each other.
- GOAT adaptation: GOAT never lets an effect worker wait on a busy folder: prepareTurnWorkspace takes tryWithWorkspaceLease and returns Busy to the outbox retry (prepareTurnWorkspace.ts:50, ProviderTurnStartService.ts:518-525). The turn-start side is therefore a try that returns Busy, for worktree and project-root threads alike, never a wait. The module is new, workspace/checkpointRestoreReservation.ts; workspaceLease.ts is untouched by this row.
- Negative cases: restore fails or is interrupted (released by ensuring); restoreFiles false (no reservation); two turn starts in one folder (no wait); a removed worktree being recreated (nearest ancestor); a sibling folder (not blocked); Windows drive-letter case (path.relative; not run, no Windows host).
- Cross-server: another GOAT server on this machine is excluded only for the same worktree, through the existing lease claim. Decision D3.
- Tests first: new sibling CheckpointRollbackService.reservation.test.ts (CheckpointRollbackService.test.ts is 970, cap 1000) and a ProviderTurnStartService sibling (at entry 1257): "a turn start in a folder overlapping a running file restore goes back to retry", with Deferreds, no sleeps.
- Budget: ProviderTurnStartService.ts at entry 1581: the reservation try goes into prepareTurnWorkspace.ts; the root-thread call at :518 needs a verbatim move-out first if it adds a line.

### goat#3681: lease reentry only from the holder's own fiber
- Prior art: Java's ReentrantLock is owned by the thread that last locked it and only that thread reenters; a thread it starts must wait like any other (java.util.concurrent.locks.ReentrantLock docs). Effect's Semaphore does not reenter at all. GOAT's #3678 went wider (forked fibers marked during the hold), which is what forces the unbounded drain; the issue narrows it to the Java model.
- What: HeldLease records the holder fiber's id; enterHeld enters only when the fiber is marked (reuseHeldWorkspaceLease) and is that fiber. live, inFlight, drained, leaveHeld's wake and asHolder's drain wait go. The doc comment at workspaceLease.ts:198-204 is rewritten.
- Callers (every reuseHeldWorkspaceLease; withWorkspaceLease and tryEnterWorkspaceLease are the only reentering entries): restoreThreadWorkspace.ts:140 setup terminal: yes, holder fiber (runForThread's terminalManager.open and restart run on the caller's fiber; ProjectSetupScriptRunner forks only the command write, #3696 head :641, which takes no lease). ThreadWorkspaceService.ts:292: yes, the same. terminalLeaseOrder.ts:167 (#3696): yes, withWorkspaceLease then reuseHeld(run(true)) in one fiber. No caller reenters from a fork. Proof in code: ThreadWorkspaceService.setupTerminal.test.ts, ThreadWorkspaceService.setupLockOrder.test.ts and Manager.leaseOrder.test.ts pass unchanged.
- Rule 3 lines: decision D4 (exact before and after there).
- Negative cases: a marked fiber forked during the hold that asks during the hold waits until the holder ends; the holder interrupted while its own fiber is in a reentrant section releases exactly once; an unmarked same fiber still waits (not reentrant without the mark).
- Budget: workspaceLease.ts 379, no entry; the change removes lines.

### goat#3690: other live terminals keep a removed or set-aside folder
- Prior art: a shell keeps its working directory by inode, so a folder deleted and recreated at the same path leaves it in the old one; VS Code's guidance is to kill and recreate the terminal (code.visualstudio.com/docs/supporting/troubleshoot-terminal-launch), and git-worktree leaves the shell in the removed folder (git-scm.com/docs/git-worktree). Upstream T3 Code has no set-aside or snapshot restore, so it has no analogue. GOAT differs because GOAT itself removes and brings back the folder, so it knows when it happened.
- Proposal (D5): when GOAT restores or sets aside a thread's folder (restoreThreadWorkspace.ts, RecreateWorktree.ts, the set-aside in setAsideFolder.ts), every other live terminal of that thread whose cwd is inside the folder gets one notice line in its output, with the path: the folder was replaced, restart this terminal or cd to the path. The shell is not killed. No contract member, so web, desktop, mobile and older clients show it as text. The setup terminal (fresh shell) and exited terminals get none.
- Negative cases: a terminal of another thread in the same folder (decided in D5); a terminal in a sibling folder (none); a restore on another GOAT server (not seen by this server: covered only if D5 adds the inode check at reattach); a full-screen program (the notice can disturb its screen: D5).
- Test first: new sibling terminal/Manager.folderReplaced.test.ts (Manager.test.ts at entry 2019): the second live terminal receives the notice after a restore; others do not.
- Budget: Manager.ts at 3116 on #3696 with entry 3118: logic in terminal/folderReplacedNotice.ts; the hook stays within 2 lines or a verbatim move-out goes first.

## 3. Budgets and move-outs

At their entries now (dev and #3696): GitVcsDriver.ts 1765, GitVcsDriverCore.ts 5401, GitManager.ts 3124, ThreadLaunchService.ts 1461, ProviderTurnStartService.ts 1581, and the tests GitVcsDriver.test.ts 1781, GitVcsDriverCore.test.ts 6275, GitManager.test.ts 5165, ThreadLaunchService.test.ts 2594, ThreadSettlementService.test.ts 1599, ProviderTurnStartService.test.ts 1257, Manager.test.ts 2019. Manager.ts is 3116 against 3118 on #3696. Planned verbatim move-outs, each its own commit before the row that needs room: GitVcsDriver.ts listAuthoredPaths; GitVcsDriverCore.ts default-branch resolution; GitManager.ts a preparePullRequestThread block; ThreadLaunchService.ts and ProviderTurnStartService.ts only if their hooks add lines. Each lowers the entry to the real length (countLines), and every removed line not re-added is listed in this record. New tests go to sibling files; no test file moves, so goat-rename TEST_TITLES does not change (a title change in D4 is asked first).

## 4. Rule 3 lines expected

Only goat#3681 (D4). Possible, stopped and asked if hit: GitManager.test.ts worktree-mode PR expectations (14978e35a5); WorktreeSetupTracker.test.ts stage lists (they pass explicit lists, so none expected).

## 5. Order and size

Commits in this order, one per row, move-outs ahead of the row that needs them: (viii); move-out GitVcsDriver; 1a4a29998b; 7bd9134824; 9402dc39bf; move-out GitVcsDriverCore; 1da05a8a98; f4cf69f522; 18aeb0fb91; move-out GitManager; 14978e35a5; a0844eaec6; 76d0fff5fd; 0c4b1d8f27; goat#3681 (after your word on D4); goat#3690 (after D5). Size L: about 13 row commits and 3 to 5 move-outs; upstream's diffs are about 2,900 added lines with tests, GOAT's adaptations a little more for siblings. One heavy job at a time on pen-macmini; T3 follows after READY.

## 6. Decisions for the coordinator

D1 (7bd9134824). The new checkpoint commit gets a second parent and a trailer. An older GOAT server that reads one misreads the capture time (no error) and filters that turn's authored paths wrongly, shown files only, nothing restored or deleted differently. I propose upstream's format as is, accepting that on a downgrade, and keeping upstream's trailer name T3-Head-Moved-At so later upstream ports apply without a rename (GOAT's message prefix stays "goat checkpoint"). The alternative is a sibling ref per turn start with single-parent checkpoints, which older servers read correctly but which adds a ref family to clean up.

D2 (1a4a29998b). Edit from here will now write back files a person flagged skip-worktree by hand, which today keep their later content silently. That later content is not saved anywhere first (Edit from here sets a folder aside only when its checkout is lost). I propose accepting it as the meaning of "restore this checkpoint", the same as any other tracked file it reverts, with the row's commit message saying so. The alternative is keeping hand-flagged files out of the restore, which leaves the bug.

D3 (0c4b1d8f27). Reservations are process-local, as upstream's. Turn starts try and go back to the outbox retry instead of waiting, as GOAT's turn starts already do with the lease. A second GOAT server on the same machine is excluded only for the same worktree (existing claim), not for overlapping folders. I propose that, and a follow-up issue only if you want the cross-server overlap covered.

D4 (goat#3681, rule 3, workspaceLease.reentrant.test.ts). Before and after, exactly: (a) :81 "only the holder and fibers it forks while holding can enter its lease": its expectations (events[0] "holder end", then early and unrelated; then ["second end", "late entered"]) still hold, since no fork in it enters during the hold; I ask only to retitle it "only the holder's own fiber can enter its lease". (b) :179 "a holder that finishes keeps the folder until its forked reentrant section leaves", asserting ["child left", "holder released"] and the folder free: removed, the behaviour no longer exists; replaced by a new case where the marked fork asks during the hold and enters only after release (["holder released", "child entered"], folder free). (c) :209 "the holder's release waits for a reentrant section still running, then frees once", asserting ["child left", "next entered"] and one release: removed; its "released exactly once" half is kept as a new case where the holder's own fiber is inside a reentrant section when interrupted, and the next holder enters once. (d) :262 "a fiber forked during a hold enters only after the holder ends unless marked": expectations unchanged; I ask to retitle it without "unless marked". The setup-terminal and lock-order tests do not change.

D5 (goat#3690). I propose the notice line in the terminal output, with no contract member and no kill, at GOAT's own restore and set-aside points, for every live terminal of that thread inside the folder (other threads' terminals in the same folder too, since the folder is the same). Two costs: a full-screen program (vim, less) can have its screen disturbed by the line until it redraws, and a restore by another server is not seen unless I add an inode check when a terminal is reattached. The alternative is a terminal session field with a restart button in web and mobile, a contract change that would overlap T3's terminal error member; I propose leaving that to the owner.

D6 (scope). f4cf69f522's config-lock part uses GOAT's writesSharedConfig lock instead of upstream's retry. I propose that, with no new retry machinery.

D7 (goat#3671). Fixed on dev by #3660 (5c8f12ec1d, 6b5d97be8c and N4b's follow-ups) but still open. Should I comment with those commits and close it from this lane, or do you close it?

## 7. Risks and expected NOT RUN

- Risks: setup failed here (Node version), fixed before code; reflog-based logic depends on the person's git config (covered by the fallbacks above); symlink scan latency on large repositories; the notice line in full-screen programs (D5).
- Expected NOT RUN: Windows paths (drive-letter case, junctions) for 0c4b1d8f27 and 76d0fff5fd, no reachable Windows host (parkjs-win unreachable per the ruling); Git older than 2.35 or 2.41 paths unless an older git binary is on the host; the client pass (P1 rows: 18aeb0fb91 web capture, goat#3690 notice in web and mobile terminals); no real provider turn (none of these rows is about a provider).
