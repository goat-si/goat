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
  /**
   * Ends input before a read: list keys and IME composition change the note without a text
   * event, and once the input is blurred neither can reach it.
   */
  readonly settle: () => Promise<void>;
  /** The note body to save: the original bytes when nothing changed or the check has not passed. */
  readonly body: () => Promise<string>;
}

const HISTORY_LIMIT = 30;
const MIN_PAUSE_MS = 600;
// The fork's serializer costs lines × blocks (about 1 ms at 200 list items, 120 ms at 2,000 on an
// M-series Mac), so the typing pause before a snapshot grows with what the last one cost.
const PAUSE_PER_SNAPSHOT_MS = 20;
const NO_STATE = "";
const READ_TIMEOUT_MS = 5000;
const BLUR_TIMEOUT_MS = 1000;

/** Loaded lazily from the note screen, so the rich input costs nothing until a note is edited. */
export default function NoteVisualEditor(props: {
  readonly body: string;
  readonly editable: boolean;
  readonly handleRef: Ref<NoteVisualEditorHandle>;
  readonly onChange: () => void;
  readonly onError: (message: string) => void;
  readonly onFallback: (reason: string) => void;
}) {
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const { height } = useWindowDimensions();
  const input = useRef<EnrichedMarkdownTextInputInstance>(null);
  // The editor is uncontrolled; the body it opened with stays the save baseline.
  const [session] = useState(() => openVisualNote(props.body));
  const [ready, setReady] = useState(false);
  const [styleKey, setStyleKey] = useState(NO_STATE);
  const [undoing, setUndoing] = useState(false);
  const history = useRef([session.text]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseMs = useRef(MIN_PAUSE_MS);
  const version = useRef(0);
  const undoRun = useRef<Promise<void> | null>(null);
  const focused = useRef(false);
  const blurred = useRef<Array<() => void>>([]);
  const selection = useRef({ start: 0, end: 0 });
  const refocus = useRef<{ start: number; end: number } | null>(null);
  const onFallback = useEffectEvent((reason: string) => props.onFallback(reason));
  const canEdit = ready && props.editable && !undoing;

  // oxlint-disable-next-line goat/react-effect-budget -- checks the native serializer once, after the input mounts
  useEffect(() => {
    const blocker = visualEditorBlocker(session.source);
    if (blocker) {
      onFallback(`Opened as markdown because this note has ${blocker}.`);
      return;
    }
    let active = true;
    const started = Date.now();
    void readWithTimeout(input.current)
      .then((markdown) => {
        if (!active) return;
        if (markdown === session.text) {
          pauseMs.current = Math.max(MIN_PAUSE_MS, (Date.now() - started) * PAUSE_PER_SNAPSHOT_MS);
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

  const readMarkdown = () => readWithTimeout(input.current);
  const snapshot = async () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const started = Date.now();
    const markdown = await readMarkdown();
    pauseMs.current = Math.max(MIN_PAUSE_MS, (Date.now() - started) * PAUSE_PER_SNAPSHOT_MS);
    const stack = history.current;
    if (markdown !== stack.at(-1)) {
      stack.push(markdown);
      if (stack.length > HISTORY_LIMIT) stack.shift();
    }
  };
  // Typing only flags the change; serializing waits for a pause. Undo is offered at once and
  // snapshots first, so it works before a long note's pause has passed.
  const changed = () => {
    version.current++;
    props.onChange();
    scheduleSnapshot();
  };
  const fail = (error: unknown) =>
    props.onError(error instanceof Error ? error.message : "The editor could not read the note.");
  const scheduleSnapshot = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void snapshot().catch(fail), pauseMs.current);
  };
  // Synchronous, so a save read that starts after the tap always sees the command's edit.
  const command = (run: (target: EnrichedMarkdownTextInputInstance) => void) => {
    if (!input.current || !canEdit) return;
    run(input.current);
    changed();
  };
  const undo = () => {
    if (!canEdit || undoRun.current) return;
    refocus.current = focused.current ? { ...selection.current } : null;
    setUndoing(true);
    const release = () => {
      undoRun.current = null;
      setUndoing(false);
    };
    undoRun.current = restorePrevious().catch(fail).then(release);
  };
  const restorePrevious = async () => {
    await settle();
    const started = version.current;
    await snapshot();
    const stack = history.current;
    const previous = stack.at(-2);
    // Typing that reached the input after undo started wins over the restore.
    if (previous === undefined || !input.current || version.current !== started) return;
    stack.pop();
    // iOS echoes setValue as a change and Android does not; a duplicate snapshot is skipped either way.
    input.current.setValue(previous);
    props.onChange();
  };
  const settle = () =>
    new Promise<void>((resolve, reject) => {
      const target = input.current;
      if (!target) return resolve();
      // Blur even when unfocused, in case a focus event is still on its way.
      if (!focused.current) {
        target.blur();
        return resolve();
      }
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // Without a confirmed blur the read has no boundary, so it fails instead of guessing.
      const timer = setTimeout(() => {
        blurred.current = blurred.current.filter((waiter) => waiter !== done);
        reject(new Error("The editor did not finish input. Try again."));
      }, BLUR_TIMEOUT_MS);
      blurred.current.push(done);
      target.blur();
    });
  // oxlint-disable-next-line goat/react-effect-budget -- focus waits for the input to be enabled again after undo
  useEffect(() => {
    const target = refocus.current;
    if (undoing || !target || !input.current) return;
    refocus.current = null;
    input.current.focus();
    input.current.setSelection(target.start, target.end);
  }, [undoing]);

  useImperativeHandle(
    props.handleRef,
    () => ({
      settle: async () => {
        // An undo restores, then a save reads: never the other way round.
        await undoRun.current;
        await settle();
      },
      body: async () => {
        // Before the open check passes nothing could be edited, and the serializer may rewrite.
        if (!ready) return session.source;
        await undoRun.current;
        return visualNoteBody(session, await readMarkdown());
      },
    }),
    [session, ready],
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
        <ToolbarButton label="↶" name="Undo" disabled={!canEdit} onPress={undo} />
      </View>
      {ready ? null : <Text className="text-xs text-foreground-muted">Checking this note…</Text>}
      <View className="rounded-xl border border-input-border bg-input px-4 py-3">
        <EnrichedMarkdownTextInput
          ref={input}
          accessibilityLabel="Note"
          defaultValue={session.text}
          editable={canEdit}
          autoFocus={false}
          markdownShortcuts={{ heading: true, unorderedList: true }}
          // Typed URLs stay as typed; auto-linking would rewrite them into [text](url).
          linkRegex={null}
          // The native Format menu changes styles without a reliable change event, so formatting goes
          // through the toolbar, which reports every edit.
          selectionMenuConfig={{ format: { enabled: false } }}
          placeholder="Write your note"
          placeholderTextColor={nativeTextStyle.mutedColor}
          cursorColor={nativeTextStyle.linkColor}
          selectionColor={nativeTextStyle.linkColor}
          markdownStyle={markdownStyle}
          onChangeText={changed}
          onChangeSelection={(next) => {
            selection.current = next;
          }}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            for (const resolve of blurred.current.splice(0)) resolve();
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

// The fork never times out a native read, so a lost response would hold every lock forever.
function readWithTimeout(target: EnrichedMarkdownTextInputInstance | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!target) return reject(new Error("The editor closed before the note was read."));
    const timer = setTimeout(
      () => reject(new Error("The editor did not answer. Try again.")),
      READ_TIMEOUT_MS,
    );
    target.getMarkdown().then(
      (markdown) => {
        clearTimeout(timer);
        resolve(markdown);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function styleStateKey(state: StyleState): string {
  return [
    state.bold.isActive && "bold",
    state.italic.isActive && "italic",
    state.heading.isActive && `h${state.heading.level}`,
    state.unorderedList.isActive && "bullet",
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
