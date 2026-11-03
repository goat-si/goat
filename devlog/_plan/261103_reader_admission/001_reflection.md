# 001 — Architect reflection record

- r1 plan sent to 01a19e46-8241-75b2-9c6d-e48b3b4d6385 → MISALIGNED, 8 gaps.
- Dispositions: gap1 (lane-owning tokens, both pool paths) FOLDED 020 R2-1. gap2 (stranded reserve) FOLDED 010 R2-4 + 020 R2-2. gap3 (uninterruptible deadline) FOLDED 010 R2-2. gap4 (claim-time recheck) REBUTTED 010 R2-3 with a pinning test. gap5 (both masked sites) FOLDED 010 R2-5. gap6 (failing-first wording) FOLDED 010 R2-6, 020 R2-3. gap7 (timeout null/validation) FOLDED 010 R2-1, 020 R2-4. gap8 (line budget) FOLDED 010 R2-7.

- r2 reflection → MISALIGNED: timer owner/shutdown, absolute deadline, timer settlement race, wp2 exactly-once tokens on both paths, pending-before-interrupt assertions. Gap4 rebuttal accepted (policy) with now<deadline grant check. All FOLDED as 010 R3-1..R3-5, 020 R3-1.

- r3 reflection → MISALIGNED: wall clock vs monotonic, handle-install race. FOLDED 010 R3-6, R3-7.

- r4 reflection → ALIGNED (no material gaps).
- A audit r1 → FAIL: wp2 not diff-level; close error mapped as overload. FOLDED 020 R4 (exact hooks for 5 call sites + pool + transaction path + lane API), R4-9 (MemoryWorker budget → mark at MemoryApplicationLayers.ts:172), 010 R4-1 (typed closed error).

- A audit r2 → FAIL: memory start wrap hits startup read; pool closed mapping. FOLDED 020 R5-1 (mark MemoryWorker.ts:974 process step only; budget via pure helper move), R5-2 (shared admissionSqlError for client + both pool paths).

- A audit r3 → FAIL: pool inherits fail-fast. FOLDED 020 R5-3 (honorFailFast gate option, pool false).

- wp1 A r1 → FAIL: zero timeout contradiction. FOLDED 011 item 2 (arrival immediate grant before deadline check; 3 tests).
- wp2 A r1 → FAIL: zero-timeout arrival rule dropped. FOLDED 021 item 4; residuals folded: budget fallback (item 8), granted-before-finalizer pool test.
