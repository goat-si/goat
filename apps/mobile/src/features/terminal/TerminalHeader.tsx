import { Platform } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../lib/appearancePreferences";
import { basename, getTerminalStatusLabel, type TerminalMenuSession } from "./terminalMenu";

export function TerminalHeader(props: {
  readonly subtitle: string;
  readonly isEnvironmentReady: boolean;
  readonly canOperateTerminal: boolean;
  readonly fontSize: number;
  readonly terminalId: string;
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly status: Parameters<typeof getTerminalStatusLabel>[0];
  readonly workspaceRoot: string;
  readonly onBack: () => void;
  readonly onCloseTerminal: () => void;
  readonly onDecreaseFontSize: () => void;
  readonly onIncreaseFontSize: () => void;
  readonly onOpenNewTerminal: () => void;
  readonly onSelectTerminal: (terminalId: string) => void;
}) {
  return (
    <AppBar
      title="Terminal"
      subtitle={props.subtitle}
      onBack={props.onBack}
      backInSplitView={{
        accessibilityLabel: "Back to chat",
        icon: "chevron.left",
      }}
      actions={
        Platform.OS === "android" && props.isEnvironmentReady
          ? [
              {
                accessibilityLabel: "Close terminal",
                icon: "trash",
                // Tabler's trash is 18 units tall; the terminal glyph beside it is 16.
                iconScale: 16 / 18,
                destructive: true,
                disabled: !props.canOperateTerminal,
                onPress: props.onCloseTerminal,
              },
            ]
          : undefined
      }
      menus={
        props.isEnvironmentReady
          ? [
              {
                title: "Terminal options",
                icon: "terminal",
                status: getTerminalStatusLabel(props.status),
                items: [
                  {
                    id: "text-size",
                    title: "Text size",
                    icon: "textformat.size",
                    inline: true,
                    items: [
                      {
                        id: "font-decrease",
                        title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, props.fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize <= MIN_TERMINAL_FONT_SIZE,
                        onPress: props.onDecreaseFontSize,
                      },
                      {
                        id: "font-increase",
                        title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, props.fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize >= MAX_TERMINAL_FONT_SIZE,
                        onPress: props.onIncreaseFontSize,
                      },
                    ],
                  },
                  ...props.sessions.map((session) => ({
                    id: `terminal-session:${session.terminalId}`,
                    title: session.displayLabel,
                    icon: "terminal",
                    subtitle: [
                      getTerminalStatusLabel({
                        status: session.status,
                        hasRunningSubprocess: session.hasRunningSubprocess,
                      }),
                      basename(session.cwd),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    selected: session.terminalId === props.terminalId,
                    onPress: () => props.onSelectTerminal(session.terminalId),
                  })),
                  {
                    id: "terminal-new",
                    disabled: !props.canOperateTerminal,
                    title: "Open new terminal",
                    icon: "plus",
                    subtitle: `Start another shell in ${basename(props.workspaceRoot) ?? "this workspace"}`,
                    onPress: props.onOpenNewTerminal,
                  },
                ],
              },
            ]
          : undefined
      }
    />
  );
}
