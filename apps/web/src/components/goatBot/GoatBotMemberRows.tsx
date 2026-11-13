import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  botManageFailure,
  goatBotAccent,
  goatBotMemberPicture,
  goatBotPreviewText,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { EllipsisIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { GoatBotSessionAvatar } from "./GoatBotAvatar";
import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";
import { GoatBotProfileDialog } from "./GoatBotProfileDialog";
import { HoldsNavigation } from "~/lib/navigationHolds";
import { useBotManage } from "./useBotManage";
import { useGoatBotMemberStatus } from "./useGoatBotMemberStatus";

const NO_PERMISSION = Atom.make(false);

/** Member bots under the main bot: shown ones, then Hidden bots and Deleted bots. */
export function GoatBotMemberRoster({
  environmentId,
  groups,
}: {
  readonly environmentId: EnvironmentId;
  readonly groups: {
    readonly members: ReadonlyArray<BotProfile>;
    readonly hidden: ReadonlyArray<BotProfile>;
    readonly deleted: ReadonlyArray<BotProfile>;
  };
}) {
  const manage = useBotManage(environmentId);
  const canEdit = useAtomValue(
    manage.canManage ? channelEnvironment.updateBot.permissionAtom(environmentId) : NO_PERMISSION,
  );
  const [editing, setEditing] = useState<BotProfile | null>(null);
  const [deleting, setDeleting] = useState<BotProfile | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const actions = {
    canManage: manage.canManage,
    canEdit,
    onEdit: setEditing,
    onHide: (bot: BotProfile, hidden: boolean) => void manage.hide(bot, hidden),
    onDelete: setDeleting,
  };
  return (
    <>
      {groups.members.length > 0 ? (
        <SidebarGroup>
          <SidebarMenu>
            {groups.members.map((bot) => (
              <GoatBotMemberRow key={bot.botId} bot={bot} {...actions} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {groups.hidden.length > 0 ? (
        <SidebarGroup>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={hiddenOpen}
            onClick={() => setHiddenOpen((open) => !open)}
          >
            Hidden bots ({groups.hidden.length})
          </Button>
          {hiddenOpen ? (
            <SidebarMenu>
              {groups.hidden.map((bot) => (
                <GoatBotMemberRow key={bot.botId} bot={bot} {...actions} />
              ))}
            </SidebarMenu>
          ) : null}
        </SidebarGroup>
      ) : null}
      {groups.deleted.length > 0 ? (
        <SidebarGroup aria-label="Deleted bots">
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">Deleted bots</p>
          <ul>
            {groups.deleted.map((bot) => (
              <li key={bot.botId} className="flex items-center gap-2 px-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">
                  {bot.name}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!manage.canManage}
                  aria-label={`Restore ${bot.name}`}
                  onClick={() => void manage.restore(bot)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </SidebarGroup>
      ) : null}
      {editing !== null ? (
        <GoatBotEditBotDialog bot={editing} canSubmit={canEdit} onClose={() => setEditing(null)} />
      ) : null}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => open || setDeleting(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its conversation is archived; you can restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const bot = deleting;
                setDeleting(null);
                if (bot !== null) void manage.remove(bot);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function GoatBotMemberRow({
  bot,
  canManage,
  canEdit,
  onEdit,
  onHide,
  onDelete,
}: {
  readonly bot: BotProfile;
  readonly canManage: boolean;
  readonly canEdit: boolean;
  readonly onEdit: (bot: BotProfile) => void;
  readonly onHide: (bot: BotProfile, hidden: boolean) => void;
  readonly onDelete: (bot: BotProfile) => void;
}) {
  const status = useGoatBotMemberStatus(bot);
  const { waitingCount: count, latest } = status;
  // The row's second line is what the bot last said or was asked; a new bot shows its purpose.
  const latestText = latest === undefined ? "" : goatBotPreviewText(latest.text);
  const line =
    latestText !== ""
      ? latest?.author === "person"
        ? `You: ${latestText}`
        : latestText
      : (bot.purpose ?? "");
  const params = useParams({ strict: false });
  const active =
    params.environmentId === bot.environmentId && params.threadId === bot.sessionThreadId;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        className="group/bot-row"
        isActive={active}
        aria-current={active ? "page" : undefined}
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: bot.environmentId, threadId: bot.sessionThreadId }}
          />
        }
      >
        {/* The same slots as the main bot's row: unread mark, avatar, name over a second line.
            The avatar's label leads the link's name with the bot's state and its waiting count. */}
        <span aria-hidden className="size-2.5 shrink-0 group-data-[collapsible=icon]:hidden" />
        <GoatBotSessionAvatar
          size="md"
          place="list"
          surface="sidebar"
          waitingCount={count}
          row={status}
          countInLabel
          emoji={goatBotMemberPicture(bot)}
          accent={goatBotAccent(bot)}
          threadRef={scopeThreadRef(bot.environmentId, bot.sessionThreadId)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            {count > 0 ? (
              <Badge size="sm" variant="secondary" aria-hidden>
                {count}
              </Badge>
            ) : null}
          </span>
          {line ? (
            <span className="min-w-0 truncate text-xs font-normal text-sidebar-muted-foreground">
              {line}
            </span>
          ) : null}
        </span>
        {canManage ? <span aria-hidden className="w-5 shrink-0" /> : null}
      </SidebarMenuButton>
      {canManage ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`${bot.name} options`}
                className="absolute top-1/2 right-1 -translate-y-1/2"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <HoldsNavigation />
            <MenuItem disabled={!canEdit} onClick={() => onEdit(bot)}>
              Edit
            </MenuItem>
            <MenuItem onClick={() => onHide(bot, bot.hidden !== true)}>
              {bot.hidden === true ? "Show" : "Hide"}
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => onDelete(bot)}>
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </SidebarMenuItem>
  );
}

/** The main bot's row menu: Edit opens its profile. Absent where profiles can't be edited. */
export function GoatBotMainMenu({
  environmentId,
  main,
}: {
  readonly environmentId: EnvironmentId;
  readonly main: BotProfile;
}) {
  const presentation = useEnvironment(environmentId);
  const supported =
    presentation?.serverConfig?.environment.capabilities.goatBotProfileEdit === true;
  const canEdit = useAtomValue(
    supported ? channelEnvironment.updateBot.permissionAtom(environmentId) : NO_PERMISSION,
  );
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  if (!supported || !canEdit) return null;
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`${main.name} options`}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <HoldsNavigation />
          <MenuItem onClick={() => setEditing(true)}>Edit</MenuItem>
        </MenuPopup>
      </Menu>
      {editing ? (
        <GoatBotProfileDialog
          initial={main}
          canSubmit={canEdit}
          onClose={() => setEditing(false)}
          onSubmit={async (changes) => {
            const result = await update({
              environmentId,
              input: { botId: main.botId, ...changes },
            });
            return result._tag === "Success"
              ? null
              : botManageFailure(squashAtomCommandFailure(result));
          }}
        />
      ) : null}
    </>
  );
}
