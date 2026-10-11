VERDICT: FAIL

Plan paths below are relative to `devlog/_plan/261012_release_nightly/`. Review remained read-only.

**Round-one blockers**

1. **RESOLVED — cancellation:** `020_wp2_pipeline.md:17`, `:33` remove workflow-level cancellation and give build targets separate cancelling groups.
2. **RESOLVED — job setup:** `020_wp2_pipeline.md:20`, `:24`, `:31` specify verified checkout, installation, prepare authentication, and publish setup.
3. **RESOLVED — artifact dependencies:** `020_wp2_pipeline.md:26`–`:29` produce CLI archives first, stage resource monitors, provide SSH/WSL archives, and use `--skip-build`.
4. **UNRESOLVED — guard boundary:** `010_wp1_foundation.md:62` requires `needs: prepare` but does not validate downstream conditions; `if: always()` can run a signing job after prepare was skipped. Require successful prepare and nonempty verified outputs in accepted job conditions; add that adversarial test. [GitHub documents this dependency override](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).
5. **UNRESOLVED — SSH result consumers:** `030_wp3_wiring.md:140` claims a complete chain but omits `apps/server/src/sshRemote/SshRemoteDispatch.ts:598` and `:704`; both assume bootstrap success and subsequently access `httpBaseUrl` (`:607`, `:732`). Add pending-result narrowing before session issuance, connected-host registration, or MCP calls, with focused tests.
6. **UNRESOLVED — mutex recovery:** `030_wp3_wiring.md:201` introduces a successor-removal race: two recoverers observe a dead owner; one recovers and acquires; the other renames that live successor’s lock before checking its target. Restoration happens too late. Use a proven successor-safe recovery protocol and rewrite `:209`–`:213`, whose owner-file/`rmdir` cleanup still describes a directory lock.
7. **RESOLVED — activity transport:** `030_wp3_wiring.md:64`–`:70` use actual backend configuration, validate native PID/config, and explicitly classify running WSL as unknown.
8. **RESOLVED — updater lifecycle:** `030_wp3_wiring.md:24`, `:49`, `:76` define reservation-release coordination, durable pending intent, online cache restoration, and app-owned quit installation.
9. **RESOLVED — publication:** `020_wp2_pipeline.md:75`–`:83` specify pagination, identical-publication success, digest-or-download verification, checksum-file hashing, and draft reconciliation.
10. **RESOLVED — retention:** `020_wp2_pipeline.md:31`, `:86` wire protected tags, gate pruning on publication, protect the current feed release, and address orphan tags.
11. **UNRESOLVED — payload scan execution:** `020_wp2_pipeline.md:28`, `:68` scan `release/<platform>-unpacked`, but the actual builder copies only files into `release` (`scripts/build-desktop-artifact.ts:4404`–`:4411`). Unpacked directories remain under temporary `stageDistDir` (`:4357`). Add an in-builder verification/report hook before stage cleanup, or explicitly retain and expose the real stage path.

**NEW blockers**

1. **Workflow environment bindings disappeared during the rewrite.** `020_wp2_pipeline.md:27` refers to “feed + notarization env (§2)”, but §2 only describes credential handling; `:28` supplies no feed environment for Windows/Linux. Mac CLI at `:26` requires notarization without specifying its profile environment. Preflight exports only signing identity/keychain variables (`040_wp4_runner_delivery.md:7`). Publish at `:31` also omits connecting the App action’s token output to `GOAT_RELEASES_TOKEN`, which the client requires (`:75`).

   Restore explicit mappings: feed enabled plus `goat-si/goat-releases` for every desktop job; `APPLE_KEYCHAIN_PROFILE=goat-notary`, keychain path, and required-notarization mode for Mac signing steps; App token output to `GOAT_RELEASES_TOKEN` only on publish/prune steps. Without these bindings, feed configuration is silently omitted (`scripts/build-desktop-artifact.ts:2764`–`:2766`), required CLI notarization fails, or publication lacks authentication.

**Non-blocking notes**

- Add `prepare` explicitly to assemble’s `needs` at `020_wp2_pipeline.md:30`, matching the guard and its checkout expression.
- Reconcile stale decisions in `000_plan.md:28`, `:29`, `:38` with the revised concurrency, dispatched-ref behavior, and mutex design; remove superseded lock instructions from 030.
- Put the whole-payload notarization ZIP outside `contentDir`; the current output location is inside it (`scripts/build-cli-archive.ts:349`).
- Bind verification reports to version/build key and scanned payload identity, rather than accepting an unrelated `ok` report.
- WSL postponement and offline recovery limitations are now explicit. GitHub runner/environment hardening remains a user activation prerequisite; no external changes are authorized by this audit.
