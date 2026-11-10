# pen-login

The Pen login service (contract "Accounts (v1.1)" in `packages/pen-protocol/CONTRACT.md`): a Cloudflare Worker and
one SQLite-backed Durable Object (`Login`, `idFromName("global")`) that runs the device flow, verifies a Google
sign-in, mints short-lived assertions with its Ed25519 login key, and keeps the account-to-mesh registry.

## Dev and test

`pnpm test` starts `wrangler dev` with a fake OpenID issuer in the test process (discovery, JWKS, authorize and
token endpoints, an RSA key made for the run) and walks the flow as a browser would. The Worker honours
`GOOGLE_DISCOVERY` and `GOOGLE_ISSUER` only when both the request and the discovery URL are on localhost;
deployed, it always talks to Google. `DEVICE_TTL_MS`, `SOURCE_SESSION_CAP`, `SOURCE_DEVICE_CAP`, `JWKS_TTL_MS` and
`JWKS_REFETCH_MS` exist for tests and can only lower their defaults.

## Deploy

Set three secrets, reading each from a file or prompt so it never reaches a shell history or log:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the OAuth client whose redirect URI is
`https://pen-login.pos090001.workers.dev/v1/auth/google/callback`), and `LOGIN_SIGNING_KEY`, a base64url
Ed25519 seed (32 bytes) generated for this service. Then `pnpm run deploy`. `GET /v1/keys` shows the login key's
`kid` and public key.

## What the service sees

Showing a page stores nothing: the browser holds a signed cookie, and a session row exists only once it heads to
Google. For each sign-in: the machine's public keys and name, the requesting address (kept only as a rate-limit key and
the country and city shown on the confirm page), and the Google account's `sub` and email from a verified
id_token. It keeps no Google tokens, never holds a mesh key, and logs nothing; Worker observability is off. The
registry keeps, per account, one mesh id and the nodes registered under it until a member forgets them or the
person resets the account.
