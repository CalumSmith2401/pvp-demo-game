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
import { GAMES_DIR, listGames, findGame, printGames } from './games.js';

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

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function hubHTML() {
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
