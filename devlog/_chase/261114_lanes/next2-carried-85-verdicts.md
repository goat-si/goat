# Verdicts for the 85 carried #3176 rows (next2-pr-plan.md appendix)

Coordinator, 2026-11-17 11:26:34 UTC. One verdict per row. None of these rows joins #3660: that pull request is cut at the lanes already cut from it. They form the plan of the pull request after it ("next3"), in the lanes below, except the native checks (K11), which are captures with no code and join P1's mobile pass, and the rows that wait on the owner. Every C4 row keeps its reason from the appendix as the thing its lane must settle first: a plan to the coordinator before code (what an older client or server sees, the negative cases), as L179 does in N9a.

## K1 pull request watch chain (server, C4 wire fields), one lane, in this order

0af2d21647, 1de3c3c68c, 072254ddd3, 36254ab82e, 1df9c91230, eb7e63a822.

## K2 pull request links and the Code tab (web, contracts)

b3fdf2b10f first (older-client decoding and mobile navigation), then 3a0bcba00a, 8cbc95923a, abbd967c4b, e89c8ce014; 479ee74135 (PR metadata in drafts: with the persisted-state migration covered by a test on a stored older draft); 54a5c51a58; f3da8ff63b (GitLab resolve: port with the provider mocked; the live GitLab row stays a person-or-account row).

## K3 branch-only subscription chain (server, contracts)

0d809db501 as the prerequisite (decide first whether GOAT wants the branch-only subscription at all: a plan to the coordinator), then 0ac41eecad, 0ceaa9a48c, 76e4cb5c8a (its Windows proof on a hosted Windows run, as W1 does).

## K4 checkpoints and worktrees (server, C4 user files), on N4's host after N4 merges

0c4b1d8f27, 14978e35a5, 1a4a29998b (with goat#3671 and N4's sparse findings in its brief), 1da05a8a98, 7bd9134824 then 9402dc39bf, a0844eaec6, f4cf69f522 (the rest), 18aeb0fb91 (visible: a web capture), 76d0fff5fd.

## K5 Claude adapter (C4), on N9a's host after N9a

aab388ddb1, d6e5f2e06f, 86e2cb21c9, fdd54b942d, e4025c8528 (the PID-reuse case tested). 5984bbb36e waits: it needs d6e5f2e06f and a decision; bring the decision when d6e5f2e06f's plan is in.

## K6 runs, queue and persisted events (server, C4)

d19467a59e, fd9b2c3eaa, d806251188 (240446e2d9 first), 2e0bd97e86, d9c0920449 (a test on stored legacy rows). WAIT ON A DECISION, as the appendix says: b20bbc595d, beb528ce4d; the lane states the question in one paragraph each and sends it to me.

## K7 client connection and protocol (client-runtime, contracts, C4), its own lane, the largest

a74ee4cc7c, 962eeefa03, de21fbcff3, 00f617db4e, 2482b03a01, 7c22095fcc, 8b2763f638, 3a815e9749, 1c9ea568a1, c9f0caca1b, 6641231797. Order inside: the two subscription recoveries and the command-id retry first (they share the authorization question), then the rest. Web and mobile both, older server and older client each way.

## K8 SSH and desktop shell

a48d7c6cd0, 22910ffdd2, 058d953646, 79daf43c1c; e93f6ea361 then ff1eead6f4; 67fdc53823 as the prerequisite then a11ad7424d and 52d621a6f1; 587deab7d3 (keep awake: server, web, desktop and the mobile settings control, with a native capture).

## K9 server, providers and MCP (one lane)

76b3e3390e (C4 auth: read with S4's record), 9c96180aa3, 75c7fb28af, b125e89768 (with an older Codex app-server as the negative case), 476fc9be66.

## K10 web timeline, on N14's host after N14

3d78e915e3 as the prerequisite then 836b86a5d6 then a044f0c0b3 (mobile); 23e3465ec6 as the prerequisite then 1c3d5f7e82; the three items carried from #3192 (ordered-list numbers in sent messages, Claude insight callouts, the MCP App's initial colour). 3051b32502's product half and 3d6ece2b29 with it: this lane ports the half; what the appendix marks as needing a decision comes to me as one question.

## K11 native checks, no code: into P1's mobile pass (simulators and emulators; a row that truly needs a physical device keeps its issue and says so)

81e9368c4a, 11f61a5327, fd64128014, b85a21e240, 01200aaf8e (the capture; the title cap stays deferred), 9c5b6f3d77, 96aa40ebcd, 0465d4a87d, 7179113617, 095611d1b5, 9a35ab0afe, ca6e09c3e1. 7fb54eb051 waits on its predecessor 35bda28117 (native secret input): port both in N15a's follow-up or skip both; N15a says which after reading it.

## Waits on the owner

The voice settings chain 55a94e2029, 91a76cf5a6, 444ea535e3, e9a7c076f7, bce2bc048e (needs the cloud voice picker fe901ac7ba, absent in GOAT): no lane until the owner decides on cloud voice; it goes to him together with N15b's O5 departure.

## What to do with this

Write next3's plan from it (lane, rows, class, size, host, person) in the records branch; do not start any K lane before #3660 merges, except K11 inside P1. If a row here is already covered by a commit in #3519 or #3660, say so in the plan and tick it instead.
