import { useEffect, useRef, useState } from "react";

import { InputGroup, InputGroupInput } from "~/components/ui/input-group";

function lineCountOf(contents: string): number {
  return contents.split(/\r\n|\r|\n/).length;
}

/** "42" or "42:7" (VS Code's line:column), within the file. */
function parseLine(value: string, lineCount: number): number | null {
  const match = /^\s*(\d+)(?::\d+)?\s*$/.exec(value);
  const line = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(line) && line >= 1 && line <= lineCount ? line : null;
}

export function FileGoToLine(props: {
  contents: string;
  shortcut: string | null;
  onSubmit: (line: number) => void;
  onClose: () => void;
}) {
  const lineCount = lineCountOf(props.contents);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <InputGroup variant="ghost" className="h-7 w-40 shrink-0">
      <InputGroupInput
        ref={inputRef}
        type="text"
        inputMode="numeric"
        size="sm"
        aria-label="Go to line"
        aria-invalid={invalid || undefined}
        placeholder={`Line 1–${lineCount}${props.shortcut ? ` (${props.shortcut})` : ""}`}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            const line = parseLine(value, lineCount);
            if (line === null) setInvalid(true);
            else props.onSubmit(line);
          }
        }}
        onBlur={props.onClose}
      />
    </InputGroup>
  );
}
