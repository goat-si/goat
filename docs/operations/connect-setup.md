# GOAT Connect setup

> **Status:** GOAT Connect (Clerk sign-in, hosted relay, and managed Cloudflare
> tunnels) is disabled in every build by `GOAT_CONNECT_ENABLED=false` in
> [`@goat/shared/goatConnect`](../../packages/shared/src/goatConnect.ts).
> GOAT Connect is coming soon. Public configuration does not enable it. This
> runbook retains setup details for the dormant implementation; use
> [direct pairing, Tailscale, or SSH](../user/remote-access.md) for current access.
> `goat connect` and its subcommands print the coming-soon message and exit 0.
> Stored links are retained without tunnel restoration; previously linked servers
> start normally.

Deployment and client configuration for GOAT Connect. The [architecture note](../internals/goat-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

The following public settings are retained for future Connect work and do not
activate Connect while the shared gate is off. The repository-root example is:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
GOAT_CLERK_PUBLISHABLE_KEY=<publishable key>
GOAT_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
GOAT_RELAY_URL=https://relay.example.com
GOAT_HOSTED_APP_URL=https://app.trygoat.ai
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, relay URL, and hosted origin.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the GOAT CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Disable **Device authorization grant**. Standalone device codes, `--headless`, SSH-inferred headless and the H fallback cannot authorize beta links.
5. Set `GOAT_CLERK_CLI_OAUTH_CLIENT_ID` in client builds and the identical `CLERK_CLI_OAUTH_CLIENT_ID` in the relay.

The normal CLI flow first obtains a two-minute browser approval bound to its target host, local origin, capabilities, proof key, state and separate S256 verifier. The browser posts approval to `/approval` on the loopback listener before navigating to Clerk OAuth; the CLI waits for both callbacks. It installs the link immediately and writes desired-link state only after installation. A direct Clerk OAuth login or refreshed CLI token cannot link a host. Cached credentials remain sufficient for account-owned unlink/release only.

## Required Clerk authentication policy

These are operator prerequisites; this change does not configure a Clerk account or enable Connect.
Use a dedicated production Clerk application with a plan that supports required MFA and passkeys.
Enable **Require multi-factor authentication**, TOTP and backup codes. Pending `setup-mfa` sessions cannot discover environments. Configure Clerk-owned password, email, passkey, MFA and backup-code changes to require both factors within ten minutes. There is no GOAT reset bypass.

Customize the **session token**, not a JWT template, with `aud` equal to the exact relay issuer (for example `https://relay.example.com`). Set the relay's `CLERK_JWT_AUDIENCE` to that same origin. Session JWT V2 must carry signed `sub`, `sid`, `iss`, `azp`, `iat`, `exp` and two verified `fva` ages. Clients request a session token with `skipCache:true` and no template. Retire `GOAT_CLERK_JWT_TEMPLATE`/`CLERK_JWT_TEMPLATE`; template tokens, OAuth consent, token issuance time, enrollment flags and native biometric unlock are not evidence of recent MFA.

Set `CLERK_AUTHORIZED_PARTIES` to a comma-separated list of exact admitted browser origins, including the production hosted app and the actual Clerk account portal. There is no suffix trust. The relay derives its exact Clerk issuer from its publishable key, checks the audience, rejects impersonation and verifies active session ownership through Clerk's Backend API. Provider failure denies issuance with a retryable 503. Keep `CLERK_SECRET_KEY` exclusively in relay secrets.

Prove Clerk's minute-age rounding and clock behavior before admission. GOAT conservatively subtracts `(age + 1)` minutes from signed token issuance time and requires both factor bounds to be less than ten minutes old for links and new client keys. Refreshing a token does not refresh authentication. Test first-factor-only and pending accounts, cancelled verification, inactive/revoked sessions, and passkey-only accounts whose actual signed evidence must satisfy the same check. Clerk's reverification APIs are public beta; the operator must accept that maturity or exclude the affected flow.

Capture signed Electron/iOS/Android token evidence and actual callbacks before allowing their origins. Do not invent browser `azp` for a native client or broadly trust native schemes. Unsupported native factor evidence is excluded from beta; use full MFA sign-in when its reverification UI is unavailable. Keep existing native callback registrations below for compatibility without granting them relay admission automatically.

## Hosted app and release admission

Production uses `https://app.trygoat.ai/`; ordinary sign-in and own-environment discovery start at `/`. `/connect` is exclusively the versioned CLI approval entry. Keep tunnel hosts on a separate apex. A tunnel page links to the hosted root without carrying credentials or arbitrary return URLs.

Build staging separately for `https://staging.app.trygoat.ai` with matching isolated Clerk/relay configuration. Rebuild production for its own origin; a staging build must never be promoted as production bytes. Record source SHA, artifact digest and the allowlisted public config for each. Worker static assets need SPA fallback for root/deep links and a noncached shell; authentication remains in the relay. The `Connect hosted artifacts` workflow builds both origins; deployment defaults off. Its Workers Static Assets config lives in `infra/connect-hosted`. Provision the four protected environments (`connect-staging`, `connect-staging-acceptance`, `connect-production`, `connect-production-acceptance`), require reviewers, and configure each origin’s allowlisted Clerk/relay values separately. Deployment environments also need the Pos090001 account ID and scoped Workers token. The workflow requires a published runtime manifest with the exact source commit before hosted delivery.

After each deployed smoke, put the live receipt in the corresponding acceptance environment’s `CONNECT_ACCEPTANCE_EVIDENCE` variable before approving that gate: `sourceSha`, `artifactDigest`, `origin`, durable HTTPS `evidenceUrl`, and true `emptyStorageRoot`, `deepLink`, `freshMfa`, `ownHostOnly`, `normalCliApprovalAndCode` results. Production also requires `rejectedOrigin` equal to the staging origin. The gate validates that evidence against the actual build receipt; it does not manufacture live MFA or CLI proof. Domain provisioning and executing deployment remain infrastructure work.

Before inviting anyone, record the exact first published nightly containing wp2, wp3 and wp7 as the minimum supported host/client release for auth policy 1. No semver minimum is assumed by this change. Quarantine legacy relay links, withdraw old relay tokens/client keys, and revoke pending host cloud grants and existing cloud sessions through the trusted upgrade path, then explicitly re-link. The nullable migration column deliberately leaves older records unsupported. Preserve direct access for upgrading; relay withdrawal cannot erase a directly reachable offline host session. wp2 owns local hub-consent/bootstrap generations and wp3 owns account suspension/security-reset generation changes; they must be integrated before admission. Account lifecycle writes must use the same per-account advisory lock as key admission and preserve suspended/deleted tombstones. The relay account generation, key admission ID and local hub-consent generation are separate authorities.

The beta is **reachability only**. Push and Live Activities remain unavailable regardless of APNs/Firebase key availability. Relay mobile-registration scopes are denied; queued push work is drained without delivery. Native registration and provider startup stay disabled. A separate audited push work-phase is required before activation.

Run the exact-artifact negative suite in staging, then repeat fresh-browser root/deep-link and normal CLI login on production. Confirm the production loopback receiver rejects the staging Origin. Browser loopback POST/CSP/local-network compatibility, live Clerk MFA/passkey evidence, EAS environment/config extraction, and signed Electron/iOS/Android clean/retained-state checks are launch gates, not claims established by unit tests.

Rollback must retain policy-1 enforcement and the additive tables/nullable legacy marker. Close Connect admission before rolling back to any earlier permissive relay. Do not treat old links as strong during rollback.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
goat-dev://app/
goat://app/
t3code-dev://app/
t3code://app/
```

Add the corresponding origins to the Clerk instance's Backend API `allowed_origins` array.
Development uses `goat-dev://app`; production uses `goat://app`. Keep the `t3code` entries for
older desktop builds; current macOS and Linux packages still register these legacy schemes.
Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                  |
| ----------- | ----------------------------------------- |
| Development | `clerk://si.goat.mobile.dev.callback`     |
| Preview     | `clerk://si.goat.mobile.preview.callback` |
| Production  | `clerk://si.goat.mobile.callback`         |

Preserve existing entries. These callbacks are separate from the `goat-dev` / `goat-preview` / `goat` navigation schemes. A private development build using the production Clerk key still needs its development callback allowed by that instance's administrator; rebuilding the same package does not change the allowlist.

## Desktop passkeys

Use bundle ID `si.goat.desktop` for stable macOS builds and `si.goat.desktop.nightly` for nightly builds. For each supported app:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.si.goat.desktop` or `<TEAM_ID>.si.goat.desktop.nightly`, matching the build.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
GOAT_APPLE_TEAM_ID=ABC1234567
GOAT_MACOS_PROVISIONING_PROFILE=/absolute/path/to/goat.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
GOAT_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
GOAT_PORT=13773 \
  "/Applications/GOAT (Nightly).app/Contents/MacOS/GOAT (Nightly)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/GOAT (Nightly).app"
codesign -d --entitlements :- "/Applications/GOAT (Nightly).app"
```

## Invite beta access and suspension

Clerk sign-up restrictions control who can create an identity. Relay access is a separate,
explicit invitation keyed by Clerk user ID; an absent account is denied. Clerk dashboard bans
and deletes do not synchronize relay status during the beta. Use the relay operator workflow
below. A Clerk ban or unban is an optional manual action; the relay never performs it.

Provision a nonempty `RELAY_OPERATOR_SECRET` through the trusted deployment environment, and
supply the same secret and an HTTPS `RELAY_OPERATOR_URL` to the operator CLI. Keep the secret out
of command arguments, logs, client configuration, and browser bundles. From `infra/relay`:

```sh
vp run accounts:access show user_fixture
vp run accounts:access allow user_fixture --key 10000000-0000-4000-8000-000000000001
vp run accounts:access suspend user_fixture --key 10000000-0000-4000-8000-000000000002
```

These example IDs are fixtures. Each intentional command needs a fresh idempotency key. Reusing
one for a different command returns a conflict. A suspension first commits relay denial and a
new account epoch, retires endpoint identities, and invalidates relay trust and delivery
eligibility. It returns an operation record; HTTP 202 and CLI exit 2 mean hook cleanup is still
pending. Use `operation <id>` to inspect it or `resume <id>` to advance it. The five-minute cron
also resumes due operations in bounded batches. Opposite transitions conflict while cleanup is
pending. Allow creates a new epoch only after relay cleanup finishes; it restores none of the
old credentials, registrations, queued deliveries, or held hooks.

The default limits are one held current-generation tunnel allocation, ten active environment
links including publish-only links, and ten mobile device records. Existing tunnel overrides,
including zero, remain authoritative. Failed and in-flight current-generation reservations
still consume capacity. Strict aligned hourly request budgets are 20 link challenges, 10 links
or create-capable recoveries, 120 token exchanges, and 120 connects. Registration and publication
have separate approximate minute limits. A 403 reports access or resource policy, a 429 carries
`Retry-After`, and unavailable authorization storage or limiters return 503.

After suspension and allow, explicitly relink each host and register its mobile devices again.
The new endpoint generation changes the Connect address and webhook URLs; update webhook
senders. Ordinary unlink/relink retains the endpoint generation. A continuously repeated stage
inventory removes retired tunnels and DNS records, even if a delayed provider mutation appears
after an earlier empty scan. Provider cleanup is best effort and does not block allow; its
observed resource backlog remains visible during failures. Current-generation abandoned creates
are adopted on the next link or recovery request, not automatically by the live tunnel reaper.

Hosts with a ready connector probe their public environment descriptor at most once every ten
minutes. Two failures request recovery. DNS repair takes up to twenty minutes for detection,
plus recovery scheduling/backoff (two to thirty minutes), and depends on relay reachability and
available request budget. DNS-only repair charges `connect`; a missing tunnel must acquire the
`link` allowance before creation. Honor a longer `Retry-After`. There is no unconditional repair
or provider-cleanup deadline.

Relay suspension does not close already issued environment-direct sessions or LAN, Tailscale,
and SSH sessions. An external send already admitted before suspension may finish; it cannot
restore delivery eligibility. The beta supports one owning account per environment key.
Transfer requires unlink and cleanup on the existing owner followed by a fresh signed link.

## Migrating a relay to account policy

Keep admission closed and drain old Workers, queue consumers, and outstanding provisioning
before applying the forward migrations and guarded runtime together. The migration refuses
conflicting active environment keys, malformed allocation identities, and negative tunnel
limits. Resolve those records explicitly; it never picks an owner or invites historical users.
Legacy endpoint identities bind to the running stage on first guarded use because a sanitized
tunnel name cannot recover the original raw stage. Legacy credentials and tokens require relink
or refresh, and old queue/hook payloads are dropped. Roll back with a forward fix while admission
stays closed; an old Worker does not enforce the new tables.

Generation zero keeps its original endpoint digest. Later generations use a domain-separated
JSON encoding. Before upgrading a stage that has already run the beta policy, inspect its
identities with a read-only connection; substitute the deployed raw stage for `__legacy__`:

```sql
WITH candidates AS (
  SELECT stage, user_id, environment_id, high_water_generation AS generation,
    left(encode(sha256(convert_to(stage || ':' || user_id || ':' || environment_id ||
      CASE WHEN high_water_generation = 0 THEN '' ELSE ':' || high_water_generation END,
      'UTF8')), 'hex'), 16) AS endpoint_key
  FROM relay_endpoint_identities
  UNION
  SELECT stage, user_id, environment_id, generation, endpoint_key
  FROM relay_retired_endpoints
)
SELECT stage, endpoint_key, count(DISTINCT (user_id, environment_id, generation))
FROM candidates
GROUP BY stage, endpoint_key
HAVING count(DISTINCT (user_id, environment_id, generation)) > 1;

SELECT stage, user_id, environment_id, high_water_generation
FROM relay_endpoint_identities WHERE high_water_generation > 0;
```

Any collision requires explicit operator resolution while admission stays closed. Any existing
positive-generation identity also blocks this encoding upgrade: inventory its allocated and
retired tunnel names and hostnames, retire the old names, and advance to unused identities
before admitting traffic. Do not simply recompute a live positive-generation address or discard
its historical names. A stage with only generation-zero identities needs no address migration.

The relay CI lane includes real PostgreSQL migration and concurrency tests and local workerd
restart tests. Hosted Linux runners may install PostgreSQL; self-hosted runners must provide
`pg_config`, `initdb`, `postgres`, `pg_ctl`, and `psql` (or test-only `PG_BIN`). The prerequisite
creates and stops a private socket-only cluster. It never accepts a live relay database URL.
A missing prerequisite fails the lane rather than skipping proof. Worker fixtures require local
Alchemy provider mode and refuse a cloud fallback. Public Connect activation remains separate.
