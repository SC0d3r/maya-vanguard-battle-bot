#!/usr/bin/env node
// bt-replay — turn a battle.training replay into agent-readable telemetry.
//
//   node bt-replay.mjs m_85036d467617 --game 1
//   node bt-replay.mjs replay.jsonl --json --maps 0,600,last
//   node bt-replay.mjs m_85036d467617 --maps 1000,3000 --no-verify
//
// Replays are public: GET https://api.battle.training/api/replays/<match>.jsonl?game=<n>.
// The script loads the arena's own engine (arena-sim.mjs) to decode the replay and check
// its hash chain, then prints a summary, objective/score timeline, per-unit telemetry and
// ASCII map snapshots. It answers the question a coding agent actually has after a ranked
// set: "where did my units go, and what did they do?"
//
// No dependencies. Node 18+ (uses fetch). The engine is cached at ~/.cache/bt-replay/.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FP = 65536;
const API = "https://api.battle.training";
const SDK_URL = `${API}/sdk/arena-sim.mjs`;
const TERRAIN_CHAR = { 0: ".", 1: "f", 2: "~", 3: "=", 4: "#", 5: "-", 6: "%", 7: "H" };
const KIND_CHAR = { scout: "S", mbt: "T", artillery: "R", drone: "D", missile: "M", engineer: "E", apc: "P" };
const SIDE_NAME = ["A", "B"];

// ---------------------------------------------------------------------------- args

function usage() {
  console.log(`bt-replay — agent-readable telemetry for battle.training replays

Usage
  node bt-replay.mjs <match-id | replay.jsonl> [options]

Options
  --game <n>       game number inside a ranked set (default 1)
  --json           print one JSON document instead of the text report
  --maps <ticks>   ASCII map snapshots: comma separated ticks, "last", or "auto"
                   (default: last)
  --sdk <path>     use this arena-sim.mjs instead of the cached download
  --no-verify      skip the hash-chain verification (faster on large replays)
  --help           show this help

Examples
  node bt-replay.mjs m_85036d467617 --game 1
  node bt-replay.mjs m_85036d467617 --maps 0,1200,last
  node bt-replay.mjs replays/m_85036d467617.jsonl --json > report.json`);
}

function parseArgs(argv) {
  const opts = { game: 1, json: false, maps: "last", sdk: null, verify: true, source: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--json") opts.json = true;
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--game") opts.game = Number(argv[++i]);
    else if (a === "--maps") opts.maps = argv[++i];
    else if (a === "--sdk") opts.sdk = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (!opts.source) opts.source = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.source) { usage(); process.exit(2); }
  if (!Number.isFinite(opts.game) || opts.game < 1) throw new Error("--game must be a positive number");
  return opts;
}

// ---------------------------------------------------------------------------- load

// fetch() ignores HTTPS_PROXY. Agent sandboxes often only reach the network through a
// proxy, so tunnel through it when one is configured, and fall back to fetch otherwise.
function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

function fetchText(url) {
  const proxy = proxyUrl();
  if (!proxy) {
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
      return res.text();
    });
  }
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const p = new URL(proxy);
    const connect = http.request({
      hostname: p.hostname,
      port: p.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
    });
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error(`proxy CONNECT failed (${res.statusCode})`)); return; }
      const req = https.request(
        { hostname: target.hostname, path: target.pathname + target.search, socket, agent: false, headers: { host: target.hostname } },
        (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            if (r.statusCode < 200 || r.statusCode >= 300) reject(new Error(`${url} -> ${r.statusCode} ${r.statusMessage}`));
            else resolve(Buffer.concat(chunks).toString("utf8"));
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
    connect.on("error", reject);
    connect.end();
  });
}

