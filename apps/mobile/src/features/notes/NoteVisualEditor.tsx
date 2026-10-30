import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import {
  EnrichedMarkdownTextInput,
  type EnrichedMarkdownTextInputInstance,
  type StyleState,
} from "react-native-enriched-markdown";
import { AppText as Text } from "../../components/ui/AppText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { openVisualNote, visualEditorBlocker, visualNoteBody } from "./note-wysiwyg";

export interface NoteVisualEditorHandle {
  /** The note body to save: the original bytes when nothing changed. */
  readonly body: () => Promise<string>;
}

const HISTORY_LIMIT = 30;
const HISTORY_PAUSE_MS = 600;
const NO_STATE = "";

/** Loaded lazily from the note screen, so the rich input costs nothing until a note is edited. */
export default function NoteVisualEditor(props: {
  readonly body: string;
  readonly editable: boolean;
  readonly handleRef: Ref<NoteVisualEditorHandle>;
  readonly onChange: () => void;
  readonly onFallback: (reason: string) => void;
}) {
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const { height } = useWindowDimensions();
  const input = useRef<EnrichedMarkdownTextInputInstance>(null);
  // The editor is uncontrolled; the body it opened with stays the save baseline.
  const [session] = useState(() => openVisualNote(props.body));
  const [ready, setReady] = useState(false);
  const [styleKey, setStyleKey] = useState(NO_STATE);
  const [canUndo, setCanUndo] = useState(false);
  const history = useRef([session.text]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoring = useRef(false);
  const onFallback = useEffectEvent((reason: string) => props.onFallback(reason));

  // oxlint-disable-next-line goat/react-effect-budget -- checks the native serializer once, after the input mounts
  useEffect(() => {
    const blocker = visualEditorBlocker(session.source);
    if (blocker) {
      onFallback(`Opened as markdown because this note has ${blocker}.`);
      return;
    }
    let active = true;
    void input.current
      ?.getMarkdown()
      .then((markdown) => {
        if (!active) return;
        if (markdown === session.text) {
          setReady(true);
          input.current?.focus();
        } else
          onFallback(
            "Opened as markdown because the visual editor would rewrite parts of this note.",
          );
      })
      .catch(() => {
        if (active) onFallback("Opened as markdown because the visual editor did not load.");
      });
    return () => {
      active = false;
      if (pending.current) clearTimeout(pending.current);
    };
  }, [session]);

  const snapshot = async () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const markdown = await input.current?.getMarkdown();
    const stack = history.current;
    if (markdown === undefined || markdown === stack.at(-1)) return;
    stack.push(markdown);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    setCanUndo(stack.length > 1);
  };
  // Typing only flags the change; serializing waits for a pause so large notes type smoothly.
  const changed = () => {
    props.onChange();
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void snapshot(), HISTORY_PAUSE_MS);
  };
  const command = (run: (target: EnrichedMarkdownTextInputInstance) => void) => {
    if (!input.current || !ready) return;
    run(input.current);
    changed();
  };
  const undo = async () => {
    await snapshot();
    const stack = history.current;
    const previous = stack.at(-2);
    if (previous === undefined || !input.current) return;
    stack.pop();
    restoring.current = true;
    input.current.setValue(previous);
    setCanUndo(stack.length > 1);
    props.onChange();
  };

  useImperativeHandle(
    props.handleRef,
    () => ({
      body: async () => {
        const markdown = await input.current?.getMarkdown();
        return markdown === undefined ? session.source : visualNoteBody(session, markdown);
      },
    }),
    [session],
  );

  const markdownStyle = useMemo(() => {
    const [h1, h2, h3, h4, h5, h6] = nativeTextStyle.headingFontSizes ?? [];
    const heading = (fontSize: number | undefined) => ({
      fontSize,
      color: nativeTextStyle.strongColor,
    });
    return {
      strong: { color: nativeTextStyle.strongColor },
      link: { color: nativeTextStyle.linkColor, underline: true },
      h1: heading(h1),
      h2: heading(h2),
      h3: heading(h3),
      h4: heading(h4),
      h5: heading(h5),
      h6: heading(h6),
      list: { itemSpacing: 4 },
    };
  }, [nativeTextStyle]);
  const active = (name: string) => styleKey.split(" ").includes(name);

  return (
    <View className="gap-2">
      <View accessibilityRole="toolbar" className="flex-row flex-wrap gap-1">
        <ToolbarButton
          label="B"
          name="Bold"
          selected={active("bold")}
          disabled={!ready}
          onPress={() => command((target) => target.toggleBold())}
        />
        <ToolbarButton
          label="I"
          name="Italic"
          selected={active("italic")}
          disabled={!ready}
          onPress={() => command((target) => target.toggleItalic())}
        />
        {([1, 2, 3] as const).map((level) => (
          <ToolbarButton
            key={level}
            label={`H${level}`}
            name={`Heading ${level}`}
            selected={active(`h${level}`)}
            disabled={!ready}
            onPress={() => command((target) => target.toggleHeading(level))}
          />
        ))}
        <ToolbarButton
          label="•"
          name="Bulleted list"
          selected={active("bullet")}
          disabled={!ready}
          onPress={() => command((target) => target.toggleUnorderedList())}
        />
        <ToolbarButton
          label="1."
          name="Numbered list"
          selected={active("numbered")}
          disabled={!ready}
          onPress={() => command((target) => target.toggleOrderedList())}
        />
        <ToolbarButton
          label="↶"
          name="Undo"
          disabled={!ready || !canUndo}
          onPress={() => void undo()}
        />
      </View>
      {ready ? null : <Text className="text-xs text-foreground-muted">Checking this note…</Text>}
      <View className="rounded-xl border border-input-border bg-input px-4 py-3">
        <EnrichedMarkdownTextInput
          ref={input}
          accessibilityLabel="Note"
          defaultValue={session.text}
          editable={props.editable && ready}
          autoFocus={false}
          markdownShortcuts
          // Typed URLs stay as typed; auto-linking would rewrite them into [text](url).
          linkRegex={null}
          formatMenuConfig={{ underline: { enabled: false }, spoiler: { enabled: false } }}
          placeholder="Write your note"
          placeholderTextColor={nativeTextStyle.mutedColor}
          cursorColor={nativeTextStyle.linkColor}
          selectionColor={nativeTextStyle.linkColor}
          markdownStyle={markdownStyle}
          onChangeText={() => {
            if (restoring.current) restoring.current = false;
            else changed();
          }}
          onChangeState={(state) => {
            const next = styleStateKey(state);
            if (next !== styleKey) setStyleKey(next);
          }}
          style={{
            height: Math.min(Math.max(height * 0.5, 280), 720),
            color: nativeTextStyle.color,
            fontSize: nativeTextStyle.fontSize,
            fontFamily: nativeTextStyle.fontFamily,
          }}
        />
      </View>
    </View>
  );
}

function styleStateKey(state: StyleState): string {
  return [
    state.bold.isActive && "bold",
    state.italic.isActive && "italic",
    state.heading.isActive && `h${state.heading.level}`,
    state.unorderedList.isActive && "bullet",
    state.orderedList.isActive && "numbered",
  ]
    .filter(Boolean)
    .join(" ");
}

function ToolbarButton(props: {
  readonly label: string;
  readonly name: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: Boolean(props.selected), disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-11 min-w-11 items-center justify-center rounded-lg bg-primary px-2"
          : "min-h-11 min-w-11 items-center justify-center rounded-lg bg-subtle px-2 active:opacity-70"
      }
    >
      <Text
        className={
          props.disabled
            ? "font-goat-medium text-foreground-muted"
            : props.selected
              ? "font-goat-medium text-primary-foreground"
              : "font-goat-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
