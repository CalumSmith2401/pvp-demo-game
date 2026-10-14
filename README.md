# PvP Demo Games

A collection of zero-dependency browser games.

| Game | Description |
|---|---|
| [Bad to the Bone](games/dice-draft/) | You and a rival get the same 8 rolls of three dice. Place each one in a bet zone for keeps; best table wins. |
| [Spell Draft Duel](games/spell-draft-duel/) | Draft the same 12 spells as an AI opponent, then duel. Placement is everything. |

## Run

```bash
npm start              # game hub at http://localhost:5173/
npm start <game>       # open one game directly, e.g. `npm start spell`
npm run games          # list available games
npm test [game]        # run tests for all games, or one
```

## Add a game

Drop it in `games/<id>/` with an `index.html` (and optionally a `game.json`
with `name` and `description`). It's picked up automatically.