async function loadSdk(explicit) {
  const cache = path.join(os.homedir(), ".cache", "bt-replay", "arena-sim.mjs");
  const candidates = [explicit, process.env.BT_SDK, cache].filter(Boolean);
  let sdkPath = candidates.find((p) => fs.existsSync(p));
  if (!sdkPath) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, await fetchText(SDK_URL));
    sdkPath = cache;
  }
  const sdk = await import(pathToFileURL(sdkPath).href);
  for (const fn of ["decodeReplay", "verifyReplay", "rulesFor", "Match"]) {
    if (typeof sdk[fn] !== "function") throw new Error(`${sdkPath} does not look like arena-sim.mjs (missing ${fn})`);
  }
  return { sdk, sdkPath };
}

async function loadReplay(source, game) {
  if (/^m_[0-9a-z]+$/i.test(source)) {
    const url = `${API}/api/replays/${source}.jsonl?game=${game}`;
    return { text: await fetchText(url), origin: url };
  }
  return { text: fs.readFileSync(source, "utf8"), origin: path.resolve(source) };
}

// ---------------------------------------------------------------------------- analysis

function tile(v) { return Math.floor(v / FP); }

function rebuildMap(sdk, header, rules) {
  const m = new sdk.Match(header.seed, { rules });
  if (m.needsDraft) {
    if (header.drafts && header.drafts.length >= 2) {
      m.draft(0, header.drafts[0]);
      m.draft(1, header.drafts[1]);
    }
    m.start();
  }
  return { map: m.map, objectives: m.state.objectives };
}

