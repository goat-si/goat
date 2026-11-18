export function createButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.className =
    "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2 font-sans text-xs font-medium text-foreground outline-none hover:bg-accent disabled:pointer-events-none disabled:opacity-60";
  return button;
}

export function styleControl(input: HTMLInputElement | HTMLSelectElement): void {
  input.setAttribute("aria-label", input.getAttribute("aria-label") ?? "Style value");
  input.className =
    "h-7 min-w-0 w-full appearance-none rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-xs outline-none";
}

export function createUnitControl(input: HTMLInputElement): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;min-width:0";
  const unit = document.createElement("span");
  unit.textContent = input.dataset.unit ?? "";
  unit.className =
    "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-xs text-muted-foreground";
  wrapper.append(input, unit);
  return wrapper;
}

export function createField(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className =
    "grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground";
  const text = document.createElement("span");
  text.textContent = labelText;
  styleControl(input);
  label.append(
    text,
    input instanceof HTMLInputElement && input.dataset.unit ? createUnitControl(input) : input,
  );
  return label;
}

export function createStyleSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "grid gap-1 border-t border-border py-2";
  return section;
}

export function createUnitInput(unit: string, placeholder = "0"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.placeholder = placeholder;
  input.style.paddingRight = "30px";
  input.dataset.unit = unit;
  return input;
}
