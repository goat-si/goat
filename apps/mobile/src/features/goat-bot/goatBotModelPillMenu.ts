import type { useMobileGoatBotModelMenu } from "./useMobileGoatBotModel";
import type { MobileGoatBotMemberModelMenu } from "./useMobileGoatBotMemberModel";

type MainMenu = NonNullable<ReturnType<typeof useMobileGoatBotModelMenu>>;

/** The model menu the composer's pill opens, the same for the main bot and a member. */
export interface GoatBotModelPillMenu {
  readonly label: string;
  readonly accessibilityLabel: string;
  /** Said at the top of the menu; for a member that cannot change, why not. */
  readonly title: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly subtitle?: string | undefined;
    readonly selected: boolean;
  }>;
  /** Whether the pill opens at all; a member's opens to say why its choices are off. */
  readonly opens: boolean;
  readonly canChange: boolean;
  readonly select: (id: string) => void;
}

/**
 * The chat's model menu: a member chat's own, else the main bot's; null while it is not known. A
 * member chat never falls back to the main bot's menu, whose choices would change the main bot.
 */
export function goatBotModelPillMenu(
  member: MobileGoatBotMemberModelMenu | null,
  main: MainMenu | null,
  memberChat: boolean,
): GoatBotModelPillMenu | null {
  if (memberChat) return member === null ? null : { ...member, opens: true };
  if (main === null) return null;
  return {
    ...main,
    title: main.accessibilityLabel,
    opens: !main.disabled,
    canChange: !main.disabled,
  };
}
