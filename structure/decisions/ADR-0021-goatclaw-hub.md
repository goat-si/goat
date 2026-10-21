# ADR-0021 — decision recorded under "Providers"

- Contract owner: [server.md](../server.md#providers)
- Commit: pending on branch design/goatclaw-hub (recorded before implementation, 2026-10-21; draft for review)
- Design: [000_design.md](../../devlog/_plan/261021_goatclaw_hub/000_design.md)
- Related: [ADR-0016](ADR-0016-agentic-goals-controller.md), [ADR-0018](ADR-0018-agentic-resources-fallback.md),
  [ADR-0019](ADR-0019-update-compatibility.md), ADR-0020 host pressure (#676)

## Decision record

- **Purpose.** Configure one device, the hub, with every provider sign-in and the account pool, and run every
  other device from it without signing those devices in.
- **Before.**
  - OpenCodex already has Remote Link (Home and Child over SSH, one link key per Child, a read-only management
    relay) and Hub mode (HTTPS data plane, per-client data keys with provider and model scope, invite, rotate,
    revoke). The fleet ran macmini-ts and lidge-ts as Remote Link Children on 2026-10-11.
  - GOAT observes the Codex route (`OpenCodexRoute`, `CodexRouteStatus` including `home`), routes cloud launches to
    credential holders and reads per-instance quota windows. It sees no pool, and nothing checks that a Child is
    really served by its Home (OpenCodex #6957).
  - Supervisor decision D14: OpenCodex Hub and Remote Link are GOAT's default proxy path; Remote Workspace for
    remote execution is experimental.
- **Alternatives.**
  - A GOAT-owned routing layer with GOAT-issued per-device tokens through GOAT's SSH tunnels. It duplicates Remote
    Link and Hub-mode keys, rotation and revocation, and puts credentials in a second program.
  - Sign every device in to every provider with provider host sync. That is what the hub exists to avoid, and
    pooling stops at one machine.
  - Read OpenCodex's existing per-surface quota endpoints. They are dashboard projections with a different shape per
    provider, some trigger probes, and a Child cannot read all of them.
- **Decision.**
  - The hub is the OpenCodex Home. macOS and Linux devices join as Remote Link Children; devices Remote Link does not
    serve (Windows, password-only SSH) join as Hub-mode clients. GOAT runs OpenCodex's own commands over its
    existing SSH sessions, passes its pinned host key as the expected fingerprint, and never holds a link or data key.
  - GOAT computes a parity verdict per device from read-only evidence (role, link identity, one non-billed relayed
    request, served-by header, runtime freshness, Codex settings digest, client wiring, local-provider leak) and
    repairs with `ocx sync`, `ocx restart`, `ocx link reconnect`, then re-links behind a decision.
  - One provider-neutral quota pool schema, `ocx.quota-pool/1`, produced by OpenCodex as a passive read and consumed by
    GOAT as a new usage-limit source kind and an optional host-status field.
  - The hub is the default cloud credential holder. Paid launches need a profile capability and a person's request
    or an approved decision.
  - Compatibility is a verdict from OpenCodex's served protocols and features. Adopted installs are advised and never
    replaced; managed installs follow ADR-0019's trial, probation and rollback.
- **Reasons.** Credentials, rotation and revocation stay in the one program that already owns them. GOAT adds
  observation, placement and repair, which it already does for its own hosts.
- **Tradeoffs.** Remote Link keys are not model-scoped; scoping needs a Hub-mode client. Any local program on a Child
  reaches the Home without a key, as OpenCodex documents. Windows depends on Hub mode working under the Windows
  service, unverified until H6. Pooled personal subscriptions may conflict with provider terms; GOAT flags this and
  does not decide it.
