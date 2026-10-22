import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { isElectron } from "../../env";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DecisionUserInputForm } from "./DecisionUserInputForm";
import { useDecisionInbox } from "./useDecisionInbox";

export function DecisionInbox() {
  const { snapshot, ordered, current, drafts, submissions, skip, setAnswers, submit } =
    useDecisionInbox();
  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron}>
          <h1>Decisions</h1>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Pending questions and approvals from threads.
              </p>
              <Button size="sm" variant="outline" render={<Link to="/settings/decision-inbox" />}>
                Decision inbox and history
              </Button>
            </div>
            {snapshot.isLoading ? <p role="status">Loading decisions…</p> : null}
            {snapshot.errors.length > 0 ? (
              <div role="alert">
                <p>Some decisions could not be loaded.</p>
                {snapshot.errors.map(({ ref }) => (
                  <div key={JSON.stringify([ref.environmentId, ref.threadId])}>
                    <Link to="/$environmentId/$threadId" params={buildThreadRouteParams(ref)}>
                      Open affected thread
                    </Link>
                  </div>
                ))}
              </div>
            ) : null}
            {current ? (
              <DecisionCard
                key={current.id}
                item={current}
                drafts={drafts[current.id] ?? {}}
                submission={submissions[current.id]}
                total={ordered.length}
                onChange={(next) => setAnswers(current.id, next)}
                onSubmit={(response) => submit(current.id, response)}
                onSkip={skip}
                partial={snapshot.isLoading || snapshot.errors.length > 0}
                blockedBySync={
                  snapshot.loadingRefs.some(
                    (ref) =>
                      ref.environmentId === current.ref.environmentId &&
                      ref.threadId === current.ref.threadId,
                  ) ||
                  snapshot.errors.some(
                    ({ ref }) =>
                      ref.environmentId === current.ref.environmentId &&
                      ref.threadId === current.ref.threadId,
                  )
                }
              />
            ) : !snapshot.isLoading && snapshot.errors.length === 0 ? (
              <p role="status">
                All caught up. No pending thread requests on connected environments.
              </p>
            ) : null}
          </WorkspacePageContainer>
        </main>
      </div>
    </SidebarInset>
  );
}

function decisionAge(createdAt: string) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return "Unknown age";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}

type Inbox = ReturnType<typeof useDecisionInbox>;

function DecisionCard({
  item,
  drafts,
  submission,
  onChange,
  onSubmit,
  onSkip,
  total,
  partial,
  blockedBySync,
}: {
  item: DecisionItem;
  drafts: Inbox["drafts"][string];
  submission: Inbox["submissions"][string] | undefined;
  onChange: (drafts: Inbox["drafts"][string]) => void;
  onSubmit: (response: Parameters<Inbox["submit"]>[1]) => Promise<unknown>;
  onSkip: Inbox["skip"];
  total: number;
  partial: boolean;
  blockedBySync: boolean;
}) {
  const titleId = useId();
  const shell = useThreadShell(item.ref);
  const environment = useEnvironment(item.ref.environmentId);
  const canOperate = useEnvironmentScope(item.ref.environmentId, AuthOrchestrationOperateScope);
  const busy = submission?.phase === "submitting" || submission?.phase === "awaitingProjection";
  const canRespond =
    canOperate && !blockedBySync && item.request.responseCapability !== "not_resumable";
  const disabled = busy || !canRespond;
  return (
    <article aria-labelledby={titleId} className="flex min-w-0 flex-col gap-6 wrap-anywhere">
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-lg font-medium">
          {shell?.title || "Untitled thread"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {environment?.label || item.ref.environmentId}
        </p>
        <Tooltip>
          <TooltipTrigger
            render={<time dateTime={item.createdAt} className="text-xs text-muted-foreground" />}
          >
            {decisionAge(item.createdAt)}
          </TooltipTrigger>
          <TooltipPopup>{item.createdAt}</TooltipPopup>
        </Tooltip>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {/* Skipped requests move to the end, so the current card is nearly always
              first; the remaining count is the useful number. */}
          {partial
            ? `${total} loaded so far`
            : `${total} ${total === 1 ? "decision" : "decisions"} waiting`}
        </p>
      </div>
      {!canOperate ? <p role="status">This connection cannot answer decisions.</p> : null}
      {blockedBySync ? (
        <p role="status">Wait for this thread to reconnect before answering.</p>
      ) : null}
      {item.kind === "user_input" && item.request.responseCapability === "not_resumable" ? (
        <p role="status">
          Provider process is gone. Open the thread to interrupt or restart the run.
        </p>
      ) : null}
      {item.kind === "approval" ? (
        <>
          <ComposerPendingApprovalPanel approval={item.request} pendingCount={1} />
          <div className="flex flex-wrap items-center gap-2">
            <ComposerPendingApprovalActions
              requestId={item.request.requestId}
              options={item.request.options}
              isResponding={busy}
              canRespond={canRespond}
              disabled={disabled}
              onRespondToApproval={(_, decision) => onSubmit(decision)}
            />
          </div>
        </>
      ) : (
        <DecisionUserInputForm
          item={item}
          drafts={drafts}
          disabled={disabled}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      )}
      {submission?.phase === "submitting" ? <p role="status">Sending answer…</p> : null}
      {submission?.phase === "awaitingProjection" ? (
        <p role="status">Answer sent. Waiting for the thread to update…</p>
      ) : null}
      {submission?.phase === "failed" ? <p role="alert">{submission.message}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy || total < 2} onClick={onSkip}>
          Skip
        </Button>
        <Button
          variant="ghost"
          render={<Link to="/$environmentId/$threadId" params={buildThreadRouteParams(item.ref)} />}
        >
          Go to thread
        </Button>
      </div>
    </article>
  );
}
