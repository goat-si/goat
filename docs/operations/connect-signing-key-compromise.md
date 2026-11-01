# Connect signing-key incident

The incident operator must have explicit deployment authority. This procedure does not enable
the dormant public Connect feature. Record stage, serving revision, affected host versions,
public key fingerprints and each host's confirmed or unconfirmed state. Never record private
keys, bearer credentials, pairing URLs or account profiles.

1. Set `RELAY_MINT_DISABLED=true` in the trusted relay deployment environment and deploy the
   affected stage using the relay README's deployment procedure. Confirm every serving Worker
   runs that revision. Verify typed, no-store 503 `relay_mint_disabled` responses for POST
   `/v1/client/dpop-token`, `/v1/client/environment-link-challenges`,
   `/v1/client/environment-links`, and `/v1/environments/<id>/{connect,status,tunnel,tunnel/recovery}`.
   CORS preflight, deletion/status, webhook ingress, host cleanup/ack, unlink/release and cron
   must remain available. Editing a local `.env` does not pause deployed traffic.
2. Use `vp run accounts:access suspend <subject> --key <fresh-key>` from `infra/relay` to deny
   affected accounts and retire their endpoints. Record operation status with `operation <id>`;
   retry with `resume <id>`. Inventory hosts before deleting account metadata. Provider tunnels,
   existing queues and in-flight requests can still incur cost; pause alone does not revoke
   sessions or make a stolen signing key harmless.
3. On every reachable host, use a previously trusted local, Tailscale or SSH administrative
   connection, independent of the compromised key. Run `goat connect unlink` against its trusted
   running server and require confirmed local grant/session withdrawal. A failed or offline
   result is pending; restart the supported host to finish its persisted withdrawal before
   network admission or relink. Keep unreachable hosts explicitly unconfirmed. Never replace
   trust using only a proof signed by the compromised key.
4. Confirm all cloud-connect grants and sessions were revoked, including standard-only grants,
   unused bootstraps, browser cookies, bearer/DPoP sessions and WebSocket tickets. Confirm idle
   RPC and hub sockets closed through the session-store invalidation path. Preserve independent
   pairings. If durable journal/fence writes fail, keep the host isolated: process-local denial
   cannot survive a crash without a persistent marker.
5. Review an incident-specific resource replacement for `CloudMintKeyPair` in
   `infra/relay/src/worker.ts`, for example `CloudMintKeyPair-<incident-id>`. Alchemy preserves a
   key resource across ordinary deploys; redeploying the same resource is not rotation. Deploy
   the replacement while issuance remains paused. Compare public fingerprints and confirm no
   serving Worker references the old private key. Do not delete shared Alchemy state. Review
   deployment/state-store credential compromise separately; the APNs job secret and
   `RELAY_SUBJECT_DIGEST_KEY` are independent and must not be rotated as mint keys.
6. Through the trusted host path, reinstall/relink only the approved replacement public key
   after local withdrawal completes. Check its fingerprint out of band. Test a fresh,
   otherwise-valid, nonreplayed old-key mint proof and an old-key held-hook proof against the
   actual host; both must be rejected. Test old credentials/tickets and confirm sockets remain
   closed. Prove a fresh new-key mint works. Expired proofs, wrong audiences, replay rejection
   or the dormant feature gate are insufficient negative canaries.
7. Re-enable issuance with `RELAY_MINT_DISABLED=false` only under explicit operator authority,
   after confirmed hosts pass canaries and remaining hosts are isolated with recorded residuals.
   Deploy and verify issuance resumes. Re-allow selected accounts only after remediation; do
   not re-allow a terminally deleted subject. Keep provider cleanup and host acknowledgment
   backlogs visible until resolved.

Account deletion erases active relay business data subject to the retained-denial policy in the
[setup runbook](./connect-setup.md#deletion-retained-denial-and-offline-machines). It is not a
substitute for trusted-path key rotation and local credential withdrawal.
