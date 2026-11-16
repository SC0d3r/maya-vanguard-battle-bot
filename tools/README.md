# bt-replay — agent-readable telemetry for battle.training replays

`bt-replay` turns a public battle.training replay into text an agent can act on: where each
unit went, which objectives changed hands and when, how much damage every hull dealt and took,
and what the final board looked like. It exists because the ladder's replay viewer is a 3D
broadcast — great for humans, useless for a coding agent that needs to diff two versions of a
controller after a ranked set.

The tool is dependency-free (Node 18+) and uses the arena's own engine
(`https://api.battle.training/sdk/arena-sim.mjs`) to decode the replay and check its hash chain,
so a report is only printed for a replay that re-simulates correctly.

## Usage

```sh
# by match id (the public replay API serves each game in a set)
node tools/bt-replay.mjs m_85036d467617 --game 1

# from a saved replay file, with map snapshots at chosen ticks
node tools/bt-replay.mjs replays/m_85036d467617.jsonl --maps 0,1200,last

# machine-readable, for an agent loop
node tools/bt-replay.mjs m_85036d467617 --game 1 --json > report.json
```

Options:

| flag | meaning |
| --- | --- |
| `--game <n>` | game number inside a ranked set (default 1) |
| `--json` | print one JSON document instead of the text report |
| `--maps <ticks>` | ASCII map snapshots: `0,600,last`, `auto`, or `never` (default `last`) |
| `--sdk <path>` | use a local `arena-sim.mjs` instead of the cached download |
| `--no-verify` | skip hash-chain verification (faster, not recommended for review) |

The engine is downloaded once to `~/.cache/bt-replay/arena-sim.mjs`. Replays are public at
`https://api.battle.training/api/replays/<match>.jsonl?game=<n>`.

## What the report contains

- **Verification:** whether the replay's hash chain re-simulates, and the first mismatching tick.
- **Result and drafts:** both bots and versions, seed, rules version, squad picks, winner, reason,
  final score.
- **Objectives:** every control point with its weight, radius, and ownership timeline.
- **Score timeline:** sampled score and objective ownership, so a collapse is visible at a glance.
- **Units:** damage dealt and taken (attributed through shell ids), kills, shots, distance
  travelled, ticks spent inside an objective radius, and final hp.
- **Destructions and objective changes:** the event log that explains the score.
- **ASCII maps:** terrain, objectives (`0`/`1` owned, `O` empty, `x` contested) and units
  (uppercase side A, lowercase side B), downsampled 2 tiles per character.

## Example

```
bt-replay · nightscout-armor (v6) vs maya-vanguard (v3-hold-points)
seed 1107727823 · rules s2.0.0 · draft A mbt/mbt/mbt · draft B apc/mbt/drone/scout
verified ok
result side A by eliminated at 2035t (101.8s) · score A 1479 : 1546 B

units
  side unit          dmg  taken kills shots    dist obj ticks hp
  B    mbt#5         235    164     1    10    52.2      1644 0/160 lost
  ...
```

In this set `maya-vanguard` out-scored the opponent on the board but lost its last hull: the unit
table shows the APC spent 453 ticks on a point while the MBT fought 1644 ticks inside one — the
kind of detail that is invisible in a 3D replay and immediately actionable in a controller.

---

# bt-ladder — public ladder standings and qualification progress

`bt-ladder` answers a different question from `bt-replay`: instead of one set, it shows where a
bot stands across every ladder it has entered. The bot page shows a rating, but not the win rate,
the health of the active version, or how many ranked sets remain before a cup's qualification
threshold — all things a coding agent needs when deciding whether to keep tuning a controller.

It is dependency-free (Node 18+ global `fetch`) and uses only the public read API, so no account
key is required.

```sh
node tools/bt-ladder.mjs maya-vanguard
node tools/bt-ladder.mjs maya-vanguard --all-ladders
node tools/bt-ladder.mjs maya-vanguard --json > standings.json
```

| flag | meaning |
| --- | --- |
| `--json` | print one JSON document instead of the text report |
| `--all-ladders` | also list open ladders the bot has not entered |
| `--api <url>` | override the API base (used by the tests) |

Example output:

```
bt-ladder · maya-vanguard (handle maya-research)
active version v3-hold-points
health timeouts=0 exceptions=0 idle_ticks=0
promotedby-cup-nov-2026 · promotedby.ai November Cup · rating 1218 ±35 · score 1147 · 97 games (39W/39L/19D, 40.2%) · qualify 97/100 (3 left) · last 2026-11-16T20:49:13.389Z
```

Data comes from `GET /api/bots/<name>` and `GET /api/ladders`. Qualification progress is computed
from each ladder's `entry.min_sets_to_qualify`; a ladder without an entry is reported without it.
The tool never posts, uploads, or modifies a bot — it only reads public endpoints.

Run the tests with `node --test tools/bt-ladder.test.mjs`. The tests use local fixtures and a stub
API URL, so they make no network calls.

## License

MIT, same as the rest of this repository.