function analyse(sdk, replay, opts) {
  const header = replay.header;
  const result = replay.result || {};
  const rules = sdk.rulesFor(header.rulesVersion);
  let states = null;
  let verification = { ok: false, reason: "not run", firstMismatch: null };
  if (opts.verify) {
    const v = sdk.verifyReplay(replay, { rules });
    states = v.states;
    verification = { ok: v.ok, reason: v.reason, firstMismatch: v.firstMismatch };
  }

  const { map, objectives: objectiveMeta } = rebuildMap(sdk, header, rules);

  // Unit ids are stable for the whole match; collect kind/side from the first state.
  const unitMeta = new Map();
  const first = states ? states[0] : null;
  if (first) {
    for (const u of first.units) unitMeta.set(u.id, { id: u.id, side: u.side, kind: u.kind });
  }

  const stats = new Map();
  for (const meta of unitMeta.values()) {
    stats.set(meta.id, {
      ...meta,
      hpStart: null,
      hpEnd: null,
      damageDealt: 0,
      damageTaken: 0,
      kills: 0,
      shots: 0,
      distance: 0,
      objectiveTicks: 0,
      aliveTicks: 0,
      aliveAtEnd: false,
    });
  }

  const shellOwner = new Map();
  const objectiveChanges = [];
  const destructions = [];
  const ends = [];
  const timeline = [];

  const sampleEvery = states && states.length > 600 ? 250 : 50;

  if (states) {
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      const prev = i > 0 ? states[i - 1] : null;

      // per-unit movement and objective presence
      for (const u of s.units) {
        const st = stats.get(u.id);
        if (!st) continue;
        if (st.hpStart === null) st.hpStart = u.hp;
        st.hpEnd = u.hp;
        if (!u.alive) continue;
        st.aliveTicks += 1;
        if (prev) {
          const p = prev.units.find((x) => x.id === u.id);
          if (p && p.alive) st.distance += Math.hypot(u.x - p.x, u.y - p.y) / FP;
        }
        for (const o of s.objectives) {
          if (Math.hypot(u.x - o.x, u.y - o.y) <= o.radius) { st.objectiveTicks += 1; break; }
        }
      }

      for (const e of s.events || []) {
        switch (e.kind) {
          case "fire":
            shellOwner.set(e.shell, e.unit);
            if (stats.has(e.unit)) stats.get(e.unit).shots += 1;
            break;
          case "hit": {
            const shooter = shellOwner.get(e.shell);
            if (shooter !== undefined) {
              if (stats.has(shooter)) stats.get(shooter).damageDealt += e.damage;
              if (stats.has(e.unit)) stats.get(e.unit).damageTaken += e.damage;
            } else if (stats.has(e.unit)) {
              stats.get(e.unit).damageTaken += e.damage;
            }
            break;
          }
          case "destroyed":
            if (stats.has(e.by)) stats.get(e.by).kills += 1;
            destructions.push({ t: s.tick, unit: e.unit, by: e.by, side: stats.get(e.unit)?.side ?? null });
            break;
          case "hill":
            objectiveChanges.push({ t: s.tick, objective: e.objective, side: e.side, state: e.state });
            break;
          case "end":
            ends.push({ t: s.tick, winner: e.winner, reason: e.reason });
            break;
        }
      }

      if (i === 0 || i === states.length - 1 || i % sampleEvery === 0) {
        timeline.push({
          t: s.tick,
          score: s.score.slice(),
          owners: s.objectives.map((o) => o.owner),
          states: s.objectives.map((o) => o.state),
        });
      }
    }
    for (const st of stats.values()) st.aliveAtEnd = st.hpEnd > 0;
  }

  // objective metadata comes from the reconstructed map, which is independent of --no-verify
  const objectives = objectiveMeta.map((o, i) => ({
    index: i,
    x: o.x / FP,
    y: o.y / FP,
    radius: o.radius / FP,
    weight: o.weight,
    changes: objectiveChanges.filter((c) => c.objective === i),
  }));

  // final state for the report
  let finalState = null;
  if (states) finalState = states[states.length - 1];
  else finalState = map.state;

  const units = [...stats.values()].sort((a, b) => a.side - b.side || a.id - b.id);
  const sides = [0, 1].map((side) => {
    const us = units.filter((u) => u.side === side);
    return {
      side,
      bots: header.bots ? header.bots[side] : null,
      draft: header.drafts ? header.drafts[side] : null,
      damageDealt: us.reduce((n, u) => n + u.damageDealt, 0),
      damageTaken: us.reduce((n, u) => n + u.damageTaken, 0),
      kills: us.reduce((n, u) => n + u.kills, 0),
      shots: us.reduce((n, u) => n + u.shots, 0),
      alive: us.filter((u) => u.aliveAtEnd).length,
    };
  });

  return {
    source: opts.origin,
    header,
    rulesVersion: header.rulesVersion,
    verification,
    result,
    seed: header.seed,
    bots: header.bots || null,
    drafts: header.drafts || null,
    sides,
    objectives,
    timeline,
    units,
    objectiveChanges,
    destructions,
    finalState,
    map,
    rules,
  };
}

// ---------------------------------------------------------------------------- drawing

function asciiMap(state, map, scale = 2) {
  const W = map.width;
  const H = map.height;
  const cols = Math.floor(W / scale);
  const rows = Math.floor(H / scale);
  const grid = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const t = map.terrain[(y * scale) * W + x * scale];
      row.push(TERRAIN_CHAR[t] ?? "?");
    }
    grid.push(row);
  }
  const put = (tx, ty, ch) => {
    const x = Math.floor(tx / scale);
    const y = Math.floor(ty / scale);
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = ch;
  };
  for (const o of state.objectives) {
    const ch = o.state === "contested" ? "x" : o.owner === 0 ? "0" : o.owner === 1 ? "1" : "O";
    put(tile(o.x), tile(o.y), ch);
  }
  for (const u of state.units) {
    if (!u.alive) continue;
    const ch = KIND_CHAR[u.kind] ?? "?";
    put(tile(u.x), tile(u.y), u.side === 0 ? ch : ch.toLowerCase());
  }
  return {
    width: cols,
    height: rows,
    lines: grid.map((row) => row.join("")),
  };
}

function fmtClock(ticks) {
  // The arena runs 20 ticks per second.
  const s = ticks / 20;
  return `${ticks}t (${s.toFixed(1)}s)`;
}

