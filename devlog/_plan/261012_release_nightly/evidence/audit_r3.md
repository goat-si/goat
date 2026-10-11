VERDICT: FAIL

Plan paths below are relative to `devlog/_plan/261012_release_nightly/`.

**Round-two unresolved items**

1. **Guard boundary — RESOLVED.** `010_wp1_foundation.md:62` now requires successful, non-skipped prepare in every downstream condition; `:67` adds bypass tests.
2. **SSH consumers — UNRESOLVED, small correction.** The missing server consumers are covered at `030_wp3_wiring.md:150`, but `failure("remote_unavailable", ...)` uses a nonexistent reason. `apps/server/src/sshRemote/SshRemoteDispatch.ts:52`–`:58` permits `host_unavailable`, and its `failure` helper is typed accordingly (`:192`). Use the existing `host_unavailable` reason.
3. **Mutex recovery — RESOLVED.** `030_wp3_wiring.md:194`–`:209` replace rename-based recovery with serialized recovery, owner revalidation, dead-owner proof, and consistent symlink cleanup. A crashed recovery owner conservatively leaves contention requiring manual recovery.
4. **Payload scan execution — RESOLVED.** `020_wp2_pipeline.md:86` places the hook before the copy loop while `stageDistDir` exists, matching `scripts/build-desktop-artifact.ts:4392`–`:4411`.

**Round-two new blocker**

5. **Environment bindings — RESOLVED.** `020_wp2_pipeline.md:38`–`:49` explicitly bind desktop feeds, Mac notarization, App-token authentication, and protected tags to their intended steps.

**NEW blocker**

1. **Report hashes become stale before assembly.** `020_wp2_pipeline.md:85` requires report input hashes to match release assets; `:86` records those hashes inside the builder. Subsequent processing changes those assets:

   - DMG finalization changes DMG bytes and manifest hashes/sizes (`:76`).
   - Collection renames architecture manifests (`:27`, `:28`).
   - Assembly merges/deletes manifests and removes `builder-debug.yml` (`:30`).

   Consequently, legitimate reports can fail the new matching rule. Define report inputs around immutable distributable payload artifacts; exclude intermediate manifests/debug files. For Mac, bind final DMG/ZIP bytes through the post-finalization verifier, while preserving the builder exposure result through an explicit association. Specify how deleted/regenerated blockmaps are handled.

   Add one focused test covering **builder report → DMG finalization → manifest rename/merge → assembly**, proving legitimate transformations pass and substituted binaries fail.

**Notes**

- Resolve `APPLE_KEYCHAIN` from preflight’s absolute keychain path directly (`020_wp2_pipeline.md:42`); avoid relying on `${{ env.HOME }}` unless that context value is explicitly established.
- `000_plan.md:29` still says dispatch reads only the default branch’s workflow, contradicting the corrected dispatched-ref explanation at `:28`.
- Whole-payload CLI notarization now places its ZIP outside `contentDir`, closing the earlier archive-location issue.
- No files, git state, servers, or external settings were changed.
