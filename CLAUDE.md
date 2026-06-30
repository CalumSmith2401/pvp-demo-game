# CLAUDE.md

Guidance for working in this repo.

## What this is

**Spell Draft Duel** — a single-player-vs-AI draft-and-combat game. You and a
heuristic AI are dealt the *same* sequence of 8 spells one card at a time, and each
privately places every card into an irrevocable 8-slot build. Builds then lock and
resolve in turn-based combat, animated on a 2D canvas. Because both sides see
identical cards, the only edge is *placement*.

Plain vanilla JS ES modules — **no build step, no framework, no dependencies.**

## Commands

```bash
npm start    # static server on http://localhost:5173 (serve.js)
npm test     # runs the combat-engine test suite (node test/combat.test.js)
```

There is no bundler, linter, or transpiler. Run in the browser via `npm start`
(ES modules won't load over `file://`, which is the only reason serve.js exists).

## Architecture

The data flows in one direction: **draft → locked builds → pure combat engine →
typed event stream → canvas animation.**

```
index.html        screen markup: menu / draft / lock / combat / end (toggled by .hidden)
serve.js          zero-dep static file server with path-traversal guard
css/styles.css    all styling; dark fantasy theme; CSS vars at :root
js/rng.js         seeded RNG (mulberry32) + Fisher–Yates shuffle → reproducible matches
js/spells.js      BASE_SPELLS, SEASONS config, buildPool(), makeSequence()
js/combat.js      resolveCombat() — pure, deterministic, no DOM
js/arena.js       Arena class — Canvas 2D renderer driven by the event stream
js/ai.js          chooseSlot() — heuristic opponent drafter
js/game.js        controller / state machine; wires screens, draft, playback
test/combat.test.js
```

### Key boundaries

- **`combat.js` is pure and DOM-free** — that's why it's directly unit-testable.
  `resolveCombat(buildA, buildB, labels)` returns `{ events, result, finalA, finalB }`.
  Each event carries both human `text` (for the log) and animation hints
  (`move`, `target`, `actor`, amounts, `spellId`) so the renderer never parses text.
  If you change the event shape, update `arena.js` (the consumer) to match.
- **`arena.js` knows nothing about game rules** — it just plays events. Playback is
  event-driven: `arena.step(onSettled)` plays the next event and calls back when it
  settles. The **Next** button and **Auto-play** in `game.js` share this one path, so
  guard against re-entrancy with `arena.isBusy` / `arena.atEnd()`.
- **`game.js` owns all DOM and state**; the other JS modules are pure/standalone.

## Conventions & invariants

- **Spell pool is data, not code.** Add or rebalance spells in `BASE_SPELLS`, and add
  seasonal variants as per-type multipliers in `SEASONS` (`buildPool()` applies them).
  A new `SEASONS` entry appears in the menu automatically — no other change needed.
  Keep balance changes as data here; don't hardcode spell numbers elsewhere.
- **Constants:** 60 starting HP (also the heal cap, `MAX_HP`), 8 build slots, 8-card
  sequence. `START_HP`/`MAX_HP` live in `combat.js`; `SLOTS`/`SEQ_LEN` in `game.js`.
- **Combat resolution order is the spec contract** — per slot 0→7: player's burn tick →
  player's spell → opponent's burn tick → opponent's spell; ends on 0 HP or after all
  16 actions, then higher HP wins / equal = draw. Shields soak the next damage/drain
  hit(s) and carry excess; burns bypass shields and stack; drains heal full value.
  If you touch this, the tests encode the expected behavior — keep them green.
- **Slot index = turn order** (slot 1 fires first). The AI's `idealPos()` maps spell
  types to preferred slots with this in mind.

## Gotchas

- The AI drafts the same card into its own build with **no lookahead**, the same
  constraint as the player — don't give it future-card knowledge.
- Canvas crispness: `Arena._size()` sets the bitmap to `logical × devicePixelRatio`;
  display size is constrained by CSS (`#arena { width:100%; max-width:720px }`). If you
  render the arena outside `index.html`, replicate that CSS or it displays at 2× and
  crops.
- When leaving combat, `game.js` calls `arena.stop()` to cancel the rAF loop and clear
  timers; `arena.start()` restarts it. Don't leave the loop running across screens.
- Verify visually with headless Chrome screenshots against `npm start` when changing
  rendering — `combat.js` tests cover rules, not pixels.
