import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { IconButton } from "../../../components/ui/IconButton";
import { cn } from "../../../lib/cn";
import type { NoteEditorCommand } from "./note-editor-protocol";

const formats: ReadonlyArray<{
  readonly command: NoteEditorCommand;
  readonly label: string;
  readonly glyph: string;
  readonly className?: string;
}> = [
  { command: "bold", label: "Bold", glyph: "B", className: "font-goat-bold" },
  { command: "italic", label: "Italic", glyph: "I", className: "italic" },
  { command: "heading", label: "Heading", glyph: "H", className: "font-goat-bold" },
  { command: "bullet", label: "Bulleted list", glyph: "•" },
  { command: "task", label: "Checklist", glyph: "☐" },
];

/** Formatting row above the keyboard while the live editor has focus. */
export function NoteEditorToolbar(props: {
  readonly source: boolean;
  readonly disabled: boolean;
  readonly onCommand: (command: NoteEditorCommand) => void;
}) {
  return (
    <View className="flex-row items-center border-t border-border bg-sheet">
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="items-center px-1"
      >
        {formats.map((format) => (
          <Pressable
            key={format.command}
            accessibilityRole="button"
            accessibilityLabel={format.label}
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onCommand(format.command)}
            className="size-12 items-center justify-center active:opacity-60"
          >
            <AppText
              className={cn(
                "text-lg",
                props.disabled ? "text-foreground-muted" : "text-foreground",
                format.className,
              )}
            >
              {format.glyph}
            </AppText>
          </Pressable>
        ))}
        <IconButton
          icon="arrow.uturn.backward"
          accessibilityLabel="Undo"
          disabled={props.disabled}
          onPress={() => props.onCommand("undo")}
        />
        <IconButton
          icon="arrow.uturn.forward"
          accessibilityLabel="Redo"
          disabled={props.disabled}
          onPress={() => props.onCommand("redo")}
        />
        <IconButton
          icon="chevron.left.forwardslash.chevron.right"
          accessibilityLabel="Show markdown"
          selected={props.source}
          onPress={() => props.onCommand("toggleSource")}
        />
      </ScrollView>
      <IconButton
        icon="chevron.down"
        accessibilityLabel="Hide keyboard"
        onPress={() => props.onCommand("blur")}
      />
    </View>
  );
}
