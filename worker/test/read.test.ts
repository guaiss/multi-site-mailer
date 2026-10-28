import { describe, expect, it } from "vitest";
import { parseTime } from "../src/read/api";

describe("parseTime", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  it.each([
    ["24h", now / 1000 - 86400],
    ["90m", now / 1000 - 5400],
    ["7d", now / 1000 - 7 * 86400],
    ["1792656000", 1792656000],
    ["2026-10-21T00:00:00Z", Date.parse("2026-10-21T00:00:00Z") / 1000],
  ])("%s", (v, want) => expect(parseTime(v, now)).toBe(want));
  it("rejects garbage", () => expect(parseTime("yesterday", now)).toBeNull());
  it("returns null when absent", () => expect(parseTime(undefined, now)).toBeNull());
});
