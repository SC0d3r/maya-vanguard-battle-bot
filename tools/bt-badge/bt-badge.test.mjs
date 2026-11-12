import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectStats, formatMessage, renderBadge } from "./bt-badge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "maya-vanguard.json"), "utf8"));

test("selects public ladder stats", () => {
  const stats = selectStats(fixture, "public");
  assert.equal(stats.bot, "maya-vanguard");
  assert.equal(stats.rating, 1150);
  assert.equal(stats.rank, 126);
  assert.equal(stats.of, 163);
  assert.equal(stats.sets, 11);
  assert.equal(stats.wins, 7);
  assert.equal(stats.losses, 3);
  assert.equal(stats.draws, 1);
});

test("selects a named cup ladder", () => {
  const stats = selectStats(fixture, "promotedby-cup-nov-2026");
  assert.equal(stats.ladder, "promotedby-cup-nov-2026");
  assert.equal(stats.rating, 1141);
  assert.equal(stats.sets, 23);
  assert.equal(stats.wins, 12);
  assert.equal(stats.losses, 10);
  assert.equal(stats.rank, null);
});

test("auto message shows rating and rank on the public ladder", () => {
  assert.equal(formatMessage(selectStats(fixture, "public"), "auto"), "1150 · #126");
});

test("auto message shows rating and sets on a cup ladder", () => {
  assert.equal(formatMessage(selectStats(fixture, "promotedby-cup-nov-2026"), "auto"), "1141 · 23 sets");
});

test("supports every metric", () => {
  const publicStats = selectStats(fixture, "public");
  assert.equal(formatMessage(publicStats, "rating"), "1150");
  assert.equal(formatMessage(publicStats, "rank"), "#126/163");
  assert.equal(formatMessage(publicStats, "record"), "7W 3L 1D");
  assert.equal(formatMessage(publicStats, "sets"), "11 sets");
});

test("unknown ladder fails clearly", () => {
  assert.throws(() => selectStats(fixture, "no-such-ladder"), /not on ladder/);
});

test("renders a self-contained SVG and escapes XML", () => {
  const svg = renderBadge({ label: "a&b", message: "1150 · #126", color: "#2ea44f" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes("a&amp;b"));
  assert.ok(svg.includes("1150 · #126"));
  assert.ok(svg.includes('fill="#2ea44f"'));
  assert.ok(svg.trimEnd().endsWith("</svg>"));
});

test("rejects a non-hex color instead of injecting markup", () => {
  const svg = renderBadge({ label: "battle.training", message: "1150", color: '"><script>alert(1)</script>' });
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes('fill="#2ea44f"'));
});
