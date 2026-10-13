# CLAUDE.md

Guidance for working on this game (`games/spell-draft-duel/`). Repo-wide
conventions and the launcher live in the root `CLAUDE.md`.

## What this is

**Spell Draft Duel** — a single-player-vs-AI draft-and-combat game. You and a
heuristic AI are dealt the *same* sequence of 12 spells one card at a time, and each
privately places every card into an irrevocable 12-slot build. Builds then lock and
resolve in turn-based combat, animated with Phaser 3 (WebGL). Because both sides see
identical cards, the only edge is *placement*.

Plain vanilla JS ES modules — **no build step, no framework, no npm dependencies.**
The one library is Phaser 3 (3.90, the last v3 release), loaded as an ES module from a
pinned jsDelivr build via the import map in `index.html`. Only `arena.js` imports it.

## Commands

```bash
npm start spell   # from repo root: serve + open http://localhost:5173/spell-draft-duel/
npm test spell    # runs this game's combat-engine tests (test/combat.test.js)
```

There is no bundler, linter, or transpiler. Run in the browser via the root launcher
(ES modules won't load over `file://`). All paths below are relative to this game's
directory.

## Architecture

The data flows in one direction: **draft → locked builds → pure combat engine →
typed event stream → Phaser animation.**

```
index.html        screen markup: menu / draft / lock / combat / end (toggled by .hidden)
game.json         hub metadata (name, description)
css/styles.css    all styling; dark fantasy theme; CSS vars at :root
js/rng.js         seeded RNG (mulberry32) + Fisher–Yates shuffle → reproducible matches
js/spells.js      BASE_SPELLS, SEASONS config, buildPool(), makeSequence()
js/combat.js      resolveCombat() — pure, deterministic, no DOM
js/arena.js       Arena (public API) + DuelScene (Phaser scene) driven by the event stream
js/ai.js          BOTS — five opponent bots (random → Monte Carlo)
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
- **Arena internals.** `Arena` owns the `Phaser.Game` and keeps the public API;
  everything visual lives in `DuelScene`. Phaser boots asynchronously: the
  constructor stores `arena.ready`, `start()` (re)starts the scene, and `step()` waits
  on `arena.sceneReady`. Choreography uses only the scene clock — `_after()`
  (`this.time`), `_tween()` (`this.tweens`) and particle emitters — never `setTimeout`,
  because `_setTimeScale()` scales all three together for hit-stop, slow-mo and
  `arena.speed` (a playback-speed knob). Two cameras: the main one renders the `world`
  layer (shake, zoom punch, the `Shockwave` post-FX pipeline); `uiCam` renders the `hud`
  layer, which stays steady. Add world objects via `_w()` / `_img()` / `_emitter()` so
  they land in the right layer. Each spell picks a visual archetype via `STYLE[spellId]` (fallback
  `KIND_STYLE[kind]`) → an `_fx_<style>()` method; a new spell needs a `STYLE` entry
  (and a `SPELL_COLORS` entry), or it falls back to its kind's look. Impacts go
  through `_impact()`, which applies `ev.state`, spawns floaters, and handles
  knockback, camera trauma, hit-stop and the lethal check.
- **`game.js` owns all DOM and state**; the other JS modules are pure/standalone.

## Conventions & invariants

- **Spell pool is data, not code.** Add or rebalance spells in `BASE_SPELLS`, and add
  seasonal variants as per-type multipliers in `SEASONS` (`buildPool()` applies them).
  A new `SEASONS` entry appears in the menu automatically — no other change needed.
  Keep balance changes as data here; don't hardcode spell numbers elsewhere.
- **Constants:** 80 starting HP (also the heal cap, `MAX_HP`), 12 build slots, 12-card
  sequence. `START_HP`/`MAX_HP` live in `combat.js`; `SLOTS`/`SEQ_LEN` in `game.js`.
  The pool has 22 spells across 6 types (damage/heal/shield/burn/drain/**control**);
  each match draws 12.
- **Combat resolution order is the spec contract** — per slot 0→11: player's burn tick →
  player's spell → opponent's burn tick → opponent's spell; ends on 0 HP or after all
  actions, then higher HP wins / equal = draw. Shields soak the next damage/drain
  hit(s) and carry excess; burns bypass shields and stack; drains heal full value.
- **Spell behaviour is keyed off `spell.id`** inside `combat.js` (`resolveSpell`), not
  hardcoded per spell in the data. Conditionals (Execute, Chain Lightning, Vampiric),
  reflect (Reflect Ward), cleanse (Mana Barrier), recoil (Blood Pact), and the control
  trio (Silence/Haste/Mirror, which use persistent per-player state) all live there.
  If you touch any of this, the tests encode the expected behavior — keep them green.
- **Slot index = turn order** (slot 1 fires first). The AI's `idealPos()` maps spell
  types to preferred slots with this in mind.

## Visual theme

A WOW-inspired dark fantasy theme, not a generic mobile-game look. Keep new UI
consistent with these rules:

- **Palette lives in `:root` in `css/styles.css`.** Warm near-black surfaces
  (`--bg`/`--panel`, never pure black), antique gold/bronze borders
  (`--border`/`--border-bright`/`--gold`), and per-spell-type accents
  (`--c-damage`/`--c-heal`/`--c-shield`/`--c-burn`/`--c-drain`/`--c-control`).
  `js/arena.js`'s `SPELL_COLORS` map must stay in sync with these accents since
  WebGL can't read CSS vars.
- **Double-border "socketed metal" framing** on every interactive/panel element
  (buttons, `.season`, `.bot`, `.card.big`, `.slot`, `.log`, `#arena`): an outer
  1px `border` plus an inset `box-shadow` pair (dark inset line + faint highlight
  line), not a single flat border. Corners are boxy, not pill-shaped.
- **Cinzel (serif, loaded in `index.html` via Google Fonts)** is reserved for
  titles, names, and short display text — `header h1`, `.section-label`,
  `.card-name`, `.result-title`, `.lock-msg`, bot/season names — and for the
  canvas HP names/numbers and damage floaters in `arena.js`. Everything else
  (descriptions, log lines, body text) stays sans-serif.
- **Slot glow encodes spell type:** empty slots get a neutral gold vignette;
  filled slots get a border/box-shadow glow tinted to `type-${spell.type}`
  (`game.js` sets that class in `renderPlayerGrid()` and `buildGridHTML()` —
  any new slot-rendering code path must do the same or the glow won't apply).
- **Gold full-screen flash is reserved for the lethal/killing blow only**
  (`arena.js` `_lethal()` calls `_flash(…, gold)`, and only `_impact()` calls it when
  `hpA <= 0 || hpB <= 0`); non-lethal hits flash white. Don't reuse gold flash
  for routine hits.
- Avoid: pure black, pastel colors, single flat borders, rounded "pill" cards,
  and overusing the gold flash outside the killing blow.

## Gotchas

- Bots draft the same card into their own build with **no lookahead**, the same
  constraint as the player — don't give them future-card knowledge. The simulation
  bots (Strategist/Grandmaster) Monte-Carlo over *sampled* unseen cards via `ctx.rand`
  (a seeded RNG), and model the opponent as an Adept; keep that information set honest.
- `js/ai.js` exports `BOTS` (tiered easy→hard) and `getBot(id)`. Bot strength order is
  verified by self-play; if you retune a bot, re-check the gradient stays monotonic.
- Canvas crispness: the Phaser game is `720×380 × dpr` and both cameras zoom by
  `dpr`, so world coordinates stay 720×380. Canvas textures are painted at dpr and
  shown at `1/dpr` scale, and text uses `setResolution(dpr)`, so keep that pattern
  for new assets. Phaser writes an inline pixel width onto the canvas, so
  `#arena { width:100% !important; height:auto !important }` in CSS keeps it fluid.
  If you render the arena outside `index.html`, replicate that CSS or it displays at
  2× and crops.
- Phaser needs an explicit renderer type when given an existing canvas (`AUTO`
  throws), so `arena.js` picks `WEBGL` or `CANVAS` itself. The shockwave is
  WebGL-only and silently skipped on the canvas renderer.
- When leaving combat, `game.js` calls `arena.stop()`, which sleeps Phaser's game
  loop; `arena.start()` wakes it and restarts the scene from scratch. Don't leave the
  loop running across screens.
- Verify visually with headless Chrome screenshots against `npm start spell` when changing
  rendering — `combat.js` tests cover rules, not pixels.
