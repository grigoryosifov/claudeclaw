import { describe, expect, test } from "bun:test";
import { cronMatches, nextCronMatch } from "../cron";

describe("cronMatches", () => {
  test("matches an exact weekly slot", () => {
    // Friday 2026-07-17 12:30 UTC
    expect(cronMatches("30 12 * * 5", new Date(Date.UTC(2026, 6, 17, 12, 30)))).toBe(true);
    expect(cronMatches("30 12 * * 5", new Date(Date.UTC(2026, 6, 17, 12, 31)))).toBe(false);
    expect(cronMatches("30 12 * * 5", new Date(Date.UTC(2026, 6, 16, 12, 30)))).toBe(false);
  });

  test("applies the timezone offset", () => {
    // 12:30 in UTC+3 (Sofia summer) is 09:30 UTC
    expect(cronMatches("30 12 * * 5", new Date(Date.UTC(2026, 6, 17, 9, 30)), 180)).toBe(true);
    expect(cronMatches("30 12 * * 5", new Date(Date.UTC(2026, 6, 17, 12, 30)), 180)).toBe(false);
  });
});

describe("nextCronMatch", () => {
  test("finds a weekly slot more than 48h away (Friday cron queried on a Monday)", () => {
    // Regression: the 48h scan cap returned "after + 48h" for any weekly cron seen
    // early in the week, producing a bogus nextAt (observed 2026-07-14: a Friday
    // 12:30 UTC job showed next fire Wednesday 21:14 UTC).
    const after = new Date(Date.UTC(2026, 6, 13, 21, 14)); // Monday 21:14 UTC
    const next = nextCronMatch("30 12 * * 5", after);
    expect(next.toISOString()).toBe("2026-07-17T12:30:00.000Z"); // Friday
  });

  test("finds a slot within the next hour", () => {
    const after = new Date(Date.UTC(2026, 6, 13, 12, 0));
    const next = nextCronMatch("30 12 * * *", after);
    expect(next.toISOString()).toBe("2026-07-13T12:30:00.000Z");
  });

  test("does not return the current minute (starts strictly after)", () => {
    const after = new Date(Date.UTC(2026, 6, 13, 12, 30));
    const next = nextCronMatch("30 12 * * *", after);
    expect(next.toISOString()).toBe("2026-07-14T12:30:00.000Z");
  });

  test("respects the timezone offset", () => {
    // Next "30 12" in UTC+3 after Monday 08:00 UTC is 09:30 UTC the same day
    const after = new Date(Date.UTC(2026, 6, 13, 8, 0));
    const next = nextCronMatch("30 12 * * *", after, 180);
    expect(next.toISOString()).toBe("2026-07-13T09:30:00.000Z");
  });
});
