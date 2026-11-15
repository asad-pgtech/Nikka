/**
 * Cosmetic due dates for the decoy task list. Never persisted: each task gets a random date the
 * first time it is shown in this page load, a date picked in the "add" form, or "today" when a
 * notification named it. Reloading the app re-rolls them.
 */

const DAY_MS = 86_400_000;
const MIN_DAYS = 1;
const MAX_DAYS = 14;

const assigned = new Map<string, string>(); // task id → YYYY-MM-DD (local)

export function todayIso(now = new Date()): string {
  return toIso(now);
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(fromIso(value).getTime());
}

/** The task's due date for this session; assigns a random future one on first request. */
export function dueDateFor(taskId: string, now = new Date()): string {
  let iso = assigned.get(taskId);
  if (!iso) {
    const days = MIN_DAYS + Math.floor(Math.random() * (MAX_DAYS - MIN_DAYS + 1));
    iso = toIso(new Date(now.getTime() + days * DAY_MS));
    assigned.set(taskId, iso);
  }
  return iso;
}

export function setDueDate(taskId: string, iso: string): void {
  if (isValidIsoDate(iso)) assigned.set(taskId, iso);
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

export function describeDue(iso: string, now = new Date()): { label: string; tone: DueTone } {
  const due = fromIso(iso);
  const today = fromIso(toIso(now));
  const diff = Math.round((due.getTime() - today.getTime()) / DAY_MS);
  if (diff < 0) return { label: diff === -1 ? 'Yesterday' : formatDate(due, today), tone: 'overdue' };
  if (diff === 0) return { label: 'Today', tone: 'today' };
  if (diff === 1) return { label: 'Tomorrow', tone: 'soon' };
  if (diff < 7) return { label: due.toLocaleDateString(undefined, { weekday: 'long' }), tone: 'soon' };
  return { label: formatDate(due, today), tone: 'later' };
}

function formatDate(d: Date, today: Date): string {
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Test hook. */
export function resetDueDates(): void {
  assigned.clear();
}
