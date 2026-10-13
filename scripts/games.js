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
