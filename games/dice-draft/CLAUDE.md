# CLAUDE.md

Guidance for working on this game (`games/dice-draft/`). Repo-wide conventions and
the launcher live in the root `CLAUDE.md`.

## What this is

**Bad to the Bone** (earlier "Dice Draft", then "Loaded Dice"; the folder and URL are still `dice-draft`). "Bones" is slang for dice, and Bones the dog is the dealer — a 2-player dice placement game with a Sic Bo feel,
currently played against a bot. Each turn both players are shown the *same* rolls
and each privately places one into one of their own 8 zones. Placement is final.
When the table is full, the zones are scored one by one and the higher total wins.
Nothing random happens that isn't dealt to both players: the only edge is decisions.

Two rule sets ship (`VARIANTS` in `js/config.js`):

- **Arcade** (default): two rolls offered per turn (place one), 8 zones dealt from a
  pool of 14, a hot zone, a golden die, streaks, sweeps, bounties, and four once-per-
  match power-ups (Flip, Double, Hold, Peek). Triples Season is Arcade with one
  pay override.
- **Classic**: the original game. One roll per turn, eight fixed zones, no extras.

The name lives in one constant, `GAME_NAME` in `js/config.js`. The product owner
dislikes "Duel" in game names; keep it out of any rename.

Plain vanilla JS ES modules, no build step. The one library is Phaser 3 (3.90),
loaded from a pinned jsDelivr build via the import map in `index.html`. Only
`table.js` imports it.

## Commands

```bash
npm start dice             # from repo root: serve + open http://localhost:5173/dice-draft/
npm test dice              # rules, match layer, solver and bot tests
node sim/balance.js        # from this directory: print the balance report (about 8 minutes)
node sim/balance.js --write            # ...and rewrite BALANCE.md
node sim/balance.js --matches 3000     # quick, noisier run (about 2 minutes)
```

## Architecture

```
index.html        screen markup: menu / setup / play / end (toggled by .hidden), two dialogs
css/styles.css    DOM styling; palette at :root
js/config.js      GAME_NAME, the rule library, the zone pool, the extras, VARIANTS, buildVariant()
js/rng.js         seeded RNG (mulberry32)
js/engine.js      makeTable(), makeOffers(), scorePlacement(), check/applyAction(), buildReveal() — pure
js/match.js       createMatch() — the authoritative layer (lockstep, hidden info, Peek, timeouts, log)
js/solver.js      createSolver(): exact expected-points DP for one table
js/bots.js        BOTS — five opponents, random → solver + Hold/Peek search
js/table.js       Table (public API) + TableScene (Phaser): the whole play surface
js/game.js        controller: DOM, HUD, turn timer, bot pacing, what a tap means
assets/           pre-rendered dice sheets (white and gold): roll, faces, flip; dice-roll.json
assets/mascot/    Bones the dealer: one sprite sheet per clip, described by bones.json
design/mascots/   mascot concept art from the render pipeline; drafts, not loaded by the game
sim/play.js       headless match runner (bots through match.js), solver cache per table
sim/balance.js    balance simulator → BALANCE.md
test/rules.test.js
BALANCE.md        generated balance report — committed, regenerate after any rules change
```

### The rules in one place

All in `engine.js`, all driven by numbers in `config.js`:

- A roll on offer is `{ dice, gold }` (gold = index of the golden die, or null).
- A placement scores `(base + goldPts) × mult + streakBonus`: `base` from the zone's
  rule; `goldPts` the golden die's face, only if `base > 0`; `mult` 1, +1 for the hot
  zone, +1 for Double; `streakBonus` grows with consecutive scoring placements and a
  blank resets it.
- Zones 1–4 and 5–8 are sets. Filling a set with no blank pays a sweep at once.
- At the reveal, winning a zone outright pays a bounty.
- A turn's action is one object: `{ pick, flip, hold, zone, double, held }` (see
  `checkAction`). A held roll placed later lands *before* that turn's roll. A roll
  still held on the last turn drops into the last open zone.

### Key boundaries

- **`match.js` is the server.** There is no network transport in this repo (Spell Draft
  runs its opponent locally too), so this module is the seam where one would go. A
  client may only call `view(player)`, `act(player, action)`, `peek(player)` and
  `timeout(player)`. `view()` never includes the seed, future rolls, or the opponent's
  action for the turn in progress (only `oppLocked: true`); the opponent's board,
  streak and power-ups reflect completed turns only. Peek is the one sanctioned look
  ahead and is granted here. `game.js` and the bots obey that surface; don't reach
  around it. The seed is only exposed by `audit()` after the match ends — a client
  holding the seed could compute every roll to come.
