import type {
  OrchestrationV2CloudTask,
  OrchestrationV2CloudSourceRestriction,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitVcs from "../vcs/GitVcsDriver.ts";

export class CloudTaskSourceError extends Schema.TaggedError<CloudTaskSourceError>()(
  "CloudTaskSourceError",
  {
    reason: Schema.Literals([
      "repository",
      "branch",
      "remote",
      "unpublished",
      "source_restriction",
      "checkout_mismatch",
      "read",
    ]),
    /** The branch the caller asked for, when it is the subject of the refusal. */
    branch: Schema.optional(Schema.String),
    /** The branch checked out in the project folder. */
    checkedOut: Schema.optional(Schema.String),
    /** The push remote that was asked about the branch. */
    remote: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "repository":
        return "Cloud tasks require a Git repository.";
      case "branch":
        return "Choose a published branch before starting a cloud task.";
      case "remote":
        return "Configure a repository push remote before starting a cloud task.";
      case "unpublished":
        return this.branch === undefined
          ? "Push this branch before starting a cloud task."
          : `Branch ${this.branch} is not on ${this.remote ?? "its push remote"}. Push it, or pass a branch that exists there.`;
      case "source_restriction":
        return "This provider requires an existing clean checkout on the selected published branch at its pushed SHA. Local edits, untracked files and unpushed commits cannot be included.";
      case "checkout_mismatch":
        return `This provider starts from the project folder, which has ${this.checkedOut} checked out, not ${this.branch}. Check out ${this.branch} there, or omit the branch to start from ${this.checkedOut}.`;
      case "read":
        return "Could not verify the published cloud task source.";
    }
  }
}

export class CloudTaskSourceService extends Context.Service<
  CloudTaskSourceService,
  {
    readonly resolve: (input: {
      readonly cwd: string;
      readonly branch?: string;
      readonly restriction?: OrchestrationV2CloudSourceRestriction;
    }) => Effect.Effect<
      {
        readonly source: OrchestrationV2CloudTask["source"];
        readonly localChangesExcluded: boolean;
        readonly localChangesIncluded?: boolean;
        readonly launchSource: {
          readonly cwd: string;
          readonly restriction: OrchestrationV2CloudSourceRestriction;
        };
      },
      CloudTaskSourceError
    >;
  }
>()("goat/orchestration-v2/CloudTaskSourceService") {}

