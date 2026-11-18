import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@goat/contracts/settings";

/**
 * Saving a shorter age settles threads at once, so typing stays in `draft` until the edit is
 * finished. `pending` is the submission in flight; `saved` is the only value a draft falls back to.
 */
export interface AutoSettleDaysField {
  readonly saved: number;
  readonly draft: string;
  readonly dirty: boolean;
  readonly pending: number | null;
  readonly revision: number;
}

export function autoSettleDaysField(saved: number): AutoSettleDaysField {
  return { saved, draft: String(saved), dirty: false, pending: null, revision: 0 };
}

export function syncAutoSettleDaysField(
  field: AutoSettleDaysField,
  saved: number,
): AutoSettleDaysField {
  // An earlier save can be confirmed while a later one is still in flight.
  const pending = field.pending === saved ? null : field.pending;
  if (field.saved === saved && pending === field.pending) return field;
  return {
    ...field,
    saved,
    pending,
    draft: field.dirty ? field.draft : String(pending ?? saved),
  };
}

export function editAutoSettleDaysField(
  field: AutoSettleDaysField,
  draft: string,
): AutoSettleDaysField {
  return { ...field, draft, dirty: true };
}

export function cancelAutoSettleDaysField(field: AutoSettleDaysField): AutoSettleDaysField {
  return { ...field, draft: String(field.pending ?? field.saved), dirty: false };
}

export function commitAutoSettleDaysField(field: AutoSettleDaysField): {
  readonly field: AutoSettleDaysField;
  readonly submit: number | null;
} {
  const current = field.pending ?? field.saved;
  const days = field.draft.trim() === "" ? Number.NaN : Number(field.draft);
  if (
    !Number.isInteger(days) ||
    days < MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS ||
    days > MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
  ) {
    return { field: { ...field, draft: String(current), dirty: false }, submit: null };
  }
  const settled = { ...field, draft: String(days), dirty: false };
  // An edit ending on the saved value is sent again: a save can land on the shown environment
  // and fail on another, and retyping the number is how it is retried.
  if (!field.dirty || days === field.pending) return { field: settled, submit: null };
  return { field: { ...settled, pending: days, revision: field.revision + 1 }, submit: days };
}

export function failAutoSettleDaysField(
  field: AutoSettleDaysField,
  revision: number,
): AutoSettleDaysField {
  if (field.revision !== revision) return field;
  return { ...field, pending: null, draft: field.dirty ? field.draft : String(field.saved) };
}
