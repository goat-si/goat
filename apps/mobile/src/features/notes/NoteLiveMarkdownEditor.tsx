import MarkdownTextInput from "@expensify/react-native-live-markdown/src/MarkdownTextInput";
import { Platform, useWindowDimensions } from "react-native";
import { resolveMarkdownFontSizes } from "../../lib/appearancePreferences";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { parseNoteMarkdown } from "./note-live-markdown-parser";
import type { NoteEditorSelection } from "./note-source-text";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

/** Loaded on demand from NoteRouteScreen, so the editor and its native runtime start only here. */
export default function NoteLiveMarkdownEditor(props: {
  readonly value: string;
  readonly editable: boolean;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange: (selection: NoteEditorSelection) => void;
  readonly onKeyPress: (key: string) => void;
}) {
  const { appearance, themeVariables: theme } = useAppearancePreferences();
  // Formatted runs get absolute sizes natively, so scale them with the system text size too.
  const { fontScale } = useWindowDimensions();
  const sizes = resolveMarkdownFontSizes(appearance.baseFontSize);
  const code = {
    fontFamily: MONOSPACE,
    fontSize: sizes.codeBlockFontSize * fontScale,
    color: theme["--color-md-code-text"],
    backgroundColor: theme["--color-md-code-bg"],
  };
  return (
    <MarkdownTextInput
      accessibilityLabel="Note markdown"
      multiline
      autoFocus
      textAlignVertical="top"
      value={props.value}
      editable={props.editable}
      onChangeText={props.onChangeText}
      onSelectionChange={(event) => props.onSelectionChange(event.nativeEvent.selection)}
      onKeyPress={(event) => props.onKeyPress(event.nativeEvent.key)}
      parser={parseNoteMarkdown}
      markdownStyle={{
        syntax: { color: theme["--color-foreground-muted"] },
        link: { color: theme["--color-md-link"] },
        h1: { fontSize: sizes.h2 * fontScale },
        code: { ...code, borderColor: theme["--color-md-code-bg"], borderWidth: 0, padding: 0 },
        pre: { ...code, borderColor: theme["--color-md-code-bg"], borderWidth: 0, padding: 0 },
        blockquote: {
          borderColor: theme["--color-md-blockquote-border"],
          borderWidth: 3,
          marginLeft: 2,
          paddingLeft: 8,
        },
      }}
      style={{
        minHeight: 320,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme["--color-input-border"],
        backgroundColor: theme["--color-input"],
        color: theme["--color-foreground"],
        padding: 16,
        fontFamily: FONT_FAMILIES.regular,
        fontSize: sizes.m,
      }}
    />
  );
}
