import { beforeEach, describe, expect, it } from 'vitest';
import { describeDue, dueDateFor, isValidIsoDate, resetDueDates, setDueDate, todayIso } from './dueDates';

const NOW = new Date(2026, 10, 15, 10, 0, 0); // 15 Nov 2026 (Sunday)

describe('cosmetic due dates', () => {
  beforeEach(resetDueDates);

  it('assigns a random future date once and keeps it for the session', () => {
    const first = dueDateFor('seed-0', NOW);
    expect(isValidIsoDate(first)).toBe(true);
    expect(first > todayIso(NOW)).toBe(true);
    expect(dueDateFor('seed-0', NOW)).toBe(first);
  });

  it('uses a date picked in the form', () => {
    setDueDate('t1', '2026-12-01');
    expect(dueDateFor('t1', NOW)).toBe('2026-12-01');
    setDueDate('t1', 'not-a-date');
    expect(dueDateFor('t1', NOW)).toBe('2026-12-01');
  });

  it('labels relative dates', () => {
    expect(describeDue('2026-11-15', NOW)).toEqual({ label: 'Today', tone: 'today' });
    expect(describeDue('2026-11-16', NOW)).toEqual({ label: 'Tomorrow', tone: 'soon' });
    expect(describeDue('2026-11-14', NOW)).toEqual({ label: 'Yesterday', tone: 'overdue' });
    expect(describeDue('2026-12-20', NOW).tone).toBe('later');
  });
});
