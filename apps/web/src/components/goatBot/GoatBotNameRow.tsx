import { useAtomValue } from "@effect/atom-react";
import {
  botManageFailure,
  isGeneratedBotName,
  replaceCreatedBot,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type RefObject,
} from "react";

import { XIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { GoatBotComposerHandle } from "./GoatBotComposer";
import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";
import { useGoatBotMember } from "./goatBotMemberContext";
import { webBotNameRowDismissals } from "./goatBotNameRowDismissed";
import { takeNameRowFocus } from "./goatBotNewBotOpen";
import { HoldsNavigation } from "~/lib/navigationHolds";

const NO_PERMISSION = Atom.make(false);
const NAME_MAX = 64;

/**
 * Above a member chat's message box while the bot still has a generated name ("New bot", "New bot
 * 2"…), this person may edit it, it is not deleted, and this browser has not dismissed the row. It
 * reads only that state, so it shows the same on any visit. More opens Edit bot with the typed name.
 */
export function GoatBotNameRow({
  composer,
}: {
  readonly composer: RefObject<GoatBotComposerHandle | null>;
}) {
  const member = useGoatBotMember();
  const presentation = useEnvironment(member?.environmentId ?? null);
  const supported =
    member !== null &&
    member.state !== "deleted" &&
    presentation?.serverConfig?.environment.capabilities.goatBotProfileEdit === true;
  const canEdit = useAtomValue(
    supported ? channelEnvironment.updateBot.permissionAtom(member.environmentId) : NO_PERMISSION,
  );
  const dismissed = useSyncExternalStore(webBotNameRowDismissals.subscribe, () =>
    member === null ? true : webBotNameRowDismissals.dismissed(member.environmentId, member.botId),
  );
  const [more, setMore] = useState<{ readonly botId: string; readonly draftName: string } | null>(
    null,
  );
  const nameInput = useRef<HTMLInputElement>(null);
  const botId = member?.botId ?? null;
  // oxlint-disable-next-line goat/react-effect-budget -- The chat's first showing takes New bot's focus mark, row or not, so a row that appears later never steals focus.
  useLayoutEffect(() => {
    if (botId === null || !takeNameRowFocus(botId)) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [botId]);
  // The row goes away once the bot has a real name or is dismissed; the message box is next.
  const toComposer = () => composer.current?.focus();
  return (
    <>
      {supported && canEdit && !dismissed && isGeneratedBotName(member.name) ? (
        <NameForm
          key={member.botId}
          member={member}
          inputRef={nameInput}
          onMore={(draftName) => setMore({ botId: member.botId, draftName })}
          onGone={toComposer}
        />
      ) : null}
      {member !== null && more?.botId === member.botId ? (
        <GoatBotEditBotDialog
          bot={member}
          canSubmit={canEdit}
          draftName={more.draftName}
          finalFocus={() => composer.current?.field() ?? true}
          onClose={() => setMore(null)}
        />
      ) : null}
    </>
  );
}

function NameForm({
  member,
  inputRef,
  onMore,
  onGone,
}: {
  readonly member: BotProfile;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onMore: (draftName: string) => void;
  readonly onGone: () => void;
}) {
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const [draft, setDraft] = useState(member.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const inputId = useId();
  const name = draft.trim();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || name === "") return;
    if (name === member.name) {
      setError(null);
      setUnchanged(true);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await update({
      environmentId: member.environmentId,
      input: { botId: member.botId, name },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(botManageFailure(squashAtomCommandFailure(result)));
      return;
    }
    replaceCreatedBot(member.environmentId, result.value.bot);
    if (!isGeneratedBotName(name)) onGone();
  }
  return (
    <form
      className="mx-auto grid w-full max-w-3xl gap-1 px-4 pb-2"
      onSubmit={(event) => void save(event)}
    >
      {name === member.name ? null : <HoldsNavigation />}
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        Name this bot
      </label>
      <div className="flex items-center gap-1">
        <Input
          id={inputId}
          ref={inputRef}
          value={draft}
          maxLength={NAME_MAX}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setUnchanged(false);
          }}
        />
        <Button type="submit" size="sm" disabled={saving || name === ""}>
          {saving ? "Saving…" : "Done"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          aria-label={`More settings for ${member.name}`}
          onClick={() => onMore(draft)}
        >
          More
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          disabled={saving}
          aria-label={`Dismiss naming ${member.name}`}
          onClick={() => {
            webBotNameRowDismissals.dismiss(member.environmentId, member.botId);
            onGone();
          }}
        >
          <XIcon />
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {unchanged
          ? `Already called ${member.name}. Type a different name, or use More for other settings.`
          : ""}
      </p>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </form>
  );
}
