#!/usr/bin/env node
// bt-badge — a live battle.training ladder badge for your README.
//
// Fetches a bot's public stats from the arena API and renders a shields-style SVG
// that links to the bot page, so a repository can show its rank without a
// screenshot that goes stale. Dependency-free (Node 18+), proxy-aware, and
// testable offline with --from.
//
// Usage:
//   node tools/bt-badge/bt-badge.mjs maya-vanguard --out badge.svg
//   node tools/bt-badge/bt-badge.mjs maya-vanguard --ladder promotedby-cup-nov-2026 --metric record
//   node tools/bt-badge/bt-badge.mjs maya-vanguard --json
//
// Options:
//   --bot <name>        bot name (or positional argument)
//   --ladder <id>       "public" (default) or a ladder id such as promotedby-cup-nov-2026
//   --metric <name>     auto (default), rating, rank, record, sets
//   --label <text>      left-hand label (default: battle.training)
//   --color <hex>       right-hand color (default: green for public, purple for a cup ladder)
//   --out <file>        write the SVG to a file instead of stdout
//   --from <file>       render from a saved API response (offline / tests)
//   --api <url>         API base (default: https://api.battle.training)
//   --json              print the selected stats as JSON (no SVG)
//   --help              show this help

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API = "https://api.battle.training";
const VERSION = "1.0.0";

const HELP = `bt-badge ${VERSION} — live battle.training ladder badge

Usage:
  node tools/bt-badge/bt-badge.mjs <bot> [options]

Options:
  --ladder <id>     "public" (default) or a ladder id (e.g. promotedby-cup-nov-2026)
  --metric <name>   auto (default), rating, rank, record, sets
  --label <text>    left-hand label (default: battle.training)
  --color <hex>     right-hand color
  --out <file>      write SVG to a file instead of stdout
  --from <file>     render from a saved API response
  --api <url>       API base (default: ${DEFAULT_API})
  --json            print selected stats as JSON
  --help            show this help

Examples:
  node tools/bt-badge/bt-badge.mjs maya-vanguard --out badge.svg
  node tools/bt-badge/bt-badge.mjs maya-vanguard --ladder promotedby-cup-nov-2026 --metric sets
  node tools/bt-badge/bt-badge.mjs maya-vanguard --json
`;

// ---------------------------------------------------------------------------- fetch

// fetch() ignores HTTPS_PROXY, and many agent sandboxes only reach the network
// through a proxy. Tunnel through it when one is configured, else use fetch.
function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

function fetchViaProxy(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = new URL(proxyUrl());
    const connect = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
    });
    connect.setTimeout(25000, () => connect.destroy(new Error("proxy CONNECT timed out")));
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT failed (${res.statusCode})`));
        return;
      }
      const req = https.request(
        {
          hostname: target.hostname,
          path: target.pathname + target.search,
          socket,
          agent: false,
          headers: { host: target.hostname, "user-agent": `bt-badge/${VERSION}`, accept: "application/json" },
        },
        (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 3) {
              resolve(fetchText(new URL(r.headers.location, url).href, redirects + 1));
              return;
            }
            if (r.statusCode < 200 || r.statusCode >= 300) {
              reject(new Error(`${url} -> ${r.statusCode} ${r.statusMessage}`));
              return;
            }
            resolve(body);
          });
        }
      );
      req.setTimeout(25000, () => req.destroy(new Error("request timed out")));
      req.on("error", reject);
      req.end();
    });
    connect.on("error", reject);
    connect.end();
  });
}

function fetchText(url, redirects = 0) {
  if (proxyUrl()) return fetchViaProxy(url, redirects);
  return fetch(url, {
    headers: { "user-agent": `bt-badge/${VERSION}`, accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  }).then(async (res) => {
    if (res.status >= 300 && res.status < 400 && res.headers.get("location") && redirects < 3) {
      return fetchText(new URL(res.headers.get("location"), url).href, redirects + 1);
    }
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    return res.text();
  });
}

// ---------------------------------------------------------------------------- stats

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function selectStats(data, ladder = "public") {
  if (!data || typeof data !== "object") throw new Error("empty bot response");
  const bot = data.name || data.handle || "unknown";
  if (ladder === "public" || ladder === "theater" || ladder === "ladder") {
    const key = data.theater || "armor";
    const theater = (data.theaters || {})[key];
    if (!theater) throw new Error(`no public theater data for "${key}"`);
    return {
      bot,
      ladder: "public",
      ladderName: theater.ladder || "battle.training",
      rating: number(theater.rating),
      rank: number(theater.rank),
      of: number(theater.of),
      wins: number(theater.wins),
      losses: number(theater.losses),
      draws: number(theater.draws),
      sets: number(theater.sets),
      url: theater.url || `https://battle.training/bots/${encodeURIComponent(bot)}`,
    };
  }
  const entry = (data.ladders || []).find((item) => item.ladder === ladder);
  if (!entry) throw new Error(`bot is not on ladder "${ladder}"`);
  return {
    bot,
    ladder,
    ladderName: ladder,
    rating: number(entry.rating),
    rank: null,
    of: null,
    wins: number(entry.wins),
    losses: number(entry.losses),
    draws: number(entry.draws),
    sets: number(entry.games),
    url: `https://battle.training/bots/${encodeURIComponent(bot)}`,
  };
}

