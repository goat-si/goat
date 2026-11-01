# ADR-0018 — decision recorded under "Fleet goals"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#fleet-goals)
- Commit: pending on branch docs/agentic-k8s-design (recorded before implementation, 2026-10-20)
- Design: [agentic-k8s.md](../../docs/internals/agentic-k8s.md)

## Decision record

- 목적과 의도: Cap how much work runs per host, globally and per goal, place work by quota and load, and let work continue on a configured fallback model or CLI when a model hits its limit or fails, instead of waiting for the reset.
- 기존 구현 및 제약 조건: `choosePlacement` (`apps/server/src/channels/channelPlacement.ts`) scores channel tasks by the busiest quota window and running tasks. Host status reports load and quota windows. `limitRecoveryCommand` waits for a usage-limit reset. `ProviderSwitchServiceV2.plan` and the context handoff can move a thread to another model or instance. No fallback chain exists in contracts or settings, and nothing caps threads per host.
- 검토한 주요 대안:
  - A second scorer for goals. Two scorers would disagree about the same machines.
  - Per-request fallback inside the provider layer, as LiteLLM and OpenRouter do. A GOAT turn carries tool and workspace state, so the switch must happen between turns through the existing switch and handoff.
  - Editing provider homes or OpenCodex routing to switch accounts. Out of bounds; chains only choose a `ModelSelection`.
  - Enable a default chain for every thread. Silent model changes on upgrade would surprise users.
- 선택한 방식: Optional `fleet` settings for global and per-host thread caps, goal defaults, thresholds and named fallback chains. `PlacementScheduler` filters candidates (ready, not cordoned, selector, instance, project, caps) and scores survivors with the existing `choosePlacement`, moved and re-exported. `Fallback.next` walks a chain with per-step cooldown and returns switch-in-thread, relaunch-from-branch, or exhausted. Each failed run has one owner: goal threads belong to the controller, and for ordinary threads the fallback is one more branch of the usage-limit recovery sweep, so two Scheduler sources never act on the same run. Ordinary threads change only when a chain opts in. Goal placements reserve capacity with their action claim; caps never refuse a person's own launch.
- 다른 대안 대신 이 방식을 선택한 이유: One scorer, one switch primitive, and between-turn fallback reuse the code that already moves a thread across models.
- 장점, 단점 및 영향: Everything is off by default. Token budgets count only where providers report usage. There is no preemption. A fallback hop is shown to the user as a notice on the thread.
