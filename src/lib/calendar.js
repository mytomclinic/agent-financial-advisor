// US equity market calendar (NYSE). Holidays are maintained by hand; the
// weekly ops routine checks for the next year's published schedule.

export const NYSE_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export const NYSE_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

export const toIsoDate = (d) => d.toISOString().slice(0, 10);

export function parseDate(s) {
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIsoDate(d);
}

export function isTradingDay(iso) {
  const dow = parseDate(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(iso);
}

export function addBusinessDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isTradingDay(d)) left -= 1;
  }
  return d;
}

// Wall-clock time in New York for an instant, without a tz library.
export function newYorkParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

// "regular" | "pre_market" | "after_hours" | "closed"
export function sessionAt(date) {
  const { date: iso, minutes } = newYorkParts(date);
  if (!isTradingDay(iso)) return { session: "closed", ny_date: iso, reason: "weekend or exchange holiday" };
  const close = NYSE_EARLY_CLOSES.has(iso) ? 13 * 60 : 16 * 60;
  if (minutes >= 9 * 60 + 30 && minutes < close) return { session: "regular", ny_date: iso };
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return { session: "pre_market", ny_date: iso };
  if (minutes >= close && minutes < 20 * 60) return { session: "after_hours", ny_date: iso };
  return { session: "closed", ny_date: iso, reason: "outside extended hours" };
}
