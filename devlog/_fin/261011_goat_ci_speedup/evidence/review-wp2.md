# Review: 55822a8f2

Target: `/Users/jun/Developer/goat.worktrees/ci-speedup`, HEAD `55822a8f259c792b695bbc7b5f51fb1cbb73675e`.

Automated pre-scan: `./node_modules/.bin/tsc --noEmit -p packages/ssh/tsconfig.json` exited 0 (one unrelated suggestion at `packages/ssh/src/runtimeArchiveGh.ts:166`); targeted `./node_modules/.bin/vp lint packages/ssh/src/tunnel.core.test.ts packages/ssh/src/tunnel.fixture.ts --report-unused-disable-directives` exited 0. The tunnel suite was not run, as directed.

1. **Low — Placeholder assertion count and order changed.** Trigger: the byte test now submits 12 requests at `packages/ssh/src/tunnel.core.test.ts:60-72`; `nativeScriptsBatch` checks all four placeholder-bearing outputs for every request before returning at `packages/ssh/src/tunnel.fixture.ts:209-214`. Previously the byte test called `nativeScripts` 16 times (12 variants plus two repeated renders for each of archive and mirror), and the helper ran four placeholder assertions per call before that call's byte comparisons (`55822a8f2^:packages/ssh/src/tunnel.core.test.ts:59-89`, `55822a8f2^:packages/ssh/src/tunnel.fixture.ts:199-209`). The new test runs 48 such assertions instead of 64, and a later variant's placeholder failure can precede an earlier variant's byte mismatch. Impact: this violates the stated count/order requirement and changes first-failure diagnostics, though no distinct input loses coverage. Verification: verified by tracing the old and new loops and helper. Preserve the checks at the corresponding assertion points, including the repeated first-result checks, or explicitly relax the count/order requirement.

`blocking_issues`: 0.

Coverage: `packages/ssh/src/tunnel.core.test.ts` and `packages/ssh/src/tunnel.fixture.ts` reviewed. The 12 results align with the three groups of four; `index` advances through all node variants before `continue` (`tunnel.core.test.ts:60-82`). The wrapper's undefined selection and optional input fields retain their old JSON meaning (`tunnel.fixture.ts:194-220`); a selected runtime caller was checked at `tunnel.runnerSwitch.fixture.ts:317-325`. The shim is passed only to the final unowned-lock run (`tunnel.core.test.ts:1637-1673`), lives inside the scoped temp root, records through its PATH-resolved script path, and uses `/bin/sleep` available on the Linux CI class; the production lock loop remains at `tunnel.ts:618-640`.

VERDICT: GO-WITH-FIXES (blockers=0)
