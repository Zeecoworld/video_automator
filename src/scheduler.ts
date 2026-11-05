function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

function offsetMs(date: Date, tz: string): number {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` -> UTC instant (handles DST). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

const hm = (s: string): [number, number] => {
  const [h, m] = s.split(":").map(Number);
  return [h, m];
};

export function slotsForDay(y: number, mo: number, d: number, perDay: number, start: string, end: string, tz: string): Date[] {
  const [sh, sm] = hm(start);
  const [eh, em] = hm(end);
  const a = zonedToUtc(y, mo, d, sh, sm, tz).getTime();
  const b = zonedToUtc(y, mo, d, eh, em, tz).getTime();
  const span = (b - a) / perDay;
  return Array.from({ length: perDay }, (_, i) => new Date(Math.floor((a + span * i + span / 2) / 60_000) * 60_000));
}

/** Return `count` future slots that are not already taken. */
export function assignSlots(
  existing: Date[], count: number, now: Date, perDay: number,
  start: string, end: string, tz: string, minLeadMs = 10 * 60_000, maxDays = 90,
): Date[] {
  const taken = new Set(existing.map((d) => Math.floor(d.getTime() / 60_000)));
  const out: Date[] = [];
  const p = parts(now, tz);
  let cursor = Date.UTC(p.year, p.month - 1, p.day);
  for (let i = 0; i < maxDays; i++, cursor += 86_400_000) {
    const day = new Date(cursor);
    for (const slot of slotsForDay(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), perDay, start, end, tz)) {
      if (slot.getTime() > now.getTime() + minLeadMs && !taken.has(Math.floor(slot.getTime() / 60_000))) {
        out.push(slot);
        if (out.length === count) return out;
      }
    }
  }
  throw new Error("could not find enough free posting slots");
}
