import {
  CHATGPT_USAGE_URL,
  collectExternalUsageLinks,
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
  type LimitPoolWindow,
  type LimitPresentations,
  remainingPercent,
} from "@goat/shared/usageLimits";
import {
  limitBoard,
  type LimitBoardGroup,
  type LimitBoardRow,
  type LimitBoardSection,
} from "@goat/shared/usageLimitsBoard";
import { TriangleAlertIcon as AlertTriangleIcon, ExternalLinkIcon } from "~/components/solar";
import { Fragment, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PaceIcon, ResetCredits, barColor } from "./UsageLimits";

const ORIGIN_BADGE = {
  pool: { label: "Shared pool", variant: "info" },
  login: { label: "Direct login", variant: "secondary" },
  proxy: { label: "Proxy", variant: "outline" },
} as const;

const STATUS_BADGE = {
  ready: { label: "Ready", variant: "success" },
  blocked: { label: "Blocked", variant: "error" },
  unknown: { label: "No reading", variant: "outline" },
  paused: { label: "Paused", variant: "secondary" },
  reauth: { label: "Sign in again", variant: "warning" },
} as const;

const VERDICT_BADGE = { ready: "success", blocked: "error", unknown: "outline" } as const;

const driverLabel = (driver: LimitBoardSection["driver"]) =>
  providerClients.get(driver)?.label ?? String(driver);

function WindowCell({
  window,
  color,
  now,
}: {
  readonly window: NonNullable<LimitPoolWindow["columns"][number]["window"]>;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const resetLabel = resetsIn?.replace("resets in ", "↻ ") ?? "";
  return (
    <div className="flex min-w-24 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="font-medium text-foreground">{remaining}% left</span>
        {window.resetsAt ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-muted-foreground" />}>
              {resetLabel}
            </TooltipTrigger>
            <TooltipPopup>
              Resets {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function AccountCell({ row }: { readonly row: LimitBoardRow }) {
  const details = [
    row.plan && !row.name?.toLowerCase().includes(row.plan.toLowerCase()) ? row.plan : null,
    row.note ?? null,
    row.alsoVia.length > 0 ? `Also via ${row.alsoVia.join(", ")}` : null,
  ].filter((detail) => detail !== null);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-medium text-foreground">
        {row.name ??
          (row.email ? (
            <RedactedSensitiveText
              value={row.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
            />
          ) : (
            driverLabel(row.driver)
          ))}
      </span>
      {row.name && row.email ? (
        <RedactedSensitiveText
          value={row.email}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
          className="w-fit text-muted-foreground"
        />
      ) : null}
      {details.length > 0 ? (
        <span className="truncate text-muted-foreground">{details.join(" · ")}</span>
      ) : null}
    </div>
  );
}

function StatusCell({ row, now }: { readonly row: LimitBoardRow; readonly now: number }) {
  const badge = STATUS_BADGE[row.status];
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant={badge.variant}>{badge.label}</Badge>
      {row.status === "blocked" ? (
        <span className="text-muted-foreground tabular-nums">
          {row.releaseAt === null
            ? "Release time unknown"
            : `Frees in ${formatDuration(row.releaseAt - now)}`}
        </span>
      ) : null}
    </div>
  );
}

function GroupTable({
  group,
  color,
  now,
}: {
  readonly group: LimitBoardGroup;
  readonly color: string;
  readonly now: number;
}) {
  const hasCredits = group.rows.some(
    (row) => row.account?.redeem && (row.account.limits.resetCredits?.availableCount ?? 0) > 0,
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="w-[34%] px-4 py-2 font-normal">
              Account
            </th>
            <th scope="col" className="w-32 px-2 py-2 font-normal">
              Status
            </th>
            {group.windows.map((window) => {
              const cursor = cursorUsageWindowDetails(window.id);
              return (
                <th
                  key={`${window.kind}:${window.id}`}
                  scope="col"
                  className="px-2 py-2 font-normal"
                >
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    {cursor?.description ? (
                      <Tooltip>
                        <TooltipTrigger render={<span />}>{cursor.label}</TooltipTrigger>
                        <TooltipPopup>{cursor.description}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      window.label
                    )}
                    <span className="font-medium text-foreground tabular-nums">
                      {window.remainingPercent}% left
                    </span>
                    {window.pace ? <PaceIcon pace={window.pace} /> : null}
                  </span>
                </th>
              );
            })}
            {hasCredits ? (
              <th scope="col" className="px-4 py-2 font-normal">
                <span className="sr-only">Reset credits</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.key} className="border-t border-border/60 align-top">
              <td className="max-w-0 px-4 py-2.5">
                <AccountCell row={row} />
              </td>
              <td className="px-2 py-2.5">
                <StatusCell row={row} now={now} />
              </td>
              {group.windows.map((window) => {
                const member = window.columns.find(
                  (column) => column.account.key === row.account?.key,
                );
                return (
                  <td key={`${window.kind}:${window.id}`} className="px-2 py-2.5">
                    {member?.window ? (
                      <WindowCell window={member.window} color={color} now={now} />
                    ) : (
                      <span className="text-muted-foreground">Not reported</span>
                    )}
                  </td>
                );
              })}
              {hasCredits ? (
                <td className="px-4 py-2.5">
                  {row.account?.redeem && row.account.limits.resetCredits ? (
                    <ResetCredits
                      environmentId={row.account.redeem.environmentId}
                      input={row.account.redeem.input}
                      credits={row.account.limits.resetCredits}
                      now={now}
                    />
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LimitGroup({
  group,
  color,
  now,
}: {
  readonly group: LimitBoardGroup;
  readonly color: string;
  readonly now: number;
}) {
  const origin = ORIGIN_BADGE[group.kind];
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-1">
        <Badge variant={origin.variant}>{origin.label}</Badge>
        <h3 className="text-sm font-medium text-foreground">{group.title}</h3>
        {group.detail ? (
          <span className="text-xs text-muted-foreground">{group.detail}</span>
        ) : null}
      </div>
      {group.unreadable ? (
        <p className="flex items-start gap-2 px-4 py-3 text-xs text-warning-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            GOAT can't read this pool, so its accounts and limits are hidden. {group.unreadable}
          </span>
        </p>
      ) : null}
      {group.blocks.map((block) => (
        <p key={block} className="px-4 py-1 text-xs font-medium text-destructive-foreground">
          {block}
        </p>
      ))}
      {group.rows.length > 0 ? (
        <GroupTable group={group} color={color} now={now} />
      ) : group.unreadable ? null : (
        <p className="px-4 pt-1 pb-3 text-xs text-muted-foreground">No accounts reported.</p>
      )}
    </div>
  );
}

function LimitSection({
  section,
  now,
}: {
  readonly section: LimitBoardSection;
  readonly now: number;
}) {
  const label = driverLabel(section.driver);
  return (
    <section aria-label={`${label} limits`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderInstanceIcon
            driverKind={section.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-5"
            iconClassName="size-4 text-foreground/80"
          />
          {label}
        </h2>
        <Badge variant={VERDICT_BADGE[section.verdict.tone]}>{section.verdict.text}</Badge>
      </div>
      {section.groups.map((group) => (
        <LimitGroup key={group.key} group={group} color={barColor(section.driver)} now={now} />
      ))}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const { sections, notices } = limitBoard(presentations, now);
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      sections.findIndex((section) => section.driver === "codex"),
      sections.findIndex((section) => section.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {sections.length === 0 &&
      notices.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={section.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <LimitSection section={section} now={now} />
        </Fragment>
      ))}
      {cursorPromptAt === sections.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