- **Scoring is `engine.js`, and it is the source of truth.** Outcomes come from
  `match.result()`. `game.js` replays the player's own action on a copy of their state
  (`applyAction`) only to show their points before the rival has acted; it uses the
  same function the match does.
- **`table.js` knows nothing about the rules.** It reports what was touched
  (`onSelect`, `onDie`, `onZone`); `game.js` decides what that means (which roll is in
  hand, whether a die tap is a Flip, whether a zone tap stages the held roll or locks
  the turn) and tells the table what to show. Phaser input is disabled:
  `Table._listen()` maps pointer events on the CSS-scaled canvas to logical
  coordinates itself. All choreography runs on the scene clock so `skip()` can
  fast-forward it by time scale.
- **Motion vocabulary in `table.js`.** Reuse the helpers so the table moves as one
  thing: `_arc()` (anything that flies), `_pop()` / `_punch()` (appear / "this
  changed"), `_award()` (points lifting off a score into a total), `_celebrate()`
  (escalating payoff). Each zone is a Container centred on its box (`cell.c`,
  children in relative coordinates) so it can hop, press and punch as one piece; a
  child's table position is `cell.cx + child.x`. `update()` owns the idle life:
  die shadows and the red rattle in the timer's last quarter. Resting dice sit
  still (an idle bob was tried and rejected), unrotated, on whole device pixels, with a texture made at their exact size
  (`_face(value, size, gold)`): anything else resamples the artwork and looks soft.
- **Dice motion is pre-rendered.** `assets/dice-roll.webp` holds six tumble clips (one
  per final value, rotation only, right-to-left, ending flat) and `dice-flip.webp` six
  flip clips (one per starting value, ending on its opposite). `_throw()` and `flip()`
  play them on a sprite; `dice-faces.webp` (same renderer and lighting) supplies the
  resting and mini dice, so the hand-offs don't show. Each sheet has a `-gold` twin
  for the golden die. Sizes and frame counts are read from `assets/dice-roll.json`,
  never hard-coded. If the sheets fail to load, `paintDie()` draws flat dice and the
  roll simply appears. The sheets were rendered by a one-off script outside this
  repo; new art must keep the layout in the JSON (2 and 3 diagonal top-left to
  bottom-right, 6 as two columns).
- **The table, top to bottom:** the header (your score, Bones the dealer, the
  rival's score), a line for the turn and what Bones says (`_say`), the zones, and
  the tray with this turn's rolls by the player's thumbs. There is no separate
  rival board: when the rival places, their dice hover over that zone for a moment
  and then shrink to a coral dot on it (`revealRival`).
- **Zones draw their rule.** An open zone shows `zone.picture` (dice, with a dashed
  outline for "any die", or a short phrase) and `zone.pays`, both generated in
  `config.js` (`PICTURES`). A filled zone shows the dice that landed and the score.
- **Bones reacts through `_react(pose)`.** His clips are pre-rendered sheets, one per
  clip, all framed identically around one pivot (the centre of his head), read from
  `assets/mascot/bones.json`. `throw`, `cheer`, `wince` and `celebrate` play once and
  drop back to his base loop; `idle` and `streak` are the base loops (streak while
  the player has scored three turns running); `sulk` holds its last frame. The dice
  leave on the throw clip's `releaseFrame`. If the JSON or sheets fail to load the
  header simply has no dealer.
- **Two layouts, one scene.** `layoutFor(portrait, zones, offers)` returns every
  rectangle (4×2 zones at 720 wide, 2×4 at 420 wide; the height follows from the
  parts). `game.js` picks by window width when a match starts. Position things
  from the layout object, never from literals.

## Conventions & invariants

- **Balance is data.** The zone pool, every bonus and every switch are in `config.js`.
  A season or mode is a `VARIANTS` entry: per-zone `pay` overrides plus the extras
  block. It appears in the menu, simulator and tests automatically. Zone rule and
  payout text, and the How to play dialog, are generated from those values, so they
  cannot drift from the scoring.
- **After any rules change, run `node sim/balance.js --write`** and check the verdict
  table. The script exits non-zero if a check fails.
- **The solver is exact except for Hold and Peek.** Its state is (open zones, streak,
  which sets can still sweep, Flip left, Double left). Hold and Peek would multiply
  that, so The House searches one turn ahead on top of the solver's values instead.
  Say "the solver", not "optimal play", in anything user-facing.
- **A table must be solved before Shark or The House can play it** (a few hundred
  milliseconds). In the browser `game.js` runs `solver.step()` in slices while the
  table deals in, and the bot waits on `solver.done`. The simulator caches one solver
  per table and spreads its matches over 50 tables.
- **The solver assumes one placement per zone** (`rolls === zones`). The rules allow
  other dice counts, but nothing ships with them.
- **Zone order is reveal order**, the number shown on each zone, its keyboard
  shortcut, and what defines the two sweep sets.
- **Tie-break:** level totals go to whoever won more zones (`TIEBREAK_ZONES_WON`);
  level on both is a draw.
- **One clock per match, not per turn.** Each player has `MATCH_SECONDS` of thinking
  time for the whole match (the user asked for this instead of a per-turn timer).
  `game.js` runs it only while the player has a move to make, so animations and the
  rival's turn are free. At zero, this turn and every later one is auto-placed: the
  first roll into the open zone with the lowest average payout, no power-ups,
  `auto: true` on the log entry. The clock lives in the controller, not in
  `match.js`; a real server would have to own it.
- **Bots get the same view as the player** and never see the player's pending action.
  Keep that information set honest. Bot strength order is asserted in the tests and
  reported in BALANCE.md; re-check both if you retune one.
- **Score previews were removed on purpose.** The table does not show what a roll
  would score in each zone: the player asked to work that out themselves.

## Visual theme

Bad to the Bone after dark: a midnight ground (`--ground`, near-black navy) under a
dim spotlight, chunky white dice, sticker-style hard shadows and one loud yellow.
The user chose it after the rename, replacing the earlier cobalt "arcade blue" look;
keep new UI in this language. Bones is the "shades" take: dark glasses, toothpick,
studded collar.

- Palette is in `:root` in `css/styles.css` and mirrored in the `C` map at the top of
  `table.js` (WebGL can't read CSS vars) — change both.
- Yellow is the player and the primary action; red is the rival (lightened to
  `--rival` wherever it sits as text on blue). Dice keep **red 1 and 4 pips**.
- Depth is a solid offset shadow in `--shadow`, never a soft blur: buttons, option
  cards, panels, dialogs, the menu dice and the canvas frame all use it.
- Bagel Fat One for titles, zone names and numerals. Nunito for DOM text. The table's
  small text stays Barlow Semi Condensed, because zone rules are long lines in narrow
  boxes and Nunito overflows them. Sentence case throughout.
- The menu is Bones nose to nose: his face fills the top of the screen
  (`assets/mascot/bones-menu.png`, a still) and Play hangs from his collar as a
  yellow tag, with the title under it. Three actions only: Play, How to play, Tutorial. Rival and table are
  picked on the `setup` screen after Play. Tutorial is a placeholder dialog.
- Orange (`C.hot`) means the hot zone and nothing else. The golden die is the
  player's yellow, rendered as a gold die.
- Power-ups are DOM buttons in the HUD under the canvas, not canvas objects: white
  when available, yellow when armed, sunk into the page when used.
- Celebration scales with the hit (`_level()` in `table.js`): Straight and Triple by
  their `celebrate` rank in config, other zones by the size of the number. The full
  yellow flash is for Triple and a match win only.
- `prefers-reduced-motion` skips the tumble, shake and particles on the table.

## Gotchas

- Canvas crispness follows the Spell Draft pattern: the game renders at logical × dpr,
  the camera zooms by dpr, textures are painted at dpr, text uses `setResolution(dpr)`.
- Phaser writes inline pixel sizes on the canvas; `#table` in CSS overrides them with
  `!important` and an `aspect-ratio` set from `Table.start()`.
- **The menu and the play screen fill the viewport exactly and never scroll**
  (`body.playing` in the CSS). On the play screen the HUD takes its height at the
  bottom and the canvas scales into what is left (`.stage`), so on a phone the table
  is limited by height and has side margins. Anything added below the canvas makes
  the table smaller: keep the HUD to its two rows. Setup and result screens scroll.
- `game.js` guards every delayed callback with `state.run`; bump it when a match starts
  or is abandoned, or stale bot/timer callbacks will act on the new match.
- Verify rendering changes with headless Chrome screenshots at both a desktop and a
  phone width; the tests cover rules, not pixels.
