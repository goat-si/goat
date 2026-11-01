import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export function NoteChoice(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  /** Compact form for a toolbar, where the trigger's accessible name carries the label. */
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={props.compact ? "flex" : "grid gap-1.5 text-sm"}>
      <span className={props.compact ? "sr-only" : undefined}>{props.label}</span>
      <Select
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value !== null) props.onChange(value);
        }}
      >
        <SelectTrigger
          aria-label={props.label}
          variant={props.compact ? "ghost" : "default"}
          size={props.compact ? "compact" : "default"}
        >
          <SelectValue>
            {props.options.find((option) => option.value === props.value)?.label ?? "Choose…"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}
