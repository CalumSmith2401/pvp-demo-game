// Controller / state machine: owns the DOM, the turn timer and the bot's pacing.
// It talks to the match only through the authoritative layer's public API
// (view / place / timeout / result), the same surface a networked client would get.
import { GAME_NAME, TURN_SECONDS, VARIANTS, buildVariant } from './config.js';
import { createMatch } from './match.js';
import { BOTS, getBot } from './bots.js';
import { mulberry32 } from './rng.js';
import { Table } from './table.js';

const ME = 'a';
const RIVAL = 'b';

const state = {
  variantId: 'classic',
  botId: 'grinder',
  variant: null,
  bot: null,
  botCtx: null,
  match: null,
  run: 0,          // bumped whenever a match starts or is abandoned; stale timers check it
  timer: null,
  botTimer: null,
  botMove: null,
};

let table = null;
const $ = (sel) => document.querySelector(sel);
const SCREENS = ['menu', 'play', 'end'];
function show(name) {
  SCREENS.forEach((s) => $('#' + s).classList.toggle('hidden', s !== name));
  document.body.classList.toggle('in-match', name !== 'menu'); // the title only heads the menu
}
const say = (msg) => { $('#live').textContent = msg; };

// ---------- menu ----------
function renderOptions(listSel, items, selectedId, onPick, body) {
  const list = $(listSel);
  list.innerHTML = '';
  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.setAttribute('aria-pressed', String(item.id === selectedId));
    btn.innerHTML = body(item);
    btn.onclick = () => onPick(item.id);
    list.appendChild(btn);
  });
}

function renderBots() {
  renderOptions('#bot-list', BOTS, state.botId, (id) => { state.botId = id; renderBots(); }, (bot) => {
    const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i < bot.tier ? 'on' : ''}"></i>`).join('');
    return `<div class="head"><strong>${bot.name}</strong><span class="tier" aria-label="Difficulty ${bot.tier} of 5">${pips}</span></div><span>${bot.blurb}</span>`;
  });
}

function renderVariants() {
  renderOptions('#variant-list', Object.values(VARIANTS), state.variantId, (id) => { state.variantId = id; renderVariants(); },
    (v) => `<strong>${v.name}</strong><span>${v.blurb}</span>`);
}

// ---------- match ----------
async function startMatch() {
  clearTimers();
  const run = ++state.run;
  const seed = (Math.random() * 1e9) | 0;
  state.variant = buildVariant(state.variantId);
  state.bot = getBot(state.botId);
  state.botCtx = { variant: state.variant, rand: mulberry32((seed ^ 0x85ebca6b) >>> 0) };
  state.match = createMatch({ seed, variant: state.variant });
  show('play');
  $('#skip-btn').classList.add('hidden');
  if (!table) {
    table = new Table($('#table'));
    table.onPlace = placeMine;
  }
  await table.start({ variant: state.variant, you: 'You', rival: state.bot.name, portrait: window.innerWidth < 620 });
  if (run !== state.run) return;
  $('#table').focus({ preventScroll: true });
  nextTurn();
}

function clearTimers() {
  clearInterval(state.timer);
  clearTimeout(state.botTimer);
  state.timer = state.botTimer = null;
}

// Run `fn` later unless the match it belongs to has been left.
function later(ms, fn) {
  const run = state.run;
  return setTimeout(() => { if (run === state.run) fn(); }, ms);
}

function nextTurn() {
  const { match, variant } = state;
  if (match.isFinished()) { startReveal(); return; }
  const view = match.view(ME);
  // The bot commits to its move from its own view now, before the player has acted,
  // and only "thinks" for show. It never sees the player's pending placement.
  state.botMove = state.bot.choose(match.view(RIVAL), state.botCtx);
  say(`Roll ${view.turn + 1} of ${view.turns}: ${view.roll.join(', ')}.`);
  const run = state.run;
  table.deal(view.roll, view.turn, () => {
    if (run !== state.run) return;
    startTimer();
    state.botTimer = later(900 + Math.random() * 2600, placeRival);
  });
}

function startTimer() {
  const total = TURN_SECONDS * 1000;
  const deadline = performance.now() + total;
  const run = state.run;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (run !== state.run) return;
    const left = deadline - performance.now();
    table.setTimer(Math.max(0, left / total));
    if (left <= 0) {
      const res = state.match.timeout(ME);
      if (res.ok) afterMine(state.variant.zones.findIndex((z) => z.id === res.zone), true, res);
    }
  }, 100);
}

