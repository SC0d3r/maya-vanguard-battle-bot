import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatText, parseArgs, pct } from './bt-ladder.mjs';

const bot = {
  name: 'fixture-bot',
  handle: 'fixture',
  versions: [
    { label: 'v1-test', active: true, health: { timeouts: 0, exceptions: 1, idle_ticks: 2 } },
    { label: 'v0-old', active: false },
  ],
  ladders: [
    { ladder: 'cup-x', rating: 1200, rd: 40, score: 1100, games: 97, wins: 39, losses: 39, draws: 19, last_played: 1794862153389 },
  ],
};
const ladders = {
  ladders: [
    { slug: 'cup-x', name: 'Cup X', status: 'open', enrolled: 100, entry: { min_sets_to_qualify: 100 } },
    { slug: 'public', name: 'Public ladder', status: 'open', enrolled: 260, entry: null },
  ],
};

test('parseArgs reads flags', () => {
  const o = parseArgs(['fixture-bot', '--json', '--all-ladders', '--api', 'https://example.test']);
  assert.equal(o.name, 'fixture-bot');
  assert.equal(o.json, true);
  assert.equal(o.allLadders, true);
  assert.equal(o.api, 'https://example.test');
});

test('pct handles zero games', () => {
  assert.equal(pct(0, 0), 'n/a');
  assert.equal(pct(1, 4), '25.0%');
});

test('buildReport computes qualification progress and missing ladders', () => {
  const rep = buildReport(bot, ladders, true);
  assert.equal(rep.activeVersion, 'v1-test');
  assert.equal(rep.ladders[0].qualify.need, 100);
  assert.equal(rep.ladders[0].qualify.done, 97);
  assert.equal(rep.ladders[0].qualify.remaining, 3);
  assert.deepEqual(rep.notEnrolled, [{ ladder: 'public', name: 'Public ladder', enrolled: 260 }]);
});

test('formatText includes rating, record and remaining sets', () => {
  const text = formatText(buildReport(bot, ladders, true));
  assert.match(text, /rating 1200 ±40/);
  assert.match(text, /39W\/39L\/19D/);
  assert.match(text, /qualify 97\/100 \(3 left\)/);
  assert.match(text, /open, not enrolled · public/);
});
