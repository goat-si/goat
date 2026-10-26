# ADR-0024 — decision recorded under "App server"

- Contract owner: [ssh.md](../ssh.md#app-server)
- Issue: goat-si/goat#1707
- Commit: `4cf706e158` on `fix/single-server-attach-1707` (the decision is Jun's of 2026-10-26: the
  server a host already runs is the one remote hubs connect to)
- Related: [ADR-0005](ADR-0005-desktop-home.md), [ADR-0012](ADR-0012-shared-ssh-runtime.md)

## Decision record

- **Purpose.** A hub listing, reading or launching threads on a host should see the threads the
  person runs in the GOAT app there, and host status should count them.
- **Before.** The packaged app runs its own server on `~/.goat/desktop` (ADR-0005). SSH clients
  only knew `~/.goat` (ADR-0006, ADR-0012), so on a host with the app they started a second,
  headless server with its own database. Hubs saw only that one, and host status reported
  `threads.running: 0` beside five running app threads. The app attached the headless server as
  an extra environment, which fixed the app's view but not the hub's.
- **Alternatives.**
  - Move the app onto `~/.goat`, so one owner lock decides. That is a migration of every installed
    app's data, and hosts that already hold both databases would still need a merge nobody can do
    safely.
  - Merge or replicate the two databases. Event-sourced state from two writers has no safe merge.
  - Attach to the app server through the existing runtime selection. Selection pins the
    session-issuing CLI to the live server's version, which would require installing the app's
    exact build as a managed runtime, and `goat auth --base-dir ~/.goat/desktop` with any other
    build would migrate or refuse the app's live database.
  - Retire the managed server when the app starts. That interrupts work a hub dispatched there and
    hides its threads from the app.
- **Decision.** SSH clients prefer the app's live server and attach to it attach-only. It issues
  their credentials itself over a loopback route guarded by its `runtime-control.token`. The
  managed server starts only when no app server can serve the client. A managed server tells
  attached clients the app server is live, and they move once it is idle.
- **Reasons.** The app's database is where the person's threads are, so preferring it gives one
  view per host without moving data. Issuing credentials in-process avoids running a CLI of
  another build against a live database. Moving only idle attachments keeps dispatched work and
  its watchers on the server that runs it.
- **Tradeoffs.**
  - Two databases still exist on hosts that ran both. Threads in the managed one stay visible in
    the app as **Headless server** while it runs, and to hubs only while the app is closed.
  - Work a hub starts on the app server stops when the person quits the app.
  - An older app without `runtimeSessions`, a host without `curl`, and Windows hosts keep the
    managed server.
