// Test date helpers.
//
// Several purchasing/supplier suites used to hardcode calendar dates (2026-08-16
// and friends). Those dates were "recent past" on the day they were written, but
// the code under test validates against the real clock in Asia/Kathmandu — it
// rejects future payment/statement dates and windows reports by day. Once the
// wall clock caught up, the fixtures started asserting things like "today is in
// the future", and the suites failed for reasons unrelated to the behaviour they
// cover.
//
// Everything here is derived from the current Kathmandu day instead, so the
// suites keep testing the same relationships (payment before invoice, statement
// as-of before a reversal, a report window that contains today's activity) no
// matter when they run.

const DAY_MS = 24 * 60 * 60 * 1000;
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;

/** Today's date in Asia/Kathmandu as YYYY-MM-DD — the same day the API considers "today". */
export function today(now = new Date()) {
  return new Date(now.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10);
}

/** Kathmandu date shifted by whole days. Negative is in the past. */
export function daysFromToday(offset, now = new Date()) {
  return new Date(now.getTime() + KATHMANDU_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

export const daysAgo = (n, now = new Date()) => daysFromToday(-Math.abs(n), now);
export const daysAhead = (n, now = new Date()) => daysFromToday(Math.abs(n), now);

/** Midnight UTC on a relative day, for seeding Mongo date fields directly. */
export function dateFromToday(offset, now = new Date()) {
  return new Date(`${daysFromToday(offset, now)}T00:00:00.000Z`);
}

/**
 * A stable anchor set for the supplier/purchasing suites.
 *
 * `tomorrow` is the only future value and exists purely to assert that future
 * dates are rejected; every other anchor is today or earlier so it is always a
 * legal input.
 */
export const anchors = (now = new Date()) => ({
  tomorrow: daysAhead(1, now),
  today: today(now),
  yesterday: daysAgo(1, now),
  twoDaysAgo: daysAgo(2, now),
  threeDaysAgo: daysAgo(3, now),
  fiveDaysAgo: daysAgo(5, now),
  weekAgo: daysAgo(7, now),
  twoWeeksAgo: daysAgo(14, now),
  monthAgo: daysAgo(30, now),
  twoMonthsAgo: daysAgo(60, now),
  quarterAgo: daysAgo(90, now)
});
