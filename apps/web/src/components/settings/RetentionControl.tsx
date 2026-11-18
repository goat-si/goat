import { useEffect, useRef, useState } from "react";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";

export function RetentionControl({
  label,
  value,
  onChange,
  minimum = 1,
  maximum = 3650,
  unit = "days",
  offLabel = "Off",
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null, onFailed: () => void) => void;
  minimum?: number;
  maximum?: number;
  unit?: string;
  offLabel?: string;
}) {
  const revision = useRef(0);
  const currentValue = useRef(value);
  // oxlint-disable-next-line goat/react-effect-budget -- invalidate pending callbacks when saved settings change
  useEffect(() => {
    currentValue.current = value;
    revision.current++;
  }, [value]);
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  // Saving an age can start a cleanup sweep, so turning a rule on only opens a draft.
  // While its first save is in flight this holds that submission.
  const [enabling, setEnabling] = useState<"draft" | "edited" | { days: number } | null>(null);
  // Holds an age until Enter or focus leaves the row: one edited before focus moved to the
  // switch, so switching off never saves it first, or one stepped toward a rule's first age,
  // so raising it from 8 never saves a shorter age on the way.
  const [held, setHeld] = useState(false);
  // Hides a saved rule's age once it is switched off, so no blur can save it after null.
  const [switchedOff, setSwitchedOff] = useState(false);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
    setEnabling(null);
    setHeld(false);
    setSwitchedOff(false);
  }
  const pending = typeof enabling === "object" ? enabling : null;
  const on = (value !== null && !switchedOff) || enabling !== null;
  const row = useRef<HTMLDivElement>(null);

  const commit = (next: number) => {
    const submittedRevision = ++revision.current;
    const days = Math.min(maximum, Math.max(minimum, Math.round(next)));
    setDraft(days);
    setHeld(false);
    if (days === pending?.days) return;
    if (value !== null) {
      onChange(days, () => {
        if (revision.current === submittedRevision) setDraft(currentValue.current);
      });
      return;
    }
    const submission = { days };
    setEnabling(submission);
    onChange(days, () => setEnabling((current) => (current === submission ? null : current)));
  };

  const switchOff = () => {
    revision.current++;
    setDraft(value);
    setHeld(false);
    setEnabling(null);
    if (value === null && pending === null) return;
    setSwitchedOff(true);
    onChange(null, () => setSwitchedOff(false));
  };

  return (
    <div
      ref={row}
      className="flex items-center gap-3"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (held && draft !== null) commit(draft);
        else setEnabling((current) => (typeof current === "string" ? null : current));
      }}
    >
      {on ? (
        <NumberField
          value={draft}
          min={minimum}
          max={maximum}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={(next) => {
            revision.current++;
            setDraft(next);
            setEnabling((current) => (current === "draft" ? "edited" : current));
          }}
          onValueCommitted={(next, { reason, event }) => {
            if (next === null) setDraft(value);
            else if (
              reason === "input-blur"
                ? event instanceof FocusEvent &&
                  event.relatedTarget instanceof Node &&
                  row.current?.contains(event.relatedTarget)
                : value === null
            ) {
              setDraft(next);
              setHeld(true);
            } else commit(next);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in ${unit}`}
              autoFocus={value === null}
              size={new Intl.NumberFormat().format(draft ?? value ?? 8).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
              // Any typed or pasted edit replaces a held age: NumberField commits it on blur itself,
              // and text it cannot parse yet must not leave the held age to be saved.
              onChange={() => {
                revision.current++;
                setHeld(false);
              }}
              onPaste={() => setHeld(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  // Blurring lets NumberField parse the visible text and commit it once. It
                  // skips an unedited value, so an untouched draft is committed here.
                  const input = event.currentTarget;
                  const shown =
                    draft !== null && input.value === new Intl.NumberFormat().format(draft);
                  if (enabling === "draft" && shown) commit(draft);
                  input.blur();
                } else if (event.key === "Escape" && (held || typeof enabling === "string")) {
                  // An unhandled Escape closes the settings page.
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(pending?.days ?? value);
                  setHeld(false);
                  setEnabling((current) => (typeof current === "string" ? null : current));
                }
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {unit}
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{offLabel}</span>
      )}
      <Switch
        aria-label={label}
        checked={on}
        // Keeps focus in the age field, so switching off never commits an edited age first.
        onMouseDown={(event) => event.preventDefault()}
        onCheckedChange={(enabled) => {
          if (enabled) {
            setDraft(8);
            setEnabling("draft");
          } else switchOff();
        }}
      />
    </div>
  );
}
