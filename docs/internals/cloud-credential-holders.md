# Cloud credential holders

Claude Cloud, Cursor Cloud and Devin Cloud each run under one vendor sign-in. Signing every
machine in to every vendor is impractical, so a cloud launch goes to whichever connected
environment already holds that sign-in: a **credential holder**. The caller never needs the
credential, and the credential never leaves the holder.

## The model

A holder is one environment, this one or a connected SSH host, whose own provider instance for
the driver is ready. Each holder answers for itself with the same read-only checks as
`goat_provider_diagnose`, reduced to `{ready, accountLabel?, reason?, command?}`
([cloudHolders.ts](../../apps/server/src/cloudAgents/cloudHolders.ts)). Nothing in that answer
can carry a secret: diagnosis results never hold credential values, and the account label is the
provider snapshot's display label.

[CloudAgentService](../../apps/server/src/cloudAgents/CloudAgentService.ts) reads that
answer from the provider × host matrix. The `cloud` column (claudeCloud, cursorCloud,
devinCloud) is opt-in: a matrix includes it only when called with `cloud: true`, because
that diagnoses Claude Cloud, Cursor Cloud and Devin Cloud on every machine. Settings
reads the matrix without the flag and does not diagnose. Holder routing passes
`cloud: true` for this environment and for each connected SSH host. It caches answers
for a minute, forgets hosts that disconnect, and never caches an unreachable host. A
host that lacks `goat_provider_host_matrix`, or whose row omits `cloud`, is read the
older way: `goat_cloud_agent_holders`, then `goat_provider_diagnose`. Diagnosis-only hosts
are `runtime: "update_required"` and are never chosen. If this environment's matrix
cannot be read, its holders are not ready.

Selection is deliberately small: the caller's `holder`, else the hub, else a ready current
holder with the fewest active cloud runs, then this environment, then hosts by name. The hub is
the environment with `hub.enabled` and `hub.cloudHolder: "hub"` (the default); its matrix cells
carry `hub: true`, so every device finds it in the same table. The hub counts as an explicit
choice: when it has no usable login or cannot be reached the launch fails, because any other
holder bills a different account. Fallback chains, budgets and scheduling belong to the agentic
resource work, not here.

With goatclaw on, the `cloud.launch` capability alone does not admit a launch from
`goat_cloud_agent_launch`, a cloud `goat_thread_launch` or a cloud `goat_task_create`. The calling
run must have been started by a person from a web or mobile client, or the call names a
decision from the same caller that a person answered `approve`. Each admission is an
`audit_events` row, which is also what makes a decision good for one launch.

## Launching on a holder

`goat_cloud_agent_launch` forwards to the holder as the same tool with `holder:"local"`, through
`HostThreadsMcpService.writeOnHost`, so the remote GOAT applies the caller's forwarded ceilings
again. On the holder it is an ordinary thread launch on its cloud instance, in its project whose
origin is the repository. Everything after that, including source preflight, accepted-task
identity, reattach after restart and completion webhooks, is the existing cloud thread path.

## Registered runs

Other bots start cloud runs themselves. `goat_cloud_agent_run_register` makes such a run a GOAT thread
whose provider thread carries the task with `attach: "registered"`. The thread's first run calls
the adapter's `resumeTurn` instead of `startTurn`
([ProviderTurnStartService](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts)):
it observes and never submits. A run that ends is therefore an ordinary run completion, so
launch watches and `run.completed` webhooks need nothing new.

Three rules keep registration from being a confused deputy:

- The link GOAT stores is rebuilt from a provider id that matches the provider's own format
  (`parseCloudRunReference` in [cloudAgents.ts](../../packages/contracts/src/cloudAgents.ts)).
  Nothing a caller sends is fetched.
- The holder follows the run only through its own sign-in. If that account cannot see the run,
  the attach fails and the task becomes `tracking: "link-only"`. GOAT never reports a result it
  did not observe: the launch watch skips `run.completed` for a link-only registration.
- Devin's CLI binds sessions to the sign-in that created them, so registered Devin sessions are
  link-only by design.

GOAT never cancels a run it did not launch. Stopping a registered run's turn ends observation and
leaves the task `tracking: "link-only"` (the Cursor adapter's `interruptTurn`); forgetting it
deletes its thread. Either way the vendor run keeps running, and only its owner cancels it.

## Adding a provider

A provider plugs in with three pieces, all already per-driver:

1. **Detect**: its readiness appears in provider diagnosis.
2. **Launch**: its driver accepts an ordinary cloud thread launch.
3. **Observe**: its adapter implements `resumeTurn` for a task it did not submit, keyed by the
   provider's own id, and `parseCloudRunReference` knows its id format and origin.

Codex Cloud is on hold because the Codex CLI only talks to the legacy cloud backend
(openai/codex#50182). When that changes, it joins by adding the three pieces above and its literal
to `CloudAgentProvider`; holder routing, registration and Fleet need no change.
