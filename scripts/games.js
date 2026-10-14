// Game discovery. A game is any directory under games/ that has an index.html.
// Optional games/<id>/game.json supplies { "name", "description" } for the hub.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GAMES_DIR = join(ROOT, 'games');

export function listGames() {
  return readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(GAMES_DIR, d.name, 'index.html')))
    .map((d) => {
      const metaPath = join(GAMES_DIR, d.name, 'game.json');
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
      return { id: d.name, name: meta.name || d.name, description: meta.description || '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Exact id match first, then a unique prefix ("spell" → spell-draft-duel).
export function findGame(query) {
  const games = listGames();
  const exact = games.find((g) => g.id === query);
  if (exact) return exact;
  const matches = games.filter((g) => g.id.startsWith(query));
  return matches.length === 1 ? matches[0] : null;
}

export function printGames(games = listGames()) {
  const width = Math.max(...games.map((g) => g.id.length));
  for (const g of games) console.log(`  ${g.id.padEnd(width)}  ${g.description || g.name}`);
}

// The hub page: a card per game. Served at / by the dev server (play.js) and
// written to games/index.html for static hosting (build.js).
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function hubHTML() {
  const cards = listGames()
    .map((g) => `<a class="game" href="/${g.id}/"><h2>${escape(g.name)}</h2><p>${escape(g.description)}</p></a>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Games</title>
<style>
  :root { --bg:#14110d; --panel:#1f1a14; --border:#5a4630; --gold:#d4a84b; --text:#e8dcc4; --muted:#a8987c; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui, sans-serif; }
  main { max-width:720px; margin:0 auto; padding:48px 16px; }
  h1 { color:var(--gold); font-family:Georgia, serif; letter-spacing:.04em; }
  .game { display:block; margin:16px 0; padding:16px 20px; background:var(--panel); color:inherit;
          text-decoration:none; border:1px solid var(--border);
          box-shadow: inset 0 0 0 2px #0008, inset 0 0 0 3px #ffffff0d; }
  .game:hover { border-color:var(--gold); }
  .game h2 { margin:0 0 6px; font-family:Georgia, serif; color:var(--gold); font-size:1.2rem; }
  .game p { margin:0; color:var(--muted); }
</style>
</head>
<body><main><h1>Games</h1>
${cards}
</main></body>
</html>`;
}
