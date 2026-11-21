export function button(name: string, scope: ParentNode = document) {
  const match = [...scope.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

export function input(placeholder: string) {
  const match = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!match) throw new Error(`No input with placeholder ${placeholder}`);
  return match;
}