export function formatMessage(stats, metric = "auto") {
  const rating = stats.rating == null ? "unrated" : String(Math.round(stats.rating));
  switch (metric) {
    case "rating":
      return rating;
    case "rank":
      return stats.rank == null ? "unranked" : `#${stats.rank}${stats.of ? "/" + stats.of : ""}`;
    case "record":
      return `${stats.wins ?? 0}W ${stats.losses ?? 0}L ${stats.draws ?? 0}D`;
    case "sets":
      return `${stats.sets ?? 0} sets`;
    case "auto":
    default:
      return stats.rank == null ? `${rating} · ${stats.sets ?? 0} sets` : `${rating} · #${stats.rank}`;
  }
}

// ---------------------------------------------------------------------------- SVG

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textWidth(value) {
  // Verdana 11px averages ~6.5px per glyph; shields.io uses the same estimate.
  return Math.ceil(String(value).length * 6.5) + 10;
}

export function renderBadge({ label, message, color = "#2ea44f", title }) {
  const labelText = String(label);
  const messageText = String(message);
  const labelWidth = Math.max(textWidth(labelText), 44);
  const messageWidth = Math.max(textWidth(messageText), 44);
  const width = labelWidth + messageWidth;
  const accessible = escapeXml(title || `${labelText}: ${messageText}`);
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(String(color)) ? String(color) : "#2ea44f";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${accessible}">
  <title>${accessible}</title>
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${safeColor}"/>
    <rect width="${width}" height="20" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${escapeXml(labelText)}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${escapeXml(messageText)}</text>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = {
    api: DEFAULT_API,
    ladder: "public",
    metric: "auto",
    label: "battle.training",
    color: null,
    out: null,
    from: null,
    json: false,
    bot: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--bot") options.bot = next();
    else if (arg === "--ladder") options.ladder = next();
    else if (arg === "--metric") options.metric = next();
    else if (arg === "--label") options.label = next();
    else if (arg === "--color") options.color = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--from") options.from = next();
    else if (arg === "--api") options.api = next();
    else if (!arg.startsWith("-") && !options.bot) options.bot = arg;
    else throw new Error(`unknown option "${arg}"`);
  }
  if (!options.bot && !options.help) throw new Error("missing bot name (try --help)");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const source = options.from
    ? fs.readFileSync(options.from, "utf8")
    : await fetchText(`${options.api.replace(/\/$/, "")}/api/bots/${encodeURIComponent(options.bot)}`);
  const data = JSON.parse(source);
  const stats = selectStats(data, options.ladder);
  const message = formatMessage(stats, options.metric);
  const color = options.color || (stats.ladder === "public" ? "#2ea44f" : "#8250df");

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...stats, message, color }, null, 2)}\n`);
    return;
  }

  const svg = renderBadge({ label: options.label, message, color, title: `${options.label}: ${message} (${stats.bot})` });
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, svg);
    process.stderr.write(`bt-badge: wrote ${options.out} (${stats.bot}, ${options.ladder}, ${message})\n`);
  } else {
    process.stdout.write(svg);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`bt-badge: ${error.message}\n`);
    process.exit(1);
  });
}