// The table reports a tap / drop / number key on an open zone.
function placeMine(zoneIndex) {
  const res = state.match.place(ME, state.variant.zones[zoneIndex].id);
  if (res.ok) afterMine(zoneIndex, false, res);
}

function afterMine(zoneIndex, auto, res) {
  clearInterval(state.timer);
  const zone = state.variant.zones[zoneIndex];
  const roll = res.turnComplete ? lastEntry(ME).roll : state.match.view(ME).roll;
  const points = zone.score(roll);
  table.lockMine(zoneIndex, points, auto);
  say(`${auto ? 'Out of time. Placed' : 'Placed'} in ${zone.name} for ${points}.`);
  if (res.turnComplete) endTurn();
  else {
    // Don't keep the player waiting on a bot that is only pretending to think.
    clearTimeout(state.botTimer);
    state.botTimer = later(350 + Math.random() * 450, placeRival);
  }
}

function placeRival() {
  const res = state.match.place(RIVAL, state.variant.zones[state.botMove].id);
  if (!res.ok) return;
  table.rivalLocked();
  if (res.turnComplete) endTurn();
}

const lastEntry = (player) => state.match.log().filter((e) => e.player === player).pop();

// Both placements are in: show where the rival's dice went, then deal again.
function endTurn() {
  clearTimers();
  later(650, () => {
    const e = lastEntry(RIVAL);
    table.revealRival(state.variant.zones.findIndex((z) => z.id === e.zone), e.roll);
    later(800, nextTurn);
  });
}

// ---------- reveal & end ----------
function startReveal() {
  const run = state.run;
  $('#skip-btn').classList.remove('hidden');
  say('All rolls placed. Scoring the zones.');
  table.reveal(state.match.result(), () => { if (run === state.run) endMatch(); });
}

const diceHTML = (roll) => (roll
  ? `<span class="dice" aria-label="rolled ${roll.join(', ')}">${roll.map((d) => `<b class="${d === 1 || d === 4 ? 'red' : ''}">${d}</b>`).join('')}</span>`
  : '');

function endMatch() {
  const { match, bot } = state;
  const r = match.result();
  table.stop();
  show('end');

  const [title, cls] = { a: ['You win', 'win'], b: [`${bot.name} wins`, 'lose'], draw: ['Draw', 'draw'] }[r.result];
  const sub = r.tiebreak
    ? `Level on ${r.totalA} points. Decided on zones won, ${r.zonesWonA} to ${r.zonesWonB}.`
    : `${r.totalA} points to ${r.totalB}.`;
  $('#result').className = 'result ' + cls;
  $('#result').innerHTML = `<div class="result-title">${title}</div><div class="result-sub">${sub}</div>`;
  say(`${title}. ${sub}`);

  const auto = new Set(match.log().filter((e) => e.player === ME && e.auto).map((e) => e.zone));
  const side = (z, key) => `${diceHTML(z[key].roll)}<span class="pts">${z[key].points}</span>`;
  const rows = r.zones.map((z) => `
    <tr>
      <td class="zone">${z.name}${auto.has(z.zone) ? '<span class="flag">timed out</span>' : ''}</td>
      <td class="num ${z.winner === 'a' ? 'won' : z.winner === 'b' ? 'lost' : ''}">${side(z, 'a')}</td>
      <td class="num rival ${z.winner === 'b' ? 'won' : z.winner === 'a' ? 'lost' : ''}">${side(z, 'b')}</td>
      <td class="num">${z.totalA} – ${z.totalB}</td>
    </tr>`).join('');
  $('#log').innerHTML = `
    <table class="log">
      <thead><tr><th>Zone</th><th class="num">You</th><th class="num">${bot.name}</th><th class="num">Running</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Zones won</td><td class="num">${r.zonesWonA}</td><td class="num">${r.zonesWonB}</td><td></td></tr></tfoot>
    </table>`;
  $('#audit').textContent = `Match seed ${match.audit().seed}. Both players were dealt the same eight rolls from it.`;
}

function leaveMatch() {
  state.run++;
  clearTimers();
  if (table) table.stop();
  show('menu');
}

// ---------- wiring ----------
document.title = GAME_NAME;
$('#title').textContent = GAME_NAME;
$('#turn-seconds').textContent = TURN_SECONDS;
$('#start-btn').onclick = startMatch;
$('#rematch-btn').onclick = startMatch;
$('#menu-btn').onclick = leaveMatch;
$('#quit-btn').onclick = leaveMatch;
$('#skip-btn').onclick = () => table.skip();
document.addEventListener('keydown', (e) => {
  if ($('#play').classList.contains('hidden') || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) table.tryPlace(n - 1);
});
renderBots();
renderVariants();
show('menu');
