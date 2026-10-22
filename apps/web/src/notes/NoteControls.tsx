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
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span>{props.label}</span>
      <Select
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value !== null) props.onChange(value);
        }}
      >
        <SelectTrigger aria-label={props.label}>
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
