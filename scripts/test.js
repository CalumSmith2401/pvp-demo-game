// Runs every games/<id>/test/*.test.js, or just one game's tests:
//   npm test               all games
//   npm test <game>        one game (unique id prefix ok)
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GAMES_DIR, listGames, findGame, printGames } from './games.js';

let games = listGames();
if (process.argv[2]) {
  const game = findGame(process.argv[2]);
  if (!game) {
    console.error(`Unknown game "${process.argv[2]}". Available games:`);
    printGames();
    process.exit(1);
  }
  games = [game];
}

let failed = false;
for (const game of games) {
  const testDir = join(GAMES_DIR, game.id, 'test');
  if (!existsSync(testDir)) continue;
  for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort()) {
    console.log(`\n[${game.id}] ${file}`);
    const { status } = spawnSync(process.execPath, [join(testDir, file)], { stdio: 'inherit' });
    if (status !== 0) failed = true;
  }
}
process.exit(failed ? 1 : 0);
