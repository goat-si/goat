import { useAtomValue } from "@effect/atom-react";
import { reportAtomCommandResult } from "@goat/client-runtime/state/runtime";
import type { BotProfile, ChannelSearchBotTasksResult } from "@goat/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { BotIcon } from "~/components/solar";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { pruneBotTaskSearch, scheduleBotTaskSearch } from "./botTaskSearchScheduler";
import { ITEM_ICON_CLASS, type CommandPaletteGroup } from "../CommandPalette.logic";

const NO_PERMISSION = Atom.make(false);
const QUERY_MAX_BYTES = 256;
const PAGE_SIZE = 20;
const RESULT_LIMIT = 50;
type Page = {
  tasks: ChannelSearchBotTasksResult["tasks"];
  cursor?: string;
  partial: boolean;
  endedEarly: boolean;
  error: boolean;
  loading: boolean;
};
type Search = { key: string; pages: Record<string, Page> };
const emptyPage = (): Page => ({
  tasks: [],
  partial: false,
  endedEarly: false,
  error: false,
  loading: false,
});

export function useGoatBotTaskSearch(
  bots: readonly BotProfile[],
  query: string,
  enabled: boolean,
  navigate: ReturnType<typeof useNavigate>,
): { groups: readonly CommandPaletteGroup[]; status: string } {
  const configs = useServerConfigs();
  const environmentId = bots[0]?.environmentId;
  const supported =
    environmentId !== undefined &&
    configs.get(environmentId)?.environment.capabilities.goatBotTaskLookupSearch === true;
  const permitted = useAtomValue(
    environmentId === undefined
      ? NO_PERMISSION
      : channelEnvironment.searchBotTasks.permissionAtom(environmentId),
  );
  const read = useAtomCommand(channelEnvironment.searchBotTasks, {
    reportFailure: false,
    reportDefect: false,
  });
  const usable = bots.filter(
    (bot) => bot.state !== "deleted" && bot.environmentId === environmentId,
  );
  const botKey = usable.map((bot) => bot.botId).join("\u0000");
  const text = query.trim();
  const tooLong = new TextEncoder().encode(text).byteLength > QUERY_MAX_BYTES;
  const valid =
    enabled &&
    supported &&
    permitted &&
    text.length > 0 &&
    !tooLong &&
    !text.includes("\u0000") &&
    !text.startsWith(">");
  const key = JSON.stringify([environmentId, botKey, text]);
  const [search, setSearch] = useState<Search>({ key: "", pages: {} });
  const activeKey = valid ? key : "";
  const [previousKey, setPreviousKey] = useState(activeKey);
  if (previousKey !== activeKey) {
    setPreviousKey(activeKey);
    setSearch({ key: "", pages: {} });
  }
  const sequence = useRef(0);
  const inFlight = useRef(new Set<string>());
  const request = useStableCallback(
    async (bot: BotProfile, key: string, version: number, limit: number, cursor?: string) => {
      // Superseded reads run to completion; their answers are ignored.
      const answer = await read({
        environmentId: bot.environmentId,
        input: { botId: bot.botId, query: text, limit, ...(cursor ? { cursor } : {}) },
      });
      if (sequence.current !== version) return;
      reportAtomCommandResult(answer, {
        label: channelEnvironment.searchBotTasks.label,
        reportFailure: false,
      });
      setSearch((prev) => {
        if (prev.key !== key) return prev;
        const old = prev.pages[bot.botId] ?? emptyPage();
        const page: Page =
          answer._tag === "Success"
            ? {
                tasks: (cursor ? [...old.tasks, ...answer.value.tasks] : answer.value.tasks).slice(
                  0,
                  RESULT_LIMIT,
                ),
                ...(answer.value.nextCursor ? { cursor: answer.value.nextCursor } : {}),
                partial: old.partial || answer.value.partial === true,
                endedEarly: old.endedEarly || answer.value.endedEarly === true,
                error: false,
                loading: false,
              }
            : { ...old, error: true, loading: false };
        return { key, pages: { ...prev.pages, [bot.botId]: page } };
      });
    },
  );
  const enqueue = useStableCallback(
    (bot: BotProfile, key: string, version: number, limit: number, cursor?: string) => {
      const flightKey = JSON.stringify([version, key, bot.botId]);
      if (inFlight.current.has(flightKey)) return Promise.resolve();
      inFlight.current.add(flightKey);
      setSearch((prev) => ({
        key,
        pages: {
          ...(prev.key === key ? prev.pages : {}),
          [bot.botId]: {
            ...(prev.key === key ? (prev.pages[bot.botId] ?? emptyPage()) : emptyPage()),
            loading: true,
            error: false,
          },
        },
      }));
      return scheduleBotTaskSearch(
        () => sequence.current === version,
        () => request(bot, key, version, limit, cursor),
        () =>
          setSearch((prev) => {
            if (prev.key !== key) return prev;
            return {
              ...prev,
              pages: {
                ...prev.pages,
                [bot.botId]: {
                  ...(prev.pages[bot.botId] ?? emptyPage()),
                  error: true,
                  loading: false,
                },
              },
            };
          }),
      ).finally(() => inFlight.current.delete(flightKey));
    },
  );
  const start = useStableCallback((key: string, version: number) => {
    for (const bot of usable) void enqueue(bot, key, version, PAGE_SIZE);
  });
  const load = useStableCallback((bot: BotProfile, key: string, limit: number, cursor?: string) =>
    enqueue(bot, key, sequence.current, limit, cursor),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Debounces remote search and invalidates older requests when its scope changes.
  useEffect(() => {
    const version = ++sequence.current;
    if (!valid) return;
    const timer = setTimeout(() => start(key, version), 250);
    return () => {
      clearTimeout(timer);
      sequence.current++;
      pruneBotTaskSearch();
    };
  }, [valid, key, start]);
  if (!valid) {
    if (enabled && supported && permitted && tooLong && !text.startsWith(">")) {
      const note = "Search text is too long for task titles.";
      return {
        groups: [{ value: "bot-task-query-too-long", label: "Task titles", note, items: [] }],
        status: note,
      };
    }
    return { groups: [], status: "" };
  }
  if (search.key !== key) return { groups: [], status: "Searching tasks…" };
  const statuses: string[] = [];
  const groups = usable.flatMap((bot): CommandPaletteGroup[] => {
    const page = search.pages[bot.botId];
    if (!page) return [];
    const icon = <BotIcon className={ITEM_ICON_CLASS} />;
    const items: CommandPaletteGroup["items"][number][] = page.tasks.map((task) => ({
      kind: "action",
      value: `bot-task:${bot.botId}:${task.taskId}`,
      title: task.title,
      description: bot.name,
      searchTerms: [text, task.title],
      icon,
      run: () =>
        navigate({
          to: "/bot",
          search: {
            task: task.taskId,
            taskTitle: task.title,
            ...(bot.role === "member" ? { bot: bot.botId } : {}),
          },
        }),
    }));
    const notes = [
      page.error ? "Couldn't search tasks." : null,
      !page.loading &&
      !page.error &&
      page.tasks.length === 0 &&
      (page.partial || page.endedEarly || page.cursor)
        ? "No matching tasks found. Some tasks could not be checked."
        : null,
      page.partial ? "Some results could not be checked." : null,
      page.endedEarly ? "Search ended early." : null,
      page.tasks.length >= RESULT_LIMIT && (page.cursor || page.endedEarly)
        ? "More tasks may exist. Narrow your search."
        : null,
    ].filter((message) => message !== null);
    const messages = [
      page.loading ? "Searching tasks…" : null,
      !page.loading &&
      !page.error &&
      page.tasks.length === 0 &&
      !page.partial &&
      !page.endedEarly &&
      !page.cursor
        ? "No matching tasks."
        : null,
      ...notes,
    ].filter((message) => message !== null);
    if (messages.length) statuses.push(`${bot.name}: ${messages.join(" ")}`);
    if (page.cursor && !page.loading && page.tasks.length < RESULT_LIMIT)
      items.push({
        kind: "action",
        value: `bot-task-more:${bot.botId}`,
        title: "Load more",
        searchTerms: [text],
        icon,
        keepOpen: true,
        run: async () =>
          load(bot, key, Math.min(PAGE_SIZE, RESULT_LIMIT - page.tasks.length), page.cursor),
      });
    if (page.error && !page.loading)
      items.push({
        kind: "action",
        value: `bot-task-retry:${bot.botId}`,
        title: "Retry task search",
        searchTerms: [text],
        icon,
        keepOpen: true,
        run: async () =>
          load(bot, key, Math.min(PAGE_SIZE, RESULT_LIMIT - page.tasks.length), page.cursor),
      });
    const note = notes.join(" ");
    return items.length || note
      ? [
          {
            value: `bot-tasks:${bot.botId}`,
            label: `${bot.name} tasks`,
            ...(note ? { note } : {}),
            items,
          },
        ]
      : [];
  });
  return { groups, status: statuses.join(" ") };
}

export function BotTaskSearchStatus({ status }: { status: string }) {
  return (
    <div role="status" aria-label="Bot task search" aria-live="polite" className="sr-only">
      {status}
    </div>
  );
}
