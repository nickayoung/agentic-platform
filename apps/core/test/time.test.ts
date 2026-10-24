import { describe, expect, it } from 'vitest';
import { addDays, durationMs, fromLocal, toLocal, weekStartOf, weekdayOf } from '../src/time';

const NY = 'America/New_York';

describe('local time (§7.10)', () => {
  it('converts both ways in winter and summer', () => {
    const w = fromLocal('2027-03-08', '06:15', NY);
    expect(new Date(w).toISOString()).toBe('2027-03-08T11:15:00.000Z');
    expect(toLocal(w, NY)).toMatchObject({ date: '2027-03-08', time: '06:15', weekday: 'mon' });
    const s = fromLocal('2027-03-15', '06:15', NY);
    expect(new Date(s).toISOString()).toBe('2027-03-15T10:15:00.000Z');
  });

  it('keeps local wall time across the spring-forward and fall-back days', () => {
    // 2027-03-14 02:00 → 03:00: 02:30 does not exist and moves forward
    expect(toLocal(fromLocal('2027-03-14', '02:30', NY), NY).time).toBe('03:30');
    expect(toLocal(fromLocal('2027-03-14', '07:30', NY), NY).time).toBe('07:30');
    // 2027-11-07 02:00 → 01:00: 01:30 happens twice; the earlier one is used
    const t = fromLocal('2027-11-07', '01:30', NY);
    expect(new Date(t).toISOString()).toBe('2027-11-07T05:30:00.000Z');
    expect(toLocal(fromLocal('2027-11-07', '07:30', NY), NY).time).toBe('07:30');
  });

  it('weeks, weekdays and durations', () => {
    expect(weekdayOf('2027-03-14')).toBe('sun');
    expect(weekStartOf('2027-03-14')).toBe('2027-03-08');
    expect(weekStartOf('2027-03-08')).toBe('2027-03-08');
    expect(addDays('2027-02-27', 2)).toBe('2027-03-01');
    expect(durationMs('6h30m')).toBe(6.5 * 3_600_000);
    expect(() => durationMs('6x')).toThrow();
  });
});
