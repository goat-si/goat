# Ubuntu screen-runtime validation: blocked

Requested follow-up evidence for [#1788](https://github.com/goat-si/goat/pull/1788).
This is **not** a successful runtime qualification or a FAIL-to-PASS fix. Both
observed failures intersect #1788's implementation; they were reported to the
requester before preparing this evidence-only draft. No product patch was made.
Do not merge this follow-up before #1788.

## Provenance

- Validation date: 2026-10-27 KST (2026-10-26 UTC).
- Requested base: `codex/unified-cua-runtime` at
  `2710d14d69bfec6607d2f1507272aab48683b687`.
- Base moved; the unpublished branch was rebased without force push to
  `817f1e68d30df4ec98b101191a758f83ebf9fec2`.
- Final tested source HEAD: `817f1e68d30df4ec98b101191a758f83ebf9fec2`.
  The PR adds only this report; its exact evidence commit is in the PR body.
- Host: Ubuntu Linux x64; Node `26.12.1`; global Vite+ `1.4.0`;
  Kache `1.2.2`; server version `0.1.2`; locked QuickJS packages `0.32.0`.
- Checkout: `/home/ubuntu/repos/goat`; evidence:
  `/home/ubuntu/goat-linux-screen-evidence` (logs attached to the Devin session).
- No real account, live GOAT userdata, shared SSH service, or external browser
  fixture was used. No GOAT server or isolated SSH fixture was started.

## Results

| Check                                                           | Result               | Boundary of the evidence                                      |
| --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Locked dependencies, global `vp env which node`, `kache doctor` | PASS                 | Setup only; doctor passed before the original archive attempt |
| Original-head Linux CLI archive build                           | FAIL                 | Stops in single-executable import validation                  |
| Rebased-head direct executable build                            | FAIL                 | Same two QuickJS external imports                             |
| Rebased-head focused source tests                               | FAIL                 | 33 passed / 1 failed; 2 files passed / 1 failed               |
| QuickJS WASM extracted from packaged archive                    | UNVERIFIED / NOT RUN | No archive was produced                                       |
| Packaged child executes `return 7;`                             | UNVERIFIED / NOT RUN | Existing archive smoke was not run                            |
| SSH-provisioned Linux runtime                                   | UNVERIFIED / NOT RUN | No archive; no SSH fixture created                            |
| Server-owned tab + desktop target in one cell                   | UNVERIFIED / NOT RUN | No runtime/client execution                                   |
| Stop, reconnect, two-viewer cursor state, turn cleanup          | UNVERIFIED / NOT RUN | Source fixtures are not live-client evidence                  |
| Viewer on another physical device                               | UNVERIFIED / NOT RUN | No second device used                                         |

Archive SHA-256: **N/A — no archive exists**. Extracted executable and embedded
WASM SHA-256: **N/A**. A build-output executable is not an extracted archive and
does not establish packaged child execution.

## Failure 1: executable packaging

- **Expected:** Build a Linux x64 CLI archive containing the QuickJS WASM, then
  run the extracted executable's `__screen-run-child` smoke.
- **Actual:** Archive generation on the original head exited 1. The isolated
  failing build step on the rebased head also exited 1:

  ```text
  ServerCliExecutableImportError: /home/ubuntu/repos/goat/apps/server/dist-exe/bin.mjs imports file-backed packages that a single-executable cannot resolve: @jitl/quickjs-wasmfile-release-sync, quickjs-emscripten-core. Load them through createRequire instead.
      at file:///home/ubuntu/repos/goat/apps/server/scripts/cli.ts:145:23
  ```

- **Reproduction:** See the commands below. On the rebased head only the failing
  executable step was rerun, not the full archive builder.
- **Impact:** Blocks archive extraction/child smoke and archive-backed SSH
  provisioning. No success claim can be made for those paths.
- **Logs:** `archive-build-global-vp-retry.log`, `build-exe-diagnostic.log`
  (original head); `rebased-build-exe.log` (rebased head).
- **Overlap:** `ScreenRunChild.ts:3-4` statically imports both packages while
  `scripts/lib/cli-external-packages.ts:4-6` declares them external. Both are
  part of #1788. `apps/server/scripts/cli.ts:142-145` rejects emitted external
  ESM imports. No duplicate loader/packaging patch was introduced here.

## Failure 2: awaited-host-call deadline

- **Expected:** The cell returns `deadline` and retains one child.
- **Actual:** The deadline status assertion passes, but
  `ScreenRunSupervisor.test.ts:297` expects `activeCount()` to be 1 and receives 0. Both the original and rebased heads produced 33 PASS / 1 FAIL.
- **Reproduction:** Run the three focused files below. Each post-install run
  was executed once at its respective source head; no retry-to-green.
- **Impact:** Child retention across this deadline is not established. This
  does not prove a Stop, reconnect, or remote-viewer defect. The underlying
  cause has not been isolated, and the test expectation was not weakened.
- **Logs:** `screen-run-tests-retry.log` (original head),
  `rebased-screen-run-tests.log` (rebased head).
- **Overlap:** The supervisor and failing test are already in #1788. No patch.

## Commands

Global `vp` must precede the repository-local binary: the local CLI rejects
`vp env`, which the archive builder needs. Locked dependency installation and
Kache initialization repaired initial environment blockers; they did not fix
the product failures above.

```sh
# From /home/ubuntu/repos/goat:
PATH="$PWD/node_modules/.bin:$PATH" vp i --frozen-lockfile
kache init --check
kache init --yes --no-shell --no-service
kache doctor
export PATH="/home/ubuntu/.local/share/vite-plus/bin:/home/ubuntu/repos/goat/node_modules/.bin:$PATH"
vp env which node

# Original head: FAIL, exit 1
node scripts/dev-runtime-archive.ts --home-dir /home/ubuntu/goat-linux-screen-evidence/runtime-home --platform linux --arch x64

# Rebased head: FAIL, exit 1
vp exec node apps/server/scripts/cli.ts build-exe --target host --verbose

# From /home/ubuntu/repos/goat/apps/server; both heads: FAIL, exit 1
vp test run src/screenCode/ScreenRunSupervisor.test.ts src/screenCode/ScreenRunLifecycle.test.ts src/screenCode/ScreenRunTabClose.test.ts
```

NOT RUN: full archive builder on the rebased head, because its executable stage
still fails. NOT RUN: `node scripts/smoke-cli-archive.ts --archive <produced-archive>
--expect-version 0.1.2`, because no archive was produced. NOT RUN: SSH runtime
provisioning, server startup, and every live-client scenario listed above.
The session lacks the GOAT Browser `goat_call` tools required by `test-goat-app`;
no unrelated browser automation was substituted. No browser captures exist.

## Rebased evidence hashes

| File                                                                           | SHA-256                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `rebased-build-exe.log`                                                        | `0b27a7aca8c7dc77facb46b0ee922b1245f8c2d8089f0d7aa0ae27d11095d60e` |
| `rebased-screen-run-tests.log`                                                 | `6f72f96ae6c12f966f93ce92b2305ff1f3ddfa168b813817602da2306252ecd2` |
| `apps/server/dist-exe/goat` (unqualified build output, not archive extraction) | `4942a5176668b361d1539db1331f7f942e33067de3b2510490192ba916be57a6` |
| `apps/server/dist-exe/bin.mjs` (rejected bundle)                               | `05bca151b3cd0399e86de4e0fe7625875dba2a25a1e776ed7026e6bf567ca214` |

The remaining gate is upstream packaging/deadline resolution followed by a
fresh archive, SHA recording, packaged-child smoke, isolated SSH provisioning,
and real-client checks with local fixtures. This report is blocked evidence,
not a claim that no defects exist or that runtime validation is complete.
