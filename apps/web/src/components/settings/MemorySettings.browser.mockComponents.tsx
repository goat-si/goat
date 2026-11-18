import type { MemoryItem } from "@goat/contracts";
import { Children, isValidElement, type ReactNode } from "react";

export const legendListMock = {
  LegendList: ({
    data,
    renderItem,
  }: {
    data: MemoryItem[];
    renderItem: (input: { item: MemoryItem }) => ReactNode;
  }) => (
    <div>
      {data.map((item) => (
        <div key={item.memoryId}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
};
export const scopePickerMock = {
  MemoryScopePicker: ({
    items,
    value,
    onChange,
    label,
    disabled,
  }: {
    items: { id: string; title: string }[];
    value: string | null;
    onChange: (id: string) => void;
    label: string;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose</option>
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.title}
        </option>
      ))}
    </select>
  ),
};
export const selectMock = {
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (id: string) => void;
    disabled: boolean;
  }) => {
    const trigger = Children.toArray(children).find(
      (child) => isValidElement<{ "aria-label"?: string }>(child) && child.props["aria-label"],
    );
    return (
      <select
        aria-label={
          isValidElement<{ "aria-label"?: string }>(trigger)
            ? trigger.props["aria-label"]
            : undefined
        }
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onValueChange(e.currentTarget.value)}
      >
        <option value="">Choose a device</option>
        {children}
      </select>
    );
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    children,
    value,
    disabled,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
};
export const settingsLayoutMock = {
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div data-test-row>
      {title}
      {description}
      {status}
      {control}
      {children}
    </div>
  ),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children, id }: { children: ReactNode; id?: string }) => (
    <section id={id}>{children}</section>
  ),
};