function report(a, opts) {
  const out = [];
  const bots = a.bots || [];
  const sideLabel = (i) => (bots[i] ? `${bots[i].name} (${bots[i].version})` : `side ${SIDE_NAME[i]}`);

  out.push(`bt-replay · ${sideLabel(0)} vs ${sideLabel(1)}`);
  out.push(
    `seed ${a.seed} · rules ${a.rulesVersion} · ` +
      `draft A ${a.drafts?.[0]?.join("/") ?? "-"} · draft B ${a.drafts?.[1]?.join("/") ?? "-"}`
  );
  const v = a.verification;
  out.push(
    `verified ${v.ok ? "ok" : `FAILED (${v.reason}${v.firstMismatch !== null ? ` at t=${v.firstMismatch}` : ""})`}`
  );
  const r = a.result;
  const winner = r.winner === null || r.winner === undefined ? "draw" : `side ${SIDE_NAME[r.winner]}`;
  out.push(
    `result ${winner} by ${r.reason ?? "?"} at ${fmtClock(r.ticks ?? 0)} · score A ${r.score?.[0]} : ${r.score?.[1]} B`
  );
  out.push("");

  out.push(`objectives (${a.objectives.length})`);
  for (const o of a.objectives) {
    const changes = o.changes.length
      ? o.changes.map((c) => `${c.side === null ? "neutral" : SIDE_NAME[c.side]}@t=${c.t}`).join(" → ")
      : "never captured";
    out.push(`  #${o.index} weight ${o.weight} at (${o.x.toFixed(0)},${o.y.toFixed(0)}) r${o.radius.toFixed(0)}: ${changes}`);
  }
  out.push("");

  out.push("score and ownership");
  out.push(`  ${"t".padEnd(6)} ${"score A:B".padEnd(14)} owners`);
  for (const s of a.timeline) {
    const owners = s.owners.map((o, i) => (s.states[i] === "contested" ? "x" : o === null ? "-" : SIDE_NAME[o])).join(" ");
    out.push(`  ${String(s.t).padEnd(6)} ${`${s.score[0]}:${s.score[1]}`.padEnd(14)} ${owners}`);
  }
  out.push("");

  out.push("units");
  out.push(`  ${"side".padEnd(4)} ${"unit".padEnd(11)} ${"dmg".padStart(5)} ${"taken".padStart(6)} ${"kills".padStart(5)} ${"shots".padStart(5)} ${"dist".padStart(7)} ${"obj ticks".padStart(9)} hp`);
  for (const u of a.units) {
    out.push(
      `  ${SIDE_NAME[u.side].padEnd(4)} ${`${u.kind}#${u.id}`.padEnd(11)} ${String(u.damageDealt).padStart(5)} ` +
        `${String(u.damageTaken).padStart(6)} ${String(u.kills).padStart(5)} ${String(u.shots).padStart(5)} ` +
        `${u.distance.toFixed(1).padStart(7)} ${String(u.objectiveTicks).padStart(9)} ${u.hpEnd}/${u.hpStart ?? "?"}${u.aliveAtEnd ? "" : " lost"}`
    );
  }
  for (const s of a.sides) {
    out.push(
      `  ${SIDE_NAME[s.side]} totals: dmg ${s.damageDealt}, taken ${s.damageTaken}, kills ${s.kills}, ` +
        `shots ${s.shots}, ${s.alive} unit(s) alive`
    );
  }
  out.push("");

  if (a.objectiveChanges.length) {
    out.push("objective changes");
    for (const c of a.objectiveChanges) {
      out.push(`  t=${c.t} objective ${c.objective} ${c.state} by ${c.side === null ? "neutral" : SIDE_NAME[c.side]}`);
    }
    out.push("");
  }

  if (a.destructions.length) {
    out.push("destructions");
    for (const d of a.destructions) {
      const victim = a.statsById?.get(d.unit);
      const killer = a.statsById?.get(d.by);
      const vk = victim ? `${SIDE_NAME[victim.side]} ${victim.kind}#${d.unit}` : `unit#${d.unit}`;
      const kk = killer ? `${SIDE_NAME[killer.side]} ${killer.kind}#${d.by}` : "environment";
      out.push(`  t=${d.t} ${vk} destroyed by ${kk}`);
    }
    out.push("");
  }

  // maps
  const specs = mapSpecs(opts.maps, a);
  if (specs.length) {
    const scale = a.map.width > 96 ? 2 : 1;
    for (const spec of specs) {
      const t = spec === "last" ? a.finalState.tick : Number(spec);
      const state = findState(a, t);
      if (!state) { out.push(`(no state at t=${t})`); continue; }
      const m = asciiMap(state, a.map, scale);
      out.push(`map t=${state.tick}  (${m.width}x${m.height}, ${scale} tile(s)/char)`);
      out.push(m.lines.map((l) => `  ${l}`).join("\n"));
      out.push(`  legend: T/S/P/D/R/M/E = side A units, lowercase = side B, 0/1 = owned objective, O empty, x contested, . plain, f forest, ~ water, = ford, # rock, - road, % ruin, H bridge`);
      out.push("");
    }
  }

  return out.join("\n");
}

