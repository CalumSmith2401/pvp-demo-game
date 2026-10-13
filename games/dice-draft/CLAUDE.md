# CLAUDE.md

Guidance for working on this game (`games/dice-draft/`). Repo-wide conventions and
the launcher live in the root `CLAUDE.md`.

## What this is

**Dice Draft** (working title) — a 2-player dice placement game with a Sic Bo feel,
currently played against a bot. Both players get the *same* 8 rolls of 3 dice, one
at a time, and each privately places every roll into one of their own 8 bet zones.
Placement is final. When the table is full, every zone pays by its own rule and the
higher total wins. There is no randomness after the seed: the only edge is placement.

The name lives in one constant, `GAME_NAME` in `js/config.js`. The product owner
dislikes "Duel" in game names; keep it out of any rename.

Plain vanilla JS ES modules, no build step. The one library is Phaser 3 (3.90),
loaded from a pinned jsDelivr build via the import map in `index.html`. Only
`table.js` imports it.

## Commands

```bash
npm start dice             # from repo root: serve + open http://localhost:5173/dice-draft/
npm test dice              # rules, match layer, solver and bot tests
node sim/balance.js        # from this directory: print the balance report (100k matches, ~1 min)
node sim/balance.js --write            # ...and rewrite BALANCE.md
node sim/balance.js --matches 5000     # quick, noisier run
```

## Architecture

```
index.html        screen markup: menu / setup / play / end (toggled by .hidden), two dialogs
css/styles.css    DOM styling; palette at :root
js/config.js      GAME_NAME, the rule library, the classic pay table, VARIANTS, buildVariant()
js/rng.js         seeded RNG (mulberry32)
js/engine.js      makeRolls(), board scoring, buildReveal() — pure, no DOM
js/match.js       createMatch() — the authoritative layer (lockstep, hidden info, timeouts, log)
js/solver.js      exact expected-score DP over open zones
js/bots.js        BOTS — five opponents, random → win-probability search
js/table.js       Table (public API) + TableScene (Phaser): the whole play surface
js/game.js        controller: DOM, turn timer, bot pacing
sim/play.js       headless match runner (bots through match.js)
sim/balance.js    balance simulator → BALANCE.md
test/rules.test.js
BALANCE.md        generated balance report — committed, regenerate after any pay change
```

### Key boundaries

- **`match.js` is the server.** There is no network transport in this repo (Spell Draft
  runs its opponent locally too), so this module is the seam where one would go. A
  client may only call `view(player)`, `place(player, zoneId)` and `timeout(player)`.
  `view()` never includes the seed, future rolls, or the opponent's placement for the
  turn in progress (only `oppLocked: true`). `game.js` and the bots obey that surface;
  don't reach around it. The seed is only exposed by `audit()` after the match ends —
  a client holding the seed could compute every roll to come.
- **Scoring is `engine.js`, and it is the source of truth.** `table.js` calls
  `zone.score()` only to show the live "+N" preview; outcomes come from
  `match.result()`.
- **`table.js` knows nothing about the rules.** The controller feeds it rolls,
  accepted placements and the finished reveal log; it reports taps through
  `table.onPlace`. Phaser input is disabled: `Table._listen()` maps pointer events on
  the CSS-scaled canvas to logical coordinates itself. All choreography runs on the
  scene clock so `skip()` can fast-forward it by time scale.
- **Two layouts, one scene.** `layoutFor(portrait)` returns every rectangle
  (4×2 zones at 720×640, 2×4 at 420×750). `game.js` picks by window width when a match
  starts. Position things from the layout object, never from literals.

## Conventions & invariants

- **Balance is data.** Zones, rules and point values are in `config.js`. A season or
  mode is a `VARIANTS` entry of per-zone `pay` overrides (plus `dice` / `rolls`); it
  appears in the menu, simulator and tests automatically. Zone rule and payout text is
  generated from the pay values, so it cannot drift from the scoring.
- **After any pay change, run `node sim/balance.js --write`** and check the verdict
  table. The script exits non-zero if a check fails.
- **Rules are written for any dice count** (low/high split at 3.5 per die, "set" =
  all dice match). `rolls` may be less than the zone count; zones left open score 0.
- **Zone order is reveal order** and the number shown on each zone (also its keyboard
  shortcut).
- **Tie-break:** level totals go to whoever won more zones (`TIEBREAK_ZONES_WON`);
  level on both is a draw.
- **Timeouts** place the roll in the open zone with the lowest average payout and set
  `auto: true` on the log entry.
- **Bots get the same view as the player** and commit their move at deal time, before
  the player acts. Keep that information set honest. Bot strength order is asserted in
  the tests and reported in BALANCE.md; re-check both if you retune one.

## Visual theme

Arcade blue: a cobalt ground, chunky white dice, sticker-style hard shadows and one
loud yellow. Chosen from four mockups; keep new UI in this language.

- Palette is in `:root` in `css/styles.css` and mirrored in the `C` map at the top of
  `table.js` (WebGL can't read CSS vars) — change both.
- Yellow is the player and the primary action; red is the rival (lightened to
  `--rival` wherever it sits as text on blue). Dice keep **red 1 and 4 pips**.
- Depth is a solid offset shadow in `--shadow`, never a soft blur: buttons, option
  cards, panels, dialogs, the menu dice and the canvas frame all use it.
- Lilita One for titles, zone names and numerals. Nunito for DOM text. The table's
  small text stays Barlow Semi Condensed, because zone rules are long lines in narrow
  boxes and Nunito overflows them. Sentence case throughout.
- The menu is three actions only: Play, How to play, Tutorial. Rival and table are
  picked on the `setup` screen after Play. Tutorial is a placeholder dialog.
- Celebration scales with the hit (`_level()` in `table.js`): Straight and Triple by
  their `celebrate` rank in config, other zones by the size of the number. The full
  yellow flash is for Triple and a match win only.
- `prefers-reduced-motion` stops the menu dice bobbing and skips the tumble, shake
  and particles on the table.

## Gotchas

- Canvas crispness follows the Spell Draft pattern: the game renders at logical × dpr,
  the camera zooms by dpr, textures are painted at dpr, text uses `setResolution(dpr)`.
- Phaser writes inline pixel sizes on the canvas; `#table` in CSS overrides them with
  `!important` and an `aspect-ratio` set from `Table.start()`.
- `game.js` guards every delayed callback with `state.run`; bump it when a match starts
  or is abandoned, or stale bot/timer callbacks will act on the new match.
- The House's search memoises on the solver object; depth is `HOUSE.endgame` in
  `bots.js` (6 in the browser — 8 is exact but costs about a second on the first move).
- Verify rendering changes with headless Chrome screenshots at both a desktop and a
  phone width; the tests cover rules, not pixels.
