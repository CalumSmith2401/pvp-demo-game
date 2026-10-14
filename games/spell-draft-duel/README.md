# Spell Draft Duel

A draft-and-duel card game. You and an AI opponent are dealt the **same** sequence
of 12 spells, one card at a time, and each privately drafts them into a 12-slot
build (3×4 grid). Placement is irrevocable. Once both builds are full they lock and
resolve in turn-based combat, slot by slot. Because both sides see identical cards,
the only edge is *where* you place them.

This is the single-player-vs-AI variant: you draft against one of five bots that
draft from the same shared sequence under the same no-lookahead rule.

## Run it

```bash
# from the repo root
npm start spell   # serves and opens http://localhost:5173/spell-draft-duel/
npm test spell    # runs the combat-engine test suite
```

The root launcher is a tiny zero-dependency static server (the frontend uses ES
modules, which browsers won't load over `file://`).

## How combat resolves

Both players start at 80 HP (also the heal cap). For each slot 0→11:

1. **Your turn** — pending burns tick (start of turn), then your slot's spell fires.
2. **Opponent's turn** — their burns tick, then their slot's spell fires.

Combat ends the instant a player hits 0 HP, or after all 16 actions resolve — then
higher HP wins, equal HP is a draw. Shields soak the next damage/drain hit(s) until
depleted; burns bypass shields and stack; drains heal the full value (capped at 60).

The engine (`js/combat.js`) is a pure module — no DOM — which is why it's directly
unit-tested in `test/combat.test.js`. It emits a typed event stream (per action:
`move`, `target`, amounts, `spellId`) that the Phaser 3 arena (`js/arena.js`) renders
as two hooded casters duelling under an eclipse. Every spell has its own effect —
fire orbs, frost shards, meteors through a sky portal, forked lightning, blade
slashes, life-drain wisps, toxic lobs, rune seals, heal pillars, hex shields that
shatter, haste spirals, mirror panes — layered with a shockwave shader, hit-stop,
screen shake, zoom punches, and a gold slow-motion killing blow. Playback is
event-driven, so the **Next** button and **Auto-play** share one code path.

## Opponents

Pick one of five bots, increasing in strength (side-neutral win % vs the field,
measured over a 200-seed self-play tournament):

| Bot | Strategy | ≈ Strength |
|---|---|---|
| Novice | random placement | 29% |
| Apprentice | crude front/back split by school | 43% |
| Adept | value-aware positional heuristic | 51% |
| Strategist | Monte Carlo — simulates the duel before each card | 61% |
| Grandmaster | deep rollouts + greedy self-completion | 66% |

Every bot drafts under the same rule as you — it sees only the current card and its
own build, never the future sequence or your build. Strength comes from placement
quality, not from peeking. All bot logic lives in `js/ai.js` (`BOTS`).

## Seasons (pay-table rotation)

The spell pool is a config object (`js/spells.js`), so seasonal balance passes are a
data change, not a code change. Four ship today — Classic, Burn Season, Glass Cannon,
Fortify — each just a set of per-type multipliers applied by `buildPool()`. Add a new
entry to `SEASONS` and it appears in the menu automatically.

## Layout

```
index.html        screens: menu / draft / lock / combat / end
game.json         name/description shown in the game hub
css/styles.css
js/rng.js         seeded RNG (reproducible sequences)
js/spells.js      spell pool + season config
js/combat.js      pure combat engine (emits the typed event stream)
js/arena.js       Phaser 3 duel scene (Phaser loaded from CDN via import map)
js/ai.js          five selectable opponent bots (easy → very hard)
js/game.js        UI controller / state machine
test/combat.test.js
```
