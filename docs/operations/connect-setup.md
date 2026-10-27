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

Build staging separately for `https://staging.app.trygoat.ai` with matching isolated Clerk/relay configuration. Rebuild production for its own origin; a staging build must never be promoted as production bytes. Record source SHA, artifact digest and the allowlisted public config for each. Worker static assets need SPA fallback for root/deep links and a noncached shell; authentication remains in the relay. Domain provisioning, hosting deployment and promotion belong to the infrastructure lane.

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

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
