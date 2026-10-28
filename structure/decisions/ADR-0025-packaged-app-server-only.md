# ADR-0025 — decision recorded under "App server"

- Contract owner: [ssh.md](../ssh.md#app-server)
- Issues: goat-si/goat#1841, goat-si/goat#1842
- Commit: on `fix/ssh-attach-reliability`
- Related: [ADR-0024](ADR-0024-one-host-server.md)

## Decision record

- **Purpose.** Decide which servers on a host count as its app server, and what happens when more
  than one could.
- **Before.** The probe searched nightly, stable, `~/.goat/dev` and `~/.t3/dev`, and attached the
  first live one. A server run from source could become the host's server when the packaged app's
  record was dead or declined, and a live stable app behind a live nightly was passed over without
  a trace.
- **Alternatives.**
  - Keep the dev homes but try them last, or behind an opt-in. A last-resort attach still sends a
    hub's work into a database meant for development, and an opt-in is machinery nobody asked for.
  - Attach to every live app server, or pick by version. One host would again be several
    environments, which ADR-0024 set out to end.
  - Add the attached channel and the passed-over apps to the host status contract. The attached
    server's `serverVersion` already names its channel.
- **Decision.** Only the packaged app's homes are attach targets: nightly (including preview), then
  stable. The first live one wins. The probe reports the home it attached and every other app home
  whose record names a live process, and logs `ssh.appServer.otherLive` when there is one.
- **Reasons.** The host's server is the app the person runs. A development server is a maintainer's
  sandbox. Reporting the other app keeps the one-server rule while making its cost visible.
- **Tradeoffs.**
  - With nightly and stable both running, hubs see only the nightly app's threads.
  - A maintainer testing SSH attach against a desktop build run from source gets the managed server
    instead; set `GOAT_HOME` and a packaged build to test the attach path.
  - The other-app report checks only that the recorded process lives; it does not prove that server
    answers.
