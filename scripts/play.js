// Zero-dependency static server for every game under games/. ES-module games
// won't load over file://, which is why this exists.
//
//   npm start                 serve all games; hub at http://localhost:5173/
//   npm start <game>          same server, and open that game in the browser
//   npm run games             list available games
//
// <game> may be a unique prefix of the id, e.g. `npm start spell`.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { GAMES_DIR, findGame, printGames, hubHTML } from './games.js';

const PORT = process.env.PORT || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const args = process.argv.slice(2);

if (args.includes('--list')) {
  printGames();
  process.exit(0);
}

let target = null;
if (args[0]) {
  target = findGame(args[0]);
  if (!target) {
    console.error(`Unknown game "${args[0]}". Available games:`);
    printGames();
    process.exit(1);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      return res.end(hubHTML());
    }
    let filePath = normalize(join(GAMES_DIR, url));
    if (!filePath.startsWith(GAMES_DIR + sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if ((await stat(filePath)).isDirectory()) {
      // Games use relative asset paths, so /<game> must become /<game>/.
      if (!url.endsWith('/')) {
        res.writeHead(301, { Location: url + '/' });
        return res.end();
      }
      filePath = join(filePath, 'index.html');
    }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  if (target) {
    const url = `${base}/${target.id}/`;
    console.log(`${target.name} → ${url}`);
    openBrowser(url);
  } else {
    console.log(`Game hub → ${base}/`);
    printGames();
  }
});
