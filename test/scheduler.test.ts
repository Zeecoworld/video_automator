import { describe, expect, it } from "vitest";
import { assignSlots, slotsForDay, zonedToUtc } from "../src/scheduler";

const TZ = "Africa/Lagos"; // UTC+1, no DST

describe("scheduler", () => {
  it("converts zoned wall time to UTC", () => {
    expect(zonedToUtc(2026, 11, 1, 8, 0, TZ).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(zonedToUtc(2026, 7, 1, 12, 0, "America/New_York").toISOString()).toBe("2026-07-01T16:00:00.000Z"); // DST
  });

  it("spreads slots evenly, centred in each sub-window", () => {
    const s = slotsForDay(2026, 11, 1, 5, "08:00", "22:00", TZ);
    expect(s).toHaveLength(5);
    expect(s[0].toISOString()).toBe("2026-11-01T08:24:00.000Z"); // 09:24 Lagos
    expect(s[4].toISOString()).toBe("2026-11-01T19:36:00.000Z"); // 20:36 Lagos
  });

  it("rolls into the next day and never collides", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    const first = assignSlots([], 5, now, 5, "08:00", "22:00", TZ);
    const more = assignSlots(first, 3, now, 5, "08:00", "22:00", TZ);
    const all = [...first, ...more].map((d) => d.getTime());
    expect(new Set(all).size).toBe(8);
    expect(all.every((t) => t > now.getTime())).toBe(true);
    expect(Math.max(...first.map((d) => d.getTime()))).toBeLessThan(Math.min(...more.map((d) => d.getTime())));
  });

  it("respects the minimum lead time", () => {
    const first = slotsForDay(2026, 10, 31, 10, "08:00", "22:00", TZ)[0];
    const now = new Date(first.getTime() - 5 * 60_000);
    expect(assignSlots([], 1, now, 10, "08:00", "22:00", TZ)[0].getTime()).toBeGreaterThan(first.getTime());
  });
});
