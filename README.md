# Spell Draft Duel

A draft-and-duel card game. You and an AI opponent are dealt the **same** sequence
of 8 spells, one card at a time, and each privately drafts them into an 8-slot
build (2×4 grid). Placement is irrevocable. Once both builds are full they lock and
resolve in turn-based combat, slot by slot. Because both sides see identical cards,
the only edge is *where* you place them.

This is the single-player-vs-AI variant: you draft against a heuristic AI that
drafts from the same shared sequence under the same no-lookahead rule.

## Run it

```bash
npm start      # serves on http://localhost:5173
npm test       # runs the combat-engine test suite
```

`npm start` runs a tiny zero-dependency static server (the frontend uses ES
modules, which browsers won't load over `file://`).

## How combat resolves

Both players start at 60 HP (also the heal cap). For each slot 0→7:

1. **Your turn** — pending burns tick (start of turn), then your slot's spell fires.
2. **Opponent's turn** — their burns tick, then their slot's spell fires.

Combat ends the instant a player hits 0 HP, or after all 16 actions resolve — then
higher HP wins, equal HP is a draw. Shields soak the next damage/drain hit(s) until
depleted; burns bypass shields and stack; drains heal the full value (capped at 60).

The engine (`js/combat.js`) is a pure module — no DOM — which is why it's directly
unit-tested in `test/combat.test.js`. It emits a typed event stream (per action:
`move`, `target`, amounts, `spellId`) that the canvas arena (`js/arena.js`) renders
as two casters trading projectiles/bolts, with impact bursts, screen shake, floating
damage numbers, shield bubbles, burn auras, and on-canvas HP bars. Playback is
event-driven, so the **Next** button and **Auto-play** share one code path.

## Seasons (pay-table rotation)

The spell pool is a config object (`js/spells.js`), so seasonal balance passes are a
data change, not a code change. Four ship today — Classic, Burn Season, Glass Cannon,
Fortify — each just a set of per-type multipliers applied by `buildPool()`. Add a new
entry to `SEASONS` and it appears in the menu automatically.

## Layout

```
index.html        screens: menu / draft / lock / combat / end
serve.js          zero-dep static server
css/styles.css
js/rng.js         seeded RNG (reproducible sequences)
js/spells.js      spell pool + season config
js/combat.js      pure combat engine (emits the typed event stream)
js/arena.js       Canvas 2D duel renderer
js/ai.js          heuristic opponent drafter
js/game.js        UI controller / state machine
test/combat.test.js
```
