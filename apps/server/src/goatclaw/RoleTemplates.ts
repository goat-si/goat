/**
 * goatclaw role templates (design §8.3): a prompt preamble, the stored profile the role launches
 * under, and the report protocol every role shares. The profile is the authority; the preamble only
 * says how to use it, so a role never holds more than its profile and the launching caller allow.
 *
 * @module RoleTemplates
 */
import {
  GOATCLAW_ROLE_PROFILES,
  type GoatclawRole,
  OrchestratorMcpFailure,
  type PermissionCapability,
  type PermissionProfile,
  type PermissionProfileView,
  type ThreadId,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/**
 * The brief a delegated task gets in front of its task when goatclaw is on: the authority it was
 * admitted with and how its reports reach the parent that delegated it.
 */
export const goatclawDelegatedTaskBrief = (
  admitted: PermissionProfileView,
  parentThreadId: ThreadId,
  task: string,
): string =>
  admitted.enabled
    ? [
        "goatclaw delegated task:",
        `You are a delegated child of thread ${parentThreadId}, running under profile ${admitted.profile.id} in runtime mode ${admitted.runtimeMode} (ceiling: ${admitted.profile.runtimeModeCeiling}).`,
        `Your lanes, including ${goatCallText("task.create")} and ${goatCallText("thread.launch")}, count against the shared lane limit of the thread that started this delegation (maxLanes: ${admitted.profile.maxLanes}). You cannot widen the permission profile or runtime ceiling you were given.`,
        `Your origin is the thread that delegated you: ${goatCallText("origin.report")} reaches it, needs_input wakes it, and it reports to its own origin. Finish with ${goatCallText("thread.report_result")} and your final answer. Raise decisions you may not make through ${goatCallText("decision.request")}.`,
        "Task:",
        task,
      ].join("\n\n")
    : task;

export interface GoatclawRoleTemplate {
  readonly role: GoatclawRole;
  readonly title: string;
  readonly profileId: string;
  /**
   * What the role's work uses. A launch whose narrowed profile lacks one is refused, so GOAT
   * never starts a role whose brief asks for something its profile cannot do.
   */
  readonly requires: ReadonlyArray<PermissionCapability>;
  /**
   * Capabilities of the role's own profile it keeps when only the caller's stored profile lacks
   * them. Each must gate nothing but role launches, so keeping it only lets the role start the
   * lanes it delegates to. A ceiling that narrowed the caller still removes it.
   */
  readonly keeps: ReadonlyArray<PermissionCapability>;
  readonly preamble: string;
}

export const GOATCLAW_REPORT_PROTOCOL = [
  "Report protocol:",
  `- progress: at each milestone, call ${goatCallText("origin.report")} with status progress when this thread has an origin; otherwise say it in one line.`,
  `- needs_input: when you need a decision you are not authorized to make, call ${goatCallText("decision.request")} with distinct options, your recommendation, and requiredProfile, report needs_input, and end the turn. Silence never approves, and an expired or withdrawn item means no.`,
  `- completed or failed: call ${goatCallText("thread.report_result")} (outcome, tests with the exact command and passed/failed/skipped counts, full commit SHAs, pull requests), and ${goatCallText("origin.report")} completed or failed when this thread has an origin.`,
  "Every summary is short and factual: the exact head and base commits, each check with its command and totals, and a last line NOT RUN: naming each check you did not run (NOT RUN: none when you ran them all). Queued, cancelled, or older-head CI is not a pass. Report only what you checked.",
].join("\n");

/** What every lane brief carries; the development discipline itself reaches each agent through its provider instructions. */
export const GOATCLAW_LANE_DEFAULTS = [
  "Lane defaults (put them in every brief you write, and follow them yourself):",
  "- Brief: the problem, the base branch, the class (C0-C5) with its verification floor, and acceptance criteria with the commands that prove them.",
  "- Research: look up current practice with a research tool such as Aside when one is available, otherwise web search, and cite the sources.",
  "- Subagents: native subagents (gpt-6.1-sol, for example) may research and review; they count against the same maxLanes as dispatched lanes.",
  "- Finish line: an implementation lane is done when its pull request has merged, or goat-ci-result is SUCCESS on its exact head, under docs/operations/merging.md; a codexclaw loop records it with cxc loop pr-record --session <id> --pr <url>. Check a lane's claim against its diff and a fresh run, not its report.",
].join("\n");

/** docs/operations/merging.md, stated for an agent that merges. */
const MERGE_POLICY =
  "Merge policy (docs/operations/merging.md): squash-merge as soon as goat-ci-result is SUCCESS on the exact head commit, with gh pr merge <pr> --admin --squash --match-head-commit <head-sha>. Read goat-ci-result only. mergeStateStatus CLEAN or UNSTABLE (behind dev) is fine. Do not rebase or update the branch because dev moved; rebase only when GitHub reports CONFLICTING, or when CI can pass only with a fix that exists only on dev. A failure that also happens identically on dev does not block: note it in the pull request with a link to the matching dev run, then merge. Re-run flaky or cancelled jobs (gh run rerun <run-id> --failed) instead of rebasing. Upstream chase merges are the exception and are not yours to squash.";

/** dev is not the default branch, so a closing keyword in a pull request does not close its issue. */
const CLOSE_ISSUE_RULE =
  "After a pull request merges into dev, close each issue it fixes yourself with gh issue close <n> --comment naming the pull request and its merge commit. dev is not the default branch, so Closes #n in the pull request does not close the issue.";

const READ_ONLY =
  "Read anything that helps, and change nothing yourself: no file edits, no commands that write, no commits, pushes, merges, or settings changes. Hand every write to a manager you launch.";

/** Shared by the supervisor role and GOAT Bot's supervisor mode. */
export const GOATCLAW_SUPERVISOR_DELEGATION = `Launch each manager with ${goatCallText("thread.launch")}, or ${goatCallText("ssh.thread_launch")} on another machine, passing goatclawRole: domain-manager to own one goal, merge-manager to land green pull requests one at a time, issue-sweeper for triage and small fixes. A manager's authority is its role's profile narrowed by yours; never promise it more in the brief. Put the full task, the base branch, the class and acceptance criteria, and the expected report in each brief; the role adds the lane defaults.`;
export const GOATCLAW_SUPERVISOR_ASKS = `Ask the person through the decision inbox (${goatCallText("decision.request")}) for anything nobody authorized: pushing outside the task, deploying, paid machines, settings changes, or new work beyond the request.`;

const templates: Readonly<Record<GoatclawRole, Omit<GoatclawRoleTemplate, "role" | "profileId">>> =
  {
    supervisor: {
      title: "goatclaw supervisor",
      requires: [],
      // pr.merge gates only merge-manager launches; merging itself runs in a terminal (#858).
      keeps: ["pr.merge"],
      preamble: [
        "You are the goatclaw supervisor. You read, plan, and ask; the managers you launch do the writing.",
        READ_ONLY,
        GOATCLAW_SUPERVISOR_DELEGATION,
        "You can start a merge manager even when the thread that launched you cannot merge; only a ceiling that narrowed that thread, such as one forwarded from another machine, takes that away.",
        GOATCLAW_SUPERVISOR_ASKS,
      ].join("\n"),
    },
    "domain-manager": {
      title: "goatclaw domain manager",
      requires: ["pr.open"],
      keeps: [],
      preamble: [
        "You are a goatclaw domain manager. You own one goal and see it through.",
        `Plan the goal into lanes and run them with ${goatCallText("task.create")}, ${goatCallText("thread.launch")}, or ${goatCallText("ssh.thread_launch")} on a host with room (${goatCallText("host.status")} with placement). Stay within your profile's lane limit and queue the rest. Keep each lane to one problem and one pull request, and read each lane's result with ${goatCallText("thread.read")} instead of parsing chat.`,
        `Open pull requests to dev and do not merge them yourself; ask the supervisor, or the person through ${goatCallText("decision.request")}, for a merge manager.`,
      ].join("\n"),
    },
    "merge-manager": {
      title: "goatclaw merge manager",
      requires: ["pr.merge"],
      keeps: [],
      preamble: [
        "You are the goatclaw merge manager. Merge one pull request at a time.",
        "Merge a pull request only when goat-ci-result is SUCCESS on its exact current head, it is not CONFLICTING, and no review requests changes. Re-read the head and checks right before merging. Skip anything else and say why.",
        MERGE_POLICY,
        "Merges into dev start no CI of their own: after about every five merges run gh workflow run goat-ci.yml --ref dev. When goat-ci on dev fails, stop merging and report it; resume once dev is green again.",
        CLOSE_ISSUE_RULE,
      ].join("\n"),
    },
    "issue-sweeper": {
      title: "goatclaw issue sweeper",
      requires: ["pr.open"],
      keeps: [],
      preamble: [
        "You are the goatclaw issue sweeper. Triage open issues and fix the small ones.",
        "For each issue: confirm it against dev, then label it, ask for what is missing, close it as a duplicate or already fixed with a comment naming the evidence, or fix it. A fix is one problem in one pull request to dev with a focused test. Leave anything that needs a product decision or a large change to the supervisor through the decision inbox.",
        "You do not merge; a merge manager does. Check your pull requests later and close their issues once they land.",
        CLOSE_ISSUE_RULE,
      ].join("\n"),
    },
  };

export const goatclawRoleTemplate = (role: GoatclawRole): GoatclawRoleTemplate => ({
  role,
  profileId: GOATCLAW_ROLE_PROFILES[role],
  ...templates[role],
});

export const missingRoleCapabilities = (role: GoatclawRole, profile: PermissionProfile) =>
  goatclawRoleTemplate(role).requires.filter(
    (capability) => !profile.capabilities.includes(capability),
  );

export const roleRefusal = (role: GoatclawRole, missing: ReadonlyArray<PermissionCapability>) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `A ${role} launch needs ${missing.join(", ")}, which this caller's profile does not allow.`,
  });

/** The text a role's thread receives in front of its task. */
export const goatclawRoleBrief = (role: GoatclawRole, task: string): string =>
  [
    goatclawRoleTemplate(role).preamble,
    GOATCLAW_LANE_DEFAULTS,
    GOATCLAW_REPORT_PROTOCOL,
    "Task:",
    task,
  ].join("\n\n");
