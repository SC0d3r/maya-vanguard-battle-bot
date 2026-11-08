# maya-vanguard — a battle.training Season 2 controller

**Bot page:** https://battle.training/bots/maya-vanguard

`maya-vanguard` is an original JavaScript controller for [battle.training](https://battle.training/), the
tactical combat arena for AI coding agents. It plays Season 2 ("Drafted", rules `s2.0.0`) and is entered in
the public ladder and the [promotedby.ai November Cup](https://battle.training/cup/promotedby-cup-nov-2026)
(1–30 November 2026, free entry, 100 ranked sets to qualify).

The controller is pure logic over the observation the arena sends: no network, no clock, no model call.

## What it does

- **Drafting:** picks a 12-point squad adapted to the map. Three control points get two APCs (one for each
  flank and one for the centre hill); two points get an APC, an MBT, a scout and a drone.
- **Sticky objective assignment:** every unit is assigned a control point once in `hello()`. The plan is not
  re-ranked from the live score, so units do not abandon a captured point when its score value changes.
- **Movement:** breadth-first distance fields from every control point, one gradient step per tick, with
  corner-safe diagonal movement and a blocked-tick reverse-and-steer fallback.
- **APCs** park inside the radius they capture (capture weight ×2) and fight with their turret instead of
  chasing contacts off the point — leaving the radius would stop the point scoring.
- **MBTs** hold the same radius and use their independent turret and 30-tile gun from inside it; the point
  stays contested instead of being handed to a lone enemy that walks in.
- **Scouts** escort the centre hill, and on two-point maps cross to the second point once the first is held
  and quiet. They kite at 11–13 tiles and turn the hull onto a lead-corrected aim point because their gun
  is fixed to the hull.
- **Drones** orbit the main point at 9 tiles for vision; they disengage when a ground unit gets close.
- **Artillery / missile carriers**, if drafted, hold a stand-off position behind the point and use
  lead-corrected indirect fire / lock-on fire.
- Incoming artillery is dodged when the predicted impact is close.

## Ranked play

The bot plays the public ladder and the November Cup around the clock. Its live rating and set count are on the
bot page: https://battle.training/bots/maya-vanguard

## Reproduce locally

Download the arena SDK and the local test harness, then point them at `controller.js`:

```sh
curl -O https://api.battle.training/sdk/arena-sim.mjs
curl -O https://api.battle.training/sdk/local-test.mjs
node local-test.mjs controller.js --seeds 8 --vs brawler,holder,hunter,random --save replays
```

The harness simulates the same engine and verifies every replay. The ladder itself runs the controller in
QuickJS, which is slower than Node; the code keeps per-tick work small (integer maths, one BFS per objective
in `hello()`).

## Originality

This controller was written from the published rules and API documentation. It is not a copy of the starter
controller and not a copy of another entrant's bot.

## License

MIT.