function mapSpecs(value, a) {
  if (!value) return [];
  if (value === "never") return [];
  if (value === "last") return ["last"];
  if (value === "auto") {
    const changes = [...new Set(a.objectiveChanges.map((c) => c.t))];
    const mid = Math.max(1, Math.floor((a.result.ticks || 0) / 2));
    return [...changes.slice(0, 2), mid, "last"].map(String);
  }
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function findState(a, tick) {
  // Replay the recorded orders up to the requested tick. Verification already did this,
  // but replaying only when a map is asked for keeps memory flat for long sets.
  if (!a._match) {
    const m = new a._sdk.Match(a.header.seed, { rules: a.rules });
    if (m.needsDraft) {
      if (a.drafts) { m.draft(0, a.drafts[0]); m.draft(1, a.drafts[1]); }
      m.start();
    }
    a._match = m;
  }
  const m = a._match;
  const ticks = a._ticks || [];
  while (m.tick < tick && !m.isOver) {
    const t = ticks[m.tick];
    m.step(t ? t.o : undefined);
  }
  return m.state;
}

// ---------------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { sdk } = await loadSdk(opts.sdk);
  const { text, origin } = await loadReplay(opts.source, opts.game);
  const replay = sdk.decodeReplay(text);
  const analysis = analyse(sdk, replay, { ...opts, origin });

  // small helpers for the text report
  analysis.statsById = new Map(analysis.units.map((u) => [u.id, u]));
  analysis._sdk = sdk;
  analysis._ticks = replay.ticks;

  if (opts.json) {
    const { map, rules, finalState, header, _sdk, _ticks, statsById, _match, ...rest } = analysis;
    const payload = {
      source: rest.source,
      seed: rest.seed,
      rulesVersion: rest.rulesVersion,
      bots: rest.bots,
      drafts: rest.drafts,
      verified: rest.verification,
      result: rest.result,
      sides: rest.sides,
      objectives: rest.objectives.map((o) => ({
        index: o.index, x: o.x, y: o.y, radius: o.radius, weight: o.weight, changes: o.changes,
      })),
      timeline: rest.timeline,
      units: rest.units,
      objectiveChanges: rest.objectiveChanges,
      destructions: rest.destructions,
      finalObjectives: finalState.objectives.map((o, i) => ({
        index: i, x: o.x / FP, y: o.y / FP, radius: o.radius / FP, weight: o.weight, owner: o.owner, state: o.state,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(report(analysis, opts));
}

main().catch((e) => {
  console.error(`bt-replay: ${e.message}`);
  process.exit(1);
});
