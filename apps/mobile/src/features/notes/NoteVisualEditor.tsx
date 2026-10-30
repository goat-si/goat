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
const MIN_PAUSE_MS = 600;
// The fork's serializer costs lines × blocks (about 1 ms at 200 list items, 120 ms at 2,000 on an
// M-series Mac), so the typing pause before a snapshot grows with what the last one cost.
const PAUSE_PER_SNAPSHOT_MS = 20;
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
  const pauseMs = useRef(MIN_PAUSE_MS);
  const selection = useRef("");
  const lastFormat = useRef({ selection: "", key: "" });
  const undoing = useRef<Promise<void> | null>(null);
  const onFallback = useEffectEvent((reason: string) => props.onFallback(reason));
  const canEdit = ready && props.editable;

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
    const started = Date.now();
    const markdown = await input.current?.getMarkdown();
    pauseMs.current = Math.max(MIN_PAUSE_MS, (Date.now() - started) * PAUSE_PER_SNAPSHOT_MS);
    const stack = history.current;
    if (markdown !== undefined && markdown !== stack.at(-1)) {
      stack.push(markdown);
      if (stack.length > HISTORY_LIMIT) stack.shift();
    }
    setCanUndo(stack.length > 1);
  };
  // Typing only flags the change; serializing waits for a pause. Undo is offered at once and
  // snapshots first, so it works before a long note's pause has passed.
  const changed = () => {
    props.onChange();
    setCanUndo(true);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void snapshot(), pauseMs.current);
  };
  // Synchronous, so a save read that starts after the tap always sees the command's edit.
  const command = (run: (target: EnrichedMarkdownTextInputInstance) => void) => {
    if (!input.current || !canEdit) return;
    run(input.current);
    changed();
  };
  const undo = () => {
    if (!canEdit || undoing.current) return;
    undoing.current = restorePrevious().then(() => {
      undoing.current = null;
    });
  };
  const restorePrevious = async () => {
    await snapshot();
    const stack = history.current;
    const previous = stack.at(-2);
    if (previous === undefined || !input.current) return;
    stack.pop();
    // iOS echoes setValue as a change and Android does not; a duplicate snapshot is skipped either way.
    input.current.setValue(previous);
    setCanUndo(stack.length > 1);
    props.onChange();
  };

  useImperativeHandle(
    props.handleRef,
    () => ({
      body: async () => {
        // A save that starts while undo is snapshotting reads the restored text.
        await undoing.current;
        const markdown = await input.current?.getMarkdown();
        if (markdown === undefined) throw new Error("The editor closed before the note was read.");
        return visualNoteBody(session, markdown);
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
          disabled={!canEdit}
          onPress={() => command((target) => target.toggleBold())}
        />
        <ToolbarButton
          label="I"
          name="Italic"
          selected={active("italic")}
          disabled={!canEdit}
          onPress={() => command((target) => target.toggleItalic())}
        />
        {([1, 2, 3] as const).map((level) => (
          <ToolbarButton
            key={level}
            label={`H${level}`}
            name={`Heading ${level}`}
            selected={active(`h${level}`)}
            disabled={!canEdit}
            onPress={() => command((target) => target.toggleHeading(level))}
          />
        ))}
        <ToolbarButton
          label="•"
          name="Bulleted list"
          selected={active("bullet")}
          disabled={!canEdit}
          onPress={() => command((target) => target.toggleUnorderedList())}
        />
        <ToolbarButton
          label="1."
          name="Numbered list"
          selected={active("numbered")}
          disabled={!canEdit}
          onPress={() => command((target) => target.toggleOrderedList())}
        />
        <ToolbarButton label="↶" name="Undo" disabled={!canEdit || !canUndo} onPress={undo} />
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
          onChangeText={changed}
          onChangeSelection={({ start, end }) => {
            selection.current = `${start}:${end}`;
          }}
          onChangeState={(state) => {
            const next = styleStateKey(state);
            if (next !== styleKey) setStyleKey(next);
            // Context-menu and keyboard formatting change styles without a text change;
            // a style change on the same selection is an edit.
            const format = formatKey(state);
            const previous = lastFormat.current;
            lastFormat.current = { selection: selection.current, key: format };
            if (ready && previous.selection === selection.current && previous.key !== format)
              changed();
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

function formatKey(state: StyleState): string {
  return JSON.stringify([
    state.bold.isActive,
    state.italic.isActive,
    state.underline.isActive,
    state.strikethrough.isActive,
    state.spoiler.isActive,
    state.link.isActive && state.link.destination,
    state.heading.isActive && state.heading.level,
    state.unorderedList.isActive && state.unorderedList.depth,
    state.orderedList.isActive && state.orderedList.depth,
  ]);
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
