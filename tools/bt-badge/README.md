# bt-badge — a live ladder badge for your battle.training bot

`bt-badge` renders a shields-style SVG from a bot's public battle.training stats, so a
repository can show its rank and rating without a screenshot that goes stale. It reads the
same public API the ladder page uses, works offline from a saved response, and needs no
dependencies beyond Node 18+.

The badge is meant to be committed (or regenerated on a schedule) and displayed in a README,
linking back to the bot page:

```md
[![battle.training](badge.svg)](https://battle.training/bots/maya-vanguard)
```

## Usage

```sh
# public ladder, rating + rank
node tools/bt-badge/bt-badge.mjs maya-vanguard --out badge.svg

# a cup ladder, showing sets played
node tools/bt-badge/bt-badge.mjs maya-vanguard \
  --ladder promotedby-cup-nov-2026 --metric sets --out cup.svg

# machine-readable stats, for an agent loop
node tools/bt-badge/bt-badge.mjs maya-vanguard --json

# render from a saved API response (offline)
node tools/bt-badge/bt-badge.mjs maya-vanguard --from fixtures/maya-vanguard.json
```

| flag | meaning |
| --- | --- |
| `--ladder <id>` | `public` (default) or a ladder id such as `promotedby-cup-nov-2026` |
| `--metric <name>` | `auto` (default), `rating`, `rank`, `record`, `sets` |
| `--label <text>` | left-hand label (default `battle.training`) |
| `--color <hex>` | right-hand color (default green for public, purple for a cup ladder) |
| `--out <file>` | write the SVG to a file instead of stdout |
| `--from <file>` | render from a saved API response |
| `--api <url>` | API base (default `https://api.battle.training`) |
| `--json` | print the selected stats as JSON |

`auto` shows `rating · rank` on the public ladder and `rating · sets` on a cup ladder, where
the public API does not expose a rank.

## Regenerate it on a schedule

A GitHub Actions workflow can keep the badge current without a server:

```yaml
name: battle.training badge
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
permissions:
  contents: write
jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node tools/bt-badge/bt-badge.mjs maya-vanguard --out badge.svg
      - run: |
          git config user.name "battle-badge"
          git config user.email "actions@users.noreply.github.com"
          git add badge.svg
          git diff --cached --quiet || git commit -m "badge: update battle.training stats"
          git push
```

The tool honours `HTTPS_PROXY`/`HTTP_PROXY` (it tunnels through the proxy with `CONNECT`),
because `fetch()` alone ignores those variables in many sandboxes.

## Tests

```sh
node --test tools/bt-badge/bt-badge.test.mjs
```

The tests use a trimmed API response in `fixtures/`, so they never touch the network.

## License

MIT, same as the rest of this repository.
