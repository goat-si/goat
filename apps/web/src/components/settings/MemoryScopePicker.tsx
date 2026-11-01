import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxEmpty,
  ComboboxListVirtualized,
  ComboboxItem,
} from "../ui/combobox";

/** Search and virtualize destination records without mounting the entire environment. */
export function MemoryScopePicker({
  items,
  value,
  onChange,
  label,
  disabled,
}: {
  items: readonly { id: string; title: string }[];
  value: string | null;
  onChange: (value: string) => void;
  label: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const list = useRef<LegendListRef | null>(null);
  const titles = new Map(items.map((item) => [item.id, item.title]));
  const ids = items.map((item) => item.id);
  const filtered = items
    .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
    .map((item) => item.id);
  function select(id: string) {
    onChange(id);
    setOpen(false);
  }
  return (
    <Combobox
      items={ids}
      filteredItems={filtered}
      value={value}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={(id) => titles.get(id) ?? ""}
      virtualized
      autoHighlight
      onValueChange={(id) => {
        if (id) select(id);
      }}
      onItemHighlighted={(_id, details) => {
        if (details.reason === "keyboard" && details.index >= 0)
          void list.current?.scrollIndexIntoView({ index: details.index, animated: false });
      }}
    >
      <ComboboxTrigger
        render={<Button variant="outline" size="sm" disabled={disabled} aria-label={label} />}
      >
        {value
          ? (titles.get(value) ?? `Choose ${label.toLowerCase()}`)
          : `Choose ${label.toLowerCase()}`}
      </ComboboxTrigger>
      <ComboboxPopup>
        <ComboboxSearchInput
          aria-label={`Search ${label.toLowerCase()}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            void list.current?.scrollToOffset({ offset: 0, animated: false });
          }}
        />
        <ComboboxEmpty>No matches found.</ComboboxEmpty>
        <div style={{ height: 224 }}>
          <ComboboxListVirtualized>
            <LegendList<string>
              ref={list}
              data={filtered}
              keyExtractor={(id) => id}
              estimatedListSize={{ height: 224, width: 320 }}
              estimatedItemSize={32}
              drawDistance={128}
              style={{ height: 224 }}
              renderItem={({ item, index }) => (
                <ComboboxItem value={item} index={index} onClick={() => select(item)}>
                  {titles.get(item)}
                </ComboboxItem>
              )}
            />
          </ComboboxListVirtualized>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