function repositoryUrl(raw: string) {
  const scp = /^[^@/]+@([^:]+):(.+)$/.exec(raw);
  const candidate = scp ? `https://${scp[1]}/${scp[2]}` : raw;
  try {
    const url = new URL(candidate);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname) return null;
    const path = url.pathname.replace(/\.git$/, "").replace(/\/$/, "");
    if (!path || path === "/") return null;
    return `https://${url.host}${path}`;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const git = yield* GitVcs.GitVcsDriver;
  const read = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "CloudTaskSourceService.read",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
      })
      .pipe(Effect.mapError((cause) => new CloudTaskSourceError({ reason: "read", cause })));
  const config = Effect.fnUntraced(function* (cwd: string, key: string) {
    const result = yield* read(cwd, ["config", "--get", key]);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0 || result.stdoutTruncated) {
      return yield* new CloudTaskSourceError({ reason: "read" });
    }
    return result.stdout.trim() || null;
  });
  const resolve: CloudTaskSourceService["Service"]["resolve"] = Effect.fn(
    "CloudTaskSourceService.resolve",
  )(function* ({ cwd, branch: requestedBranch, restriction = "published-ref" }) {
    const local = yield* git
      .statusDetailsLocal(cwd, { includeDivergence: false })
      .pipe(Effect.mapError((cause) => new CloudTaskSourceError({ reason: "read", cause })));
    if (!local.isRepo) return yield* new CloudTaskSourceError({ reason: "repository" });
    const rawBranch =
      restriction === "project-folder" ? local.branch : (requestedBranch ?? local.branch);
    if (!rawBranch || /^[0-9a-f]{40,64}$/i.test(rawBranch))
      return yield* new CloudTaskSourceError({ reason: "branch" });
    const requested = requestedBranch?.replace(/^refs\/heads\//, "");
    // The project folder is the source, so another branch would silently start from the checkout.
    if (restriction === "project-folder" && requested !== undefined && requested !== rawBranch)
      return yield* new CloudTaskSourceError({
        reason: "checkout_mismatch",
        branch: requested,
        checkedOut: rawBranch,
      });
    const remotesResult = yield* read(cwd, ["remote"]);
    if (remotesResult.exitCode !== 0 || remotesResult.stdoutTruncated)
      return yield* new CloudTaskSourceError({ reason: "read" });
    const remotes = remotesResult.stdout.trim().split("\n").filter(Boolean);
    const explicitRemote =
      restriction === "project-folder"
        ? undefined
        : remotes.find(
            (name) =>
              rawBranch.startsWith(`${name}/`) || rawBranch.startsWith(`refs/remotes/${name}/`),
          );
    if (rawBranch.startsWith("refs/remotes/") && explicitRemote === undefined)
      return yield* new CloudTaskSourceError({ reason: "branch" });
    const branch = rawBranch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
    const publishedBranch =
      explicitRemote === undefined ? branch : branch.slice(explicitRemote.length + 1);
    if (
      rawBranch.startsWith("refs/") &&
      !rawBranch.startsWith("refs/heads/") &&
      !rawBranch.startsWith("refs/remotes/")
    )
      return yield* new CloudTaskSourceError({ reason: "branch" });
    const trackingRemote = yield* config(cwd, `branch.${publishedBranch}.remote`);
    const remote =
      explicitRemote ??
      (yield* config(cwd, `branch.${publishedBranch}.pushRemote`)) ??
      (yield* config(cwd, "remote.pushDefault")) ??
      (trackingRemote === "." ? null : trackingRemote) ??
      (yield* git
        .resolvePrimaryRemoteName(cwd)
        .pipe(Effect.mapError((cause) => new CloudTaskSourceError({ reason: "remote", cause }))));
    if (!remote || remote === "." || remote.startsWith("-")) {
      return yield* new CloudTaskSourceError({ reason: "remote" });
    }

    const ref = `refs/heads/${publishedBranch}`;
    const valid = yield* read(cwd, ["check-ref-format", ref]);
    if (valid.exitCode !== 0) return yield* new CloudTaskSourceError({ reason: "branch" });
    const remoteResult = yield* read(cwd, ["remote", "get-url", "--push", remote]);
    const repository = repositoryUrl(remoteResult.stdout.trim());
    if (remoteResult.exitCode !== 0 || remoteResult.stdoutTruncated || !repository) {
      return yield* new CloudTaskSourceError({ reason: "remote" });
    }
    if (restriction === "project-folder") {
      const head = yield* read(cwd, ["rev-parse", "--verify", "HEAD"]);
      if (head.stdoutTruncated || (head.exitCode !== 0 && head.exitCode !== 128)) {
        return yield* new CloudTaskSourceError({ reason: "read" });
      }
      const sha = head.exitCode === 0 ? head.stdout.trim() : undefined;
      if (sha !== undefined && !/^[0-9a-f]{40,64}$/.test(sha)) {
        return yield* new CloudTaskSourceError({ reason: "read" });
      }
      // Use local tracking metadata; unpublished branches need no network preflight.
      const upstream = yield* read(cwd, ["rev-parse", "--verify", "@{upstream}"]);
      if (upstream.stdoutTruncated || (upstream.exitCode !== 0 && upstream.exitCode !== 128)) {
        return yield* new CloudTaskSourceError({ reason: "read" });
      }
      const ancestry =
        sha !== undefined &&
        trackingRemote !== null &&
        trackingRemote !== "." &&
        upstream.exitCode === 0
          ? yield* read(cwd, ["merge-base", "--is-ancestor", "HEAD", "@{upstream}"])
          : null;
      if (ancestry !== null && ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
        return yield* new CloudTaskSourceError({ reason: "read" });
      }
      return {
        source: { repository, branch: publishedBranch, ...(sha === undefined ? {} : { sha }) },
        launchSource: { cwd, restriction },
        localChangesExcluded: false,
        localChangesIncluded: local.hasWorkingTreeChanges || ancestry?.exitCode !== 0,
      };
    }
    // Query the selected push URL, which can differ from its fetch URL.
    const published = yield* read(cwd, [
      "ls-remote",
      "--exit-code",
      "--heads",
      remoteResult.stdout.trim(),
      ref,
    ]);
    if (published.exitCode === 2)
      return yield* new CloudTaskSourceError({
        reason: "unpublished",
        branch: publishedBranch,
        remote: `${remote} (${repository})`,
      });
    if (published.exitCode !== 0 || published.stdoutTruncated) {
      return yield* new CloudTaskSourceError({ reason: "read" });
    }
    const row = published.stdout
      .trim()
      .split("\n")
      .find((line) => line.split(/\s+/)[1] === ref);
    const sha = row?.split(/\s+/)[0];
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) {
      return yield* new CloudTaskSourceError({
        reason: "unpublished",
        branch: publishedBranch,
        remote: `${remote} (${repository})`,
      });
    }
    const head = yield* read(cwd, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || head.stdoutTruncated)
      return yield* new CloudTaskSourceError({ reason: "read" });
    if (
      restriction === "clean-pushed-sha" &&
      (local.branch !== publishedBranch ||
        local.hasWorkingTreeChanges ||
        head.stdout.trim() !== sha)
    ) {
      return yield* new CloudTaskSourceError({ reason: "source_restriction" });
    }
    // No fetch: absent remote objects conservatively exclude local commits.
    const ancestry =
      head.stdout.trim() === sha
        ? null
        : yield* read(cwd, ["merge-base", "--is-ancestor", "HEAD", sha]);
    return {
      source: { repository, branch: publishedBranch, sha },
      launchSource: { cwd, restriction },
      localChangesExcluded:
        local.hasWorkingTreeChanges || (head.stdout.trim() !== sha && ancestry?.exitCode !== 0),
    };
  });
  return CloudTaskSourceService.of({ resolve });
});
export const layer = Layer.effect(CloudTaskSourceService, make);
