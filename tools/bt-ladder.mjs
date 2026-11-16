#!/usr/bin/env node
// bt-ladder — print a battle.training bot's ladder standings as agent-readable text or JSON.
//
//   node tools/bt-ladder.mjs maya-vanguard
//   node tools/bt-ladder.mjs ibdall-hermes-vanguard --json
//   node tools/bt-ladder.mjs maya-vanguard --all-ladders
//
// Uses only the public read API (no account key):
//   GET https://api.battle.training/api/bots/<name>
//   GET https://api.battle.training/api/ladders
//
// It exists because the bot page shows a rating but not the qualification
// progress, win rate or health of the active version in one place. A coding
// agent tuning a controller needs those numbers after each batch of sets.
//
// No dependencies. Node 18+ (global fetch).

import { pathToFileURL } from 'node:url';

const API = 'https://api.battle.training';

export function usage() {
  return `bt-ladder — public ladder standings for a battle.training bot

Usage
  node tools/bt-ladder.mjs <bot-name> [options]

Options
  --json          print one JSON document instead of the text report
  --all-ladders   also list open ladders the bot has not enrolled in
  --api <url>     override the API base (for local tests)
  --help          show this help

Example
  node tools/bt-ladder.mjs maya-vanguard --all-ladders`;
}

export function parseArgs(argv) {
  const opts = { name: null, json: false, allLadders: false, api: API };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--json') opts.json = true;
    else if (a === '--all-ladders') opts.allLadders = true;
    else if (a === '--api') opts.api = String(argv[++i] || '').replace(/\/$/, '');
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!opts.name) opts.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.help && !opts.name) throw new Error('a bot name is required');
  return opts;
}

export function pct(wins, games) {
  return games > 0 ? ((wins / games) * 100).toFixed(1) + '%' : 'n/a';
}

export async function getJSON(api, path) {
  const r = await fetch(`${api}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'bt-ladder/1.0' },
  });
  if (!r.ok) throw new Error(`GET ${path} returned HTTP ${r.status}`);
  return r.json();
}

function qualify(ladderMeta, row) {
  const need = ladderMeta && ladderMeta.entry && ladderMeta.entry.min_sets_to_qualify;
  if (!Number.isFinite(need) || need <= 0) return null;
  return { need, done: row.games || 0, remaining: Math.max(0, need - (row.games || 0)) };
}

export function buildReport(bot, laddersPayload, allLadders) {
  const meta = new Map((laddersPayload.ladders || []).map((l) => [l.slug, l]));
  const active = (bot.versions || []).find((v) => v.active) || null;
  const rows = (bot.ladders || []).map((r) => {
    const m = meta.get(r.ladder);
    return {
      ladder: r.ladder,
      name: m ? m.name : r.ladder,
      rating: r.rating,
      rd: r.rd,
      score: r.score,
      games: r.games || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      draws: r.draws || 0,
      winRate: pct(r.wins || 0, r.games || 0),
      qualify: qualify(m, r),
      lastPlayed: r.last_played ? new Date(r.last_played).toISOString() : null,
    };
  });
  const enrolled = new Set(rows.map((r) => r.ladder));
  const missing = allLadders
    ? (laddersPayload.ladders || [])
        .filter((l) => l.status === 'open' && !enrolled.has(l.slug))
        .map((l) => ({ ladder: l.slug, name: l.name, enrolled: l.enrolled }))
    : [];
  return {
    bot: bot.name,
    handle: bot.handle,
    activeVersion: active ? active.label : null,
    health: active && active.health ? active.health : null,
    ladders: rows,
    notEnrolled: missing,
  };
}

export function formatText(rep) {
  const out = [];
  out.push(`bt-ladder · ${rep.bot} (handle ${rep.handle})`);
  if (rep.activeVersion) out.push(`active version ${rep.activeVersion}`);
  if (rep.health) {
    out.push(`health timeouts=${rep.health.timeouts ?? 0} exceptions=${rep.health.exceptions ?? 0} idle_ticks=${rep.health.idle_ticks ?? 0}`);
  }
  if (!rep.ladders.length) out.push('no ladder rows on the public bot record');
  for (const r of rep.ladders) {
    const q = r.qualify ? ` · qualify ${r.qualify.done}/${r.qualify.need} (${r.qualify.remaining} left)` : '';
    const last = r.lastPlayed ? ` · last ${r.lastPlayed}` : '';
    out.push(
      `${r.ladder} · ${r.name} · rating ${r.rating} ±${r.rd} · score ${r.score} · ` +
      `${r.games} games (${r.wins}W/${r.losses}L/${r.draws}D, ${r.winRate})${q}${last}`
    );
  }
  for (const m of rep.notEnrolled) {
    out.push(`open, not enrolled · ${m.ladder} · ${m.name} · ${m.enrolled} entrants`);
  }
  return out.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(usage()); return; }
  const [bot, ladders] = await Promise.all([
    getJSON(opts.api, `/api/bots/${encodeURIComponent(opts.name)}`),
    getJSON(opts.api, '/api/ladders'),
  ]);
  const rep = buildReport(bot, ladders, opts.allLadders);
  if (opts.json) console.log(JSON.stringify(rep, null, 2));
  else console.log(formatText(rep));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(`bt-ladder: ${e.message}`); process.exit(1); });
}
