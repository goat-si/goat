# GOAT Connect troubleshooting

Managed GOAT Connect routes are currently unavailable in GOAT. Use
[direct pairing or Tailscale](./remote-access.md) to connect devices. The checks below
apply to builds with GOAT Connect enabled.

In an enabled beta build, start ordinary account sign-in at [the hosted app](https://app.trygoat.ai/). Connect requires MFA. If GOAT asks for recent verification, verify both factors and retry; on native clients without a verification prompt, sign out and sign in with MFA again. Update both host and client when GOAT asks for a supported release, then re-link the host.

The beta provides remote reachability. Push notifications and Live Activities are unavailable. `goat connect` needs a local browser and a matching browser approval; device codes and headless linking are unavailable. For a headless host, pair an updated browser over local networking, Tailscale or SSH and link in Settings.

`goat connect logout` removes local authorization even if remote revocation is unavailable. When it reports **remote revocation pending**, retry the printed command or withdraw the environment from your hosted account. Signing out locally alone does not prove remote access was revoked.

A GOAT Connect connection goes through four parts, in this order:

1. **This device** reaches GOAT Connect over the internet.
2. **GOAT Connect** checks your sign-in and the host's link.
3. **The host's tunnel** (cloudflared on the host) carries the request to the host.
4. **GOAT on the host** answers.

When a connection fails, open **Settings > Connections**, find the environment,
and select **Details**. The first part marked as failed is the cause. Find its
section below.

To see the host's side, run `goat connect status` on the host, or open
**Settings > Connections** on the host. Both check the host's GOAT Connect
address from the host, and say why it fails. `goat connect` runs the same check
when it finishes setup. This check cannot test another device's network. For a
problem on one device, use **Details** on that device.

## The host's tunnel is offline

GOAT Connect could not reach the host's tunnel. This means one of these:

- The host is asleep, turned off, or offline.
- GOAT is not running on the host.
- The host's network blocks the tunnel. See
  [Port 7844 is blocked on the host](#port-7844-is-blocked-on-the-host).

Fix:

1. Make sure the host is awake and GOAT runs on it.
2. On the host, run `goat connect status`. It names the problem on the host's side.
3. If the host was offline for a long time, GOAT Connect removes its tunnel. Start
   GOAT on the host and update it to a supported version. Run `goat connect` again, or re-link in Settings, and verify both authentication factors.

## Port 7844 is blocked on the host

The tunnel on the host connects out to Cloudflare on port 7844, with TCP and
UDP. Both tunnel protocols (QUIC and HTTP/2) use this port. When the host's
network blocks it, the tunnel cannot start, but normal web traffic still works.
The host looks online, so this problem is easy to miss.

Common causes:

- **A Tailscale exit node on the host.** All of the host's internet traffic goes
  through the exit node, and that network blocks port 7844. Turn off the exit
  node on the host with `tailscale set --exit-node=`, or allow outbound port
  7844 on the exit node's network.
- **A VPN on the host.** Work VPNs often block unknown ports. Ask for port 7844
  to be allowed, or use a direct route instead (see below).
- **A firewall or strict network.** Allow outbound TCP and UDP port 7844.

If you cannot unblock the port, you can connect without GOAT Connect. When the
host and this device are on the same Tailscale network, add the host's
Tailscale address as a direct route. See
[Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

<a id="the-tunnel-works-but-t3-code-does-not-answer"></a>

## The tunnel works, but GOAT does not answer

The host's tunnel is up, but it cannot reach GOAT on the host. Common causes:

- GOAT on the host stopped, crashed, or is still starting.
- GOAT restarted on a different port, for example after an update, and the
  tunnel still points at the old port.
- The server binds only one network address with `GOAT_HOST`. The tunnel
  sends requests to `127.0.0.1`, so the server must also listen there.

Fix: restart GOAT on the host. For the background service, run
`goat service restart`. If the local port changed, explicitly re-link with `goat connect` or Settings. Then run `goat connect status`.

<a id="the-t3-connect-address-does-not-resolve-or-answer"></a>

## The GOAT Connect address does not resolve or answer

The host's GOAT Connect address did not resolve, refused the connection, failed a
secure (TLS) connection, or did not answer in time.

Fix:

1. Make sure the host is awake and online.
2. On the host, run `goat connect status`.
3. If the check fails only on the host, check the host's DNS, VPN, or proxy.

<a id="this-device-cant-reach-t3-connect"></a>

## This device can't reach GOAT Connect

The problem is on this device's network, not on the host. This device could
not reach GOAT Connect, or it reached GOAT Connect but not the host's tunnel
address.

Fix:

1. Check this device's internet connection. On a captive or dead Wi-Fi network,
   the device can look online but cannot reach anything.
2. A VPN, firewall, ad blocker, or DNS filter on this device can block GOAT
   Connect. Turn it off for a moment to test.
3. On iPhone, Connectivity Assist in the Wi-Fi settings can break GOAT Connect.
   Turn it off to test.
4. Try another network, or add a direct route to the host, such as its
   Tailscale address. See
   [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## Sign-in, account, or link problems

GOAT Connect does not have an active link between your account and the host.

- **The host is linked to a different account.** Sign in to the same GOAT Connect
  account on this device and on the host. On the host, run `goat connect logout`,
  then `goat connect`.
- **GOAT Connect is off on the host, or the host only publishes agent activity.**
  On the host, open **Settings > Connections** and turn **GOAT Connect** on, or
  run `goat connect`.
- **The host was linked, but the server did not apply the link yet.** Run
  `goat service restart` on the host, or restart `goat serve`.
- **This device's sign-in expired, or the host no longer accepts this
  device.** Sign out of GOAT Connect and sign in again.
- **Your account reached its tunnel limit.** Remove an environment you do not
  use from your account's GOAT Connect page, then restart GOAT on the host.

## The clock is off

GOAT Connect signs requests with short-lived proofs. When the clock on this
device or the host is a few minutes wrong, GOAT Connect rejects them. Turn on
automatic date and time on both devices, then retry.

<a id="the-host-runs-an-older-t3-code"></a>

## The host runs an older GOAT

This app needs a newer GOAT on the host. Update GOAT on the host. See
[Updating GOAT](./updating.md).

<a id="t3-connect-returned-an-error"></a>

## GOAT Connect returned an error

| Error                                                     | Fix                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Remove an unused environment, then restart GOAT on the host.                                                                                      |
| `auth_invalid` or `invalid_bearer`                        | Run `goat connect login`. If credentials were revoked, run `goat connect logout`, then `goat connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update GOAT, then restart it.                                                                                     |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                     |
| HTTP 408, 429, or 5xx                                     | Wait a few minutes. GOAT retries temporary failures on its own.                                                                                   |

After you fix a permanent rejection, restart the host's server with
`goat service restart`. For a foreground server, stop it and run `goat serve` again.

If GOAT on the host disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

For privacy requests and account deletion, see the
[Connect privacy policy](https://trygoat.ai/privacy-policy/). The invite-only beta's
[terms](https://trygoat.ai/terms-of-service/) explain its availability and support limits.
Report vulnerabilities privately through the
[security contact](https://trygoat.ai/security-policy/), rather than a public issue.

If none of this helps, open an issue on
[GitHub](https://github.com/goat-si/goat/issues). Include:

- The text from **Copy diagnostics** in the environment's **Details**.
- The output of `goat connect status` on the host.
- The trace ID, if one is shown.
