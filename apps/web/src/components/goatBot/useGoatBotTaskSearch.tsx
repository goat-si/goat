import { useAtomValue } from "@effect/atom-react";
import type { BotProfile, ChannelSearchBotTasksResult } from "@goat/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { BotIcon } from "~/components/solar";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { ITEM_ICON_CLASS, type CommandPaletteGroup } from "../CommandPalette.logic";

const NO_PERMISSION = Atom.make(false);
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
): readonly CommandPaletteGroup[] {
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
  const read = useAtomCommand(channelEnvironment.searchBotTasks, { reportFailure: false });
  const usable = bots.filter(
    (bot) => bot.state !== "deleted" && bot.environmentId === environmentId,
  );
  const botKey = usable.map((bot) => bot.botId).join("\u0000");
  const text = query.trim();
  const valid =
    enabled &&
    supported &&
    permitted &&
    text.length > 0 &&
    text.length <= 256 &&
    !text.includes("\u0000") &&
    !text.startsWith(">");
  const key = JSON.stringify([environmentId, botKey, text]);
  const [search, setSearch] = useState<Search>({ key: "", pages: {} });
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(new Set<string>());
  const request = useStableCallback(
    async (
      bot: BotProfile,
      key: string,
      version: number,
      cursor?: string,
      signal?: AbortSignal,
    ) => {
      const flightKey = `${version}:${key}:${bot.botId}`;
      if (inFlight.current.has(flightKey)) return;
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
      const answer = await read(
        {
          environmentId: bot.environmentId,
          input: { botId: bot.botId, query: text, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      inFlight.current.delete(flightKey);
      if (sequence.current !== version) return;
      setSearch((prev) => {
        if (prev.key !== key) return prev;
        const old = prev.pages[bot.botId] ?? emptyPage();
        const page: Page =
          answer._tag === "Success"
            ? {
                tasks: cursor ? [...old.tasks, ...answer.value.tasks] : answer.value.tasks,
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
  const start = useStableCallback((key: string, version: number) => {
    const selected = usable;
    let index = 0;
    const worker = async () => {
      while (sequence.current === version && index < selected.length) {
        const bot = selected[index++];
        if (bot) await request(bot, key, version, undefined, controller.current?.signal);
      }
    };
    for (let i = 0; i < Math.min(4, selected.length); i++) void worker();
  });
  const load = useStableCallback((bot: BotProfile, key: string, cursor?: string) =>
    request(bot, key, sequence.current, cursor, controller.current?.signal),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Debounces remote search and invalidates older requests when its scope changes.
  useEffect(() => {
    const version = ++sequence.current;
    if (!valid) return;
    const active = new AbortController();
    controller.current = active;
    const timer = setTimeout(() => start(key, version), 250);
    return () => {
      clearTimeout(timer);
      sequence.current++;
      active.abort();
      if (controller.current === active) controller.current = null;
    };
  }, [valid, key, start]);
  if (!valid || search.key !== key) return [];
  return usable.flatMap((bot): CommandPaletteGroup[] => {
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
    const status = page.loading
      ? "Searching tasks…"
      : page.error
        ? "Couldn't search tasks."
        : page.tasks.length === 0 && !page.cursor
          ? "No matching tasks."
          : null;
    for (const [id, title] of [
      ["status", status],
      ["partial", page.partial ? "Some results could not be checked." : null],
      ["ended", page.endedEarly ? "Search ended early." : null],
    ] as const)
      if (title)
        items.push({
          kind: "action",
          value: `bot-task-${id}:${bot.botId}`,
          title,
          searchTerms: [text],
          icon,
          disabled: true,
          run: async () => {},
        });
    if (page.cursor && !page.loading)
      items.push({
        kind: "action",
        value: `bot-task-more:${bot.botId}`,
        title: "Load more",
        searchTerms: [text],
        icon,
        keepOpen: true,
        run: async () => load(bot, key, page.cursor),
      });
    if (page.error && !page.loading)
      items.push({
        kind: "action",
        value: `bot-task-retry:${bot.botId}`,
        title: "Retry task search",
        searchTerms: [text],
        icon,
        keepOpen: true,
        run: async () => load(bot, key, page.cursor),
      });
    return [{ value: `bot-tasks:${bot.botId}`, label: `${bot.name} tasks`, items }];
  });
}
