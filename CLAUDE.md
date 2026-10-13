# CLAUDE.md

Guidance for working in this repo.

## What this is

A collection of small browser games. Each game is self-contained in
`games/<id>/` and has its own `CLAUDE.md` with game-specific architecture and
conventions — read that before working on a game.

Plain vanilla JS ES modules — **no build step, no framework, no npm dependencies.**
A game that needs a library loads a pinned CDN build through an import map in its
`index.html` (see `games/spell-draft-duel/`).

## Commands

```bash
npm start              # serve all games; hub at http://localhost:5173/
npm start <game>       # serve + open one game, e.g. `npm start spell` (unique id prefix ok)
npm run games          # list available games
npm test               # run every game's tests
npm test <game>        # run one game's tests
```

## Layout

```
games/<id>/            one directory per game, served at /<id>/
  index.html           required — its presence is what makes it a game
  game.json            optional { "name", "description" } shown in the hub
  test/*.test.js       optional — picked up by `npm test`
scripts/games.js       game discovery (listGames / findGame)
scripts/play.js        zero-dep static server + hub page + browser launcher
scripts/test.js        test runner across games
```

## Adding a game

Create `games/<id>/index.html` (plus `game.json` for a nice hub entry). It shows
up in the hub, `npm run games`, and `npm start <id>` automatically — no registry
to update. Games are served under `/<id>/`, so use **relative** asset paths
(`css/x.css`, not `/css/x.css`). Tests are plain Node scripts that exit non-zero
on failure; the root `package.json` sets `"type": "module"` for all of them.
