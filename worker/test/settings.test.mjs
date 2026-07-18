import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  nextTaskAt,
  normalizeSettings,
  scheduleSummaries,
  taskDue,
  taskSlot,
} from "../src/settings.mjs";

test("normalizes automation settings and enforces the fixed quota conversion", () => {
  const settings = normalizeSettings({
    quota_per_cny: 123,
    draw: { every_minutes: 120, draw_count: 2, anchor_local: "00:20" },
    ad: { daily_limit: 9 },
  });
  assert.equal(settings.quota_per_cny, 500000);
  assert.equal(settings.draw.every_minutes, 120);
  assert.equal(settings.draw.draw_count, 2);
  assert.equal(settings.ad.daily_limit, 3);
});

test("uses staggered Beijing defaults", () => {
  assert.equal(DEFAULT_SETTINGS.checkin.daily_at, "00:10");
  assert.equal(DEFAULT_SETTINGS.quiz.daily_at, "00:15");
  assert.equal(DEFAULT_SETTINGS.draw.anchor_local, "00:20");
  assert.equal(DEFAULT_SETTINGS.ad.anchor_local, "01:00");
});

test("detects due interval tasks using Beijing time", () => {
  const at0020 = new Date("2026-07-17T16:20:00Z");
  const at0220 = new Date("2026-07-17T18:20:00Z");
  const at0221 = new Date("2026-07-17T18:21:00Z");
  assert.equal(taskDue(DEFAULT_SETTINGS, "draw", at0020), true);
  assert.equal(taskDue(DEFAULT_SETTINGS, "draw", at0220), true);
  assert.equal(taskDue(DEFAULT_SETTINGS, "draw", at0221), false);
  assert.equal(taskSlot(DEFAULT_SETTINGS, "draw", at0220), "draw:2026-07-18T0220");
});

test("computes the next scheduled execution", () => {
  const now = new Date("2026-07-17T16:16:00Z");
  assert.equal(nextTaskAt(DEFAULT_SETTINGS, "draw", now), "2026-07-17T16:20:00.000Z");
  assert.equal(nextTaskAt(DEFAULT_SETTINGS, "quiz", now), "2026-07-18T16:15:00.000Z");
  const schedules = scheduleSummaries(DEFAULT_SETTINGS, now);
  assert.equal(schedules.length, 4);
  assert.equal(schedules.find((item) => item.key === "draw").enabled, true);
});
