// Static-hosting build: writes the hub page to games/index.html so the games/
// directory can be served as-is by any static host (see vercel.json). The dev
// server (play.js) generates the same page on the fly and never reads this file.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAMES_DIR, hubHTML, printGames } from './games.js';

writeFileSync(join(GAMES_DIR, 'index.html'), hubHTML());
console.log('Wrote games/index.html for:');
printGames();
