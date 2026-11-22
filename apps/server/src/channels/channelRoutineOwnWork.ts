import {
  ChannelTaskId,
  type BotId,
  type ChannelDispatchTarget,
  type ChannelTask,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type RepositoryIdentity,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  webhookExpressionResolver,
  type WebhookRequest,
} from "../scheduledTasks/webhookTemplate.ts";
import { CHANNEL_WORKER_BRANCH_PREFIX, remoteBranchFor, workerLaunchIdsFor } from "./channelIds.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";

const githubRepository = (value: unknown) =>
  typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value) ? value.toLowerCase() : undefined;

const githubRepositoryOf = (identity: RepositoryIdentity | null | undefined) => {
  if (identity == null) return undefined;
  const checkout = RepositoryIdentityResolver.ownRepositoryIdentity(identity) ?? identity;
  return (
    githubRepository(checkout.canonicalKey.match(/^github\.com\/(.+)$/i)?.[1]) ??
    (checkout.provider === "github" && checkout.owner !== undefined && checkout.name !== undefined
      ? githubRepository(checkout.owner + "/" + checkout.name)
      : undefined)
  );
};

export const recordChannelLaunchHead = Effect.fn("channel.recordLaunchHead")(function* (input: {
  readonly taskId: ChannelTaskId;
  readonly generation: number;
  readonly repository: string | undefined;
  readonly branch: string;
}) {
  const repository = githubRepository(input.repository);
  if (repository === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO channel_worker_launch_heads (task_id, generation, repository, branch)
    VALUES (${input.taskId}, ${input.generation}, ${repository}, ${input.branch})
    ON CONFLICT DO NOTHING`.pipe(
    Effect.mapError(
      (cause) =>
        new ChannelLedgerError({
          reason: "persistence",
          detail: "record worker head before launch",
          cause,
        }),
    ),
  );
});

const backfillChannelWorkerHeads = Effect.fn("channel.backfillWorkerHeads")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      readonly task_id: string;
      readonly generation: number;
      readonly worker_thread_id: string | null;
    }>`
      SELECT t.task_id, t.generation, t.worker_thread_id FROM channel_tasks t
      WHERE t.task_id > ${after} AND t.status NOT IN ('completed', 'failed', 'cancelled')
        AND (t.worker_thread_id IS NOT NULL OR t.status = 'dispatching')
        AND NOT EXISTS (
          SELECT 1 FROM channel_worker_launch_heads h WHERE h.task_id = t.task_id AND h.generation = t.generation
        )
      ORDER BY t.task_id LIMIT 64`;
    if (rows.length === 0) return;
    const workers = rows.map((row) => {
      const taskId = ChannelTaskId.make(row.task_id);
      return {
        threadId: row.worker_thread_id ?? workerLaunchIdsFor(taskId, row.generation).threadId,
        taskId,
        generation: row.generation,
      };
    });
    const projections = yield* sql<{
      readonly thread_id: string;
      readonly branch: string | null;
      readonly workspace: string | null;
    }>`SELECT s.thread_id, json_extract(s.payload_json, '$.branch') AS branch,
        COALESCE(json_extract(s.payload_json, '$.worktreePath'), p.workspace_root) AS workspace
      FROM orchestration_v2_projection_threads s
      LEFT JOIN projection_projects p ON p.project_id = s.project_id
      WHERE s.thread_id IN ${sql.in(workers.map(({ threadId }) => threadId))} AND s.deleted_at IS NULL`;
    const byId = new Map(projections.map((row) => [row.thread_id, row]));
    for (const { threadId, taskId, generation } of workers) {
      after = taskId;
      const projection = byId.get(threadId);
      if (!projection?.branch || !projection.workspace) continue;
      const { branch, workspace } = projection;
      const identity = yield* identities.resolve(workspace);
      yield* recordChannelLaunchHead({
        taskId,
        generation,
        branch,
        repository: githubRepositoryOf(identity),
      });
    }
  }
});

export const layerBackfillChannelWorkerHeads = Layer.effectDiscard(backfillChannelWorkerHeads());

const PullRequestIdentity = Schema.Struct({ repository: Schema.String, number: Schema.Int });
type PullRequestIdentity = typeof PullRequestIdentity.Type;
const HeadIdentity = Schema.Struct({
  repository: Schema.optional(Schema.String),
  branch: Schema.String,
});
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(HeadIdentity)));
const encodePullRequests = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(PullRequestIdentity)),
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pullRequestOf = (
  value: unknown,
  defaultRepo: string | undefined,
): PullRequestIdentity | undefined => {
  if (
    !isRecord(value) ||
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0
  )
    return undefined;
  const baseRepo = isRecord(value.base) && isRecord(value.base.repo) ? value.base.repo : undefined;
  const repository = githubRepository(baseRepo?.full_name) ?? defaultRepo;
  return repository === undefined ? undefined : { repository, number: value.number };
};

export const filterRoutineOwnWork = Effect.fn("channel.filterRoutineOwnWork")(function* (input: {
  readonly request: WebhookRequest;
  readonly ownerId: string;
  readonly botId: BotId;
  readonly allowChecksWithoutPullRequest: boolean;
}) {
  const read = webhookExpressionResolver(input.request);
  const event = input.request.headers["x-github-event"];
  const pr = read("body.pull_request");
  const suite = read("body.check_suite");
  const run = read("body.check_run");
  const isCheck =
    event === "check_run" || event === "check_suite" || isRecord(suite) || isRecord(run);
  if (!isCheck && event !== "pull_request" && !isRecord(pr)) return undefined;

  const repository = githubRepository(read("body.repository.full_name"));
  const heads: Array<{ readonly repository?: string | undefined; readonly branch: string }> = [];
  const addHead = (repository: unknown, branch: unknown) => {
    if (typeof branch === "string" && branch !== "")
      heads.push({ repository: githubRepository(repository), branch });
  };
  addHead(read("body.pull_request.head.repo.full_name"), read("body.pull_request.head.ref"));
  addHead(
    read("body.check_run.check_suite.head_repository.full_name") ??
      read("body.check_run.head_repository.full_name") ??
      repository,
    read("body.check_run.check_suite.head_branch") ?? read("body.check_run.head_branch"),
  );
  addHead(
    read("body.check_suite.head_repository.full_name") ?? repository,
    read("body.check_suite.head_branch"),
  );

  const prs: PullRequestIdentity[] = [];
  const addPullRequest = (value: unknown) => {
    const identity = pullRequestOf(value, repository);
    if (identity !== undefined) prs.push(identity);
    if (isRecord(value) && isRecord(value.head))
      addHead(isRecord(value.head.repo) ? value.head.repo.full_name : undefined, value.head.ref);
  };
  addPullRequest(pr);
  for (const source of [suite, run]) {
    if (isRecord(source) && Array.isArray(source.pull_requests))
      for (const item of source.pull_requests) addPullRequest(item);
  }
  if (isCheck && prs.length === 0 && !input.allowChecksWithoutPullRequest)
    return "Filtered: no pull request.";
  if (heads.length === 0 && prs.length === 0) return undefined;

  const sql = yield* SqlClient.SqlClient;
  const [matches] = yield* sql<{ readonly own: number; readonly unknown: number }>`
    WITH heads AS (
      SELECT json_extract(value,'$.repository') AS repository, json_extract(value,'$.branch') AS branch
      FROM json_each(${encodeHeads(heads)})
    ), prs AS (
      SELECT json_extract(value,'$.repository') AS repository, json_extract(value,'$.number') AS number
      FROM json_each(${encodePullRequests(prs)})
    )
    SELECT (
      EXISTS (
        SELECT 1 FROM heads h JOIN channel_worker_launch_heads w USING (repository, branch)
        JOIN channel_tasks t ON t.task_id=w.task_id
        WHERE t.owner_id=${input.ownerId} AND t.bot_id=${input.botId}
      ) OR EXISTS (
        SELECT 1 FROM channel_tasks t
        LEFT JOIN orchestration_v2_projection_threads p ON p.thread_id=t.worker_thread_id
        JOIN json_each(
          CASE WHEN json_valid(p.payload_json) THEN json_extract(p.payload_json,'$.pullRequests') END
        ) l
        JOIN prs ON prs.repository=lower(json_extract(l.value,'$.repository'))
          AND prs.number=json_extract(l.value,'$.number')
        WHERE t.owner_id=${input.ownerId} AND t.bot_id=${input.botId}
      ) OR EXISTS (
        SELECT 1 FROM channel_tasks t JOIN json_each(json_extract(t.task_json,'$.observed.pullRequests')) l
        JOIN prs ON prs.repository=lower(json_extract(l.value,'$.repository'))
          AND prs.number=json_extract(l.value,'$.number')
        WHERE t.owner_id=${input.ownerId} AND t.bot_id=${input.botId}
      )
    ) AS own, EXISTS (
      SELECT 1 FROM heads h
      WHERE substr(h.branch, 1, ${CHANNEL_WORKER_BRANCH_PREFIX.length}) = ${CHANNEL_WORKER_BRANCH_PREFIX}
        AND NOT EXISTS (
          SELECT 1 FROM channel_worker_launch_heads w WHERE w.repository=h.repository AND w.branch=h.branch
        )
    ) AS unknown
  `;
  if (matches?.own === 1) return "Filtered: this GOAT Bot's own work.";
  if (matches?.unknown === 1) return "Filtered: possibly this GOAT Bot's own work.";
  return undefined;
});

export const prepareChannelWorkerWorkspace = Effect.fn("channel.prepareWorkerWorkspace")(function* (
  task: ChannelTask,
  target: ChannelDispatchTarget,
  recordHead: (
    input: Parameters<typeof recordChannelLaunchHead>[0],
  ) => Effect.Effect<void, ChannelLedgerError>,
): Effect.fn.Return<
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ChannelLedgerError,
  ProjectStore.ProjectStoreV2
> {
  if (target.workspaceStrategy.type === "root") return { type: "root" };
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = (yield* projects
    .listShells({ projectIds: [target.projectId] })
    .pipe(Effect.orElseSucceed(() => []))).find((shell) => shell.id === target.projectId);
  const identities = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );
  const identity =
    project === undefined || Option.isNone(identities)
      ? null
      : yield* identities.value.resolve(project.workspaceRoot);
  const workspace = {
    type: "worktree" as const,
    baseRef: target.workspaceStrategy.baseRef ?? "HEAD",
  };
  const repository = githubRepositoryOf(identity);
  if (repository === undefined && task.routineWork !== true) return workspace;
  const branch = remoteBranchFor(task.taskId, task.generation);
  yield* recordHead({ taskId: task.taskId, generation: task.generation, branch, repository });
  return { ...workspace, branch };
});
