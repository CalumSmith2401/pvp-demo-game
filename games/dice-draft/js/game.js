// Controller / state machine: owns the DOM, the turn timer, the bot's pacing, and
// what the player's taps mean (which roll is in hand, which power-ups are armed).
// It talks to the match only through the authoritative layer's public API
// (view / act / peek / result), the same surface a networked client would get.
import { GAME_NAME, MATCH_SECONDS, CLOCK_WARNING_SECONDS, POWERS, buildVariant } from './config.js';
import { createMatch, zoneAverages } from './match.js';
import { applyAction, openZones } from './engine.js';
import { createSolver } from './solver.js';
import { BOTS, getBot } from './bots.js';
import { mulberry32 } from './rng.js';
import { Table } from './table.js';
import { loadSounds, play, isMuted, setMuted } from './sound.js';

const ME = 'a';
const RIVAL = 'b';

const state = {
  botId: 'grinder',
  variant: null,
  bot: null,
  botCtx: null,
  match: null,
  run: 0,          // bumped whenever a match starts or is abandoned; stale timers check it
  timer: null,
  botTimer: null,
  turn: null,      // what the player has set up this turn (see newTurn)
  clock: 0,        // milliseconds of thinking time the player has left this match
  ticked: null,    // the last whole second the clock ticked aloud
};

let table = null;
const $ = (sel) => document.querySelector(sel);
const SCREENS = ['menu', 'setup', 'play', 'end'];
function show(name) {
  SCREENS.forEach((s) => $('#' + s).classList.toggle('hidden', s !== name));
  document.body.classList.toggle('playing', name === 'play'); // the play screen fills the viewport and never scrolls
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

// How to play, written from the live config so it can't drift from the rules.
function renderHowTo() {
  const v = buildVariant();
  const powers = v.powers.map((p) => `<li><strong>${POWERS[p].name}:</strong> ${POWERS[p].blurb}</li>`).join('');
  $('#howto-body').innerHTML = `
    <ol>
      <li>Each turn, two rolls are thrown. You and your rival see the same two. Pick one and tap an empty zone to place it. It stays there.</li>
      <li>Each zone pays by its own rule, printed on it. The eight zones are dealt fresh every match.</li>
      <li>One die in each roll is gold: it adds its number to whatever the roll scores. The Hot zone pays double.</li>
      <li>Score on turn after turn to build a streak. Each scoring placement in a row adds ${v.streak.step} more, up to ${v.streak.step * v.streak.cap}. A blank resets it.</li>
      <li>Score in all of zones 1–4, or all of zones 5–8, for a ${v.sweep}-point sweep.</li>
      <li>Your rival's move stays hidden until you have both locked in. You have ${MATCH_SECONDS / 60 === Math.floor(MATCH_SECONDS / 60) ? `${MATCH_SECONDS / 60} minutes` : `${MATCH_SECONDS} seconds`} of thinking time for the whole match. The clock only runs while it is your move. Run out and the rest of your rolls are placed for you.</li>
      <li>At the end the zones are scored one by one. Winning a zone outright is worth ${v.bounty} more. Higher total wins.</li>
    </ol>
    <h3>Power-ups, once each per match</h3>
    <ul>${powers}</ul>`;
}

// ---------- match ----------
async function startMatch() {
  clearTimers();
  const run = ++state.run;
  const seed = (Math.random() * 1e9) | 0;
  state.variant = buildVariant();
  state.bot = getBot(state.botId);
  state.match = createMatch({ seed, variant: state.variant });
  state.clock = MATCH_SECONDS * 1000;
  // The stronger bots need this table solved. It takes a few hundred milliseconds,
  // so it is done in slices while the table deals itself in.
  const solver = state.bot.needsSolver ? createSolver(state.variant, state.match.table) : null;
  state.botCtx = { variant: state.variant, table: state.match.table, solver, rand: mulberry32((seed ^ 0x85ebca6b) >>> 0) };
  if (solver) (function pump() { if (run === state.run && !solver.step(6)) setTimeout(pump, 0); })();
  show('play');
  $('#skip-btn').classList.add('hidden');
  buildHud();
  await table.start({ variant: state.variant, table: state.match.table, you: 'You', rival: state.bot.name, portrait: window.innerWidth < 620 });
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

const view = () => state.match.view(ME);
const lastTurn = (v) => v.turn === v.turns - 1;

// What the player has set up so far this turn. Nothing here reaches the match
// until a roll is placed (or held): that one action carries all of it.
const newTurn = (v) => ({
  sel: v.offers.length === 1 ? 0 : null, // the roll in hand: an offer index, 'held', or null
  flip: null,       // { group, die } turned over with Flip
  flipMode: false,  // Flip pressed, waiting for a die
  double: false,    // Double armed for the next placement
  stage: null,      // { zone, double }: the held roll, already put in a zone this turn
  locked: false,
});

function nextTurn() {
  const { match } = state;
  if (match.isFinished()) { startReveal(); return; }
  const v = view();
  state.turn = newTurn(v);
  table.setHeld(v.held);
  updateHud();
  say(`Roll ${v.turn + 1} of ${v.turns}. ${v.offers.map((o, i) => `${v.offers.length > 1 ? `Roll ${'AB'[i]}: ` : ''}${o.dice.join(', ')}`).join('. ')}.`);
  const run = state.run;
  table.deal(v.offers, v.turn, () => {
    if (run !== state.run) return;
    table.setSelection(state.turn.sel);
    startTimer();
    state.botTimer = later(900 + Math.random() * 2600, placeRival);
  });
}

// The match clock ticks only while the player has a move to make: it starts when
// the dice have landed and stops the moment the turn is sent (see submit).
function startTimer() {
  const run = state.run;
  let last = performance.now();
  clearInterval(state.timer);
  showClock();
  if (state.clock <= 0) { later(500, timeOut); return; } // already out of time: this turn plays itself
  state.timer = setInterval(() => {
    if (run !== state.run) return;
    const now = performance.now();
    state.clock = Math.max(0, state.clock - (now - last));
    last = now;
    showClock();
    if (state.clock <= 0) timeOut();
  }, 100);
}

function showClock() {
  const secs = Math.ceil(state.clock / 1000);
  if (secs <= CLOCK_WARNING_SECONDS && secs > 0 && secs !== state.ticked) play('tick', { final: secs <= 5 });
  state.ticked = secs;
  table.setTimer(state.clock / (MATCH_SECONDS * 1000), {
    label: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
    urgent: secs <= CLOCK_WARNING_SECONDS,
  });
}

// Out of time for the match: the first roll goes into the least valuable open zone,
// no power-ups. Every turn after this one does the same as soon as it starts.
// (The same move match.timeout() makes; built here so a held roll already put in a
// zone this turn still counts.)
function timeOut() {
  const v = view(), t = state.turn;
  if (!t || t.locked) return;
  const avg = zoneAverages(state.variant, state.match.table);
  const zone = openZones(v.board).filter((z) => z !== t.stage?.zone).reduce((best, z) => (avg[z] < avg[best] ? z : best));
  if (t.flip) { table.flip(t.flip.group, t.flip.die); t.flip = null; }
  submit({ pick: 0, zone, held: t.stage, auto: true });
}

// ---------- the player's taps ----------
function selectRoll(source) {
  const t = state.turn, v = view();
  if (!t || t.locked) return;
  if (source === 'held' && (!v.held || t.stage)) return;
  if (t.flip && source !== t.flip.group) { table.flip(t.flip.group, t.flip.die); t.flip = null; } // a flip belongs to its roll
  if (t.sel !== source) play('grab');
  t.sel = source;
  table.setSelection(source);
  updateHud();
}

function tapDie(group, die) {
  const t = state.turn;
  if (!t || t.locked) return;
  if (!t.flipMode) { selectRoll(group); return; }
  if (t.flip) table.flip(t.flip.group, t.flip.die); // only one die can be flipped: put the last one back
  t.flip = { group, die };
  t.flipMode = false;
  t.sel = group;
  table.flip(group, die);
  table.setFlipMode(false);
  table.setSelection(group);
  updateHud();
}

function tapZone(zone) {
  const t = state.turn;
  if (!t || t.locked) return;
  if (t.sel == null) { table.nudge('Pick a roll first'); return; }
  if (t.sel === 'held') { // the held roll goes down now; the turn locks when this turn's roll is placed too
    t.stage = { zone, double: t.double };
    t.double = false;
    t.sel = view().offers.length === 1 ? 0 : null;
    table.stageHeld(zone);
    table.setSelection(t.sel);
    updateHud();
    return;
  }
  if (zone === t.stage?.zone) return;
  submit({ pick: t.sel, flip: t.flip?.group === t.sel ? t.flip.die : null, zone, double: t.double, held: t.stage });
}

const POWER_ACTIONS = {
  flip() {
    const t = state.turn;
    if (t.flip) { table.flip(t.flip.group, t.flip.die); t.flip = null; } else { t.flipMode = !t.flipMode; play(t.flipMode ? 'power' : 'unpower'); }
    table.setFlipMode(t.flipMode);
  },
  double() { state.turn.double = !state.turn.double; play(state.turn.double ? 'power' : 'unpower'); },
  hold() {
    const t = state.turn;
    if (typeof t.sel !== 'number') { table.nudge('Pick the roll you want to hold'); return; }
    submit({ pick: t.sel, flip: t.flip?.group === t.sel ? t.flip.die : null, hold: true });
  },
  peek() {
    const res = state.match.peek(ME);
    if (res.ok) { table.showNext(res.next); say(`Next turn: ${res.next.map((o) => o.dice.join(', ')).join(' or ')}.`); }
  },
};

function usePower(id) {
  const t = state.turn;
  if (!t || t.locked || !powerState(id).enabled) return;
  POWER_ACTIONS[id]();
  updateHud();
}

// Send this turn's action to the match and show what it did.
function submit(action) {
  const before = view();
  const res = state.match.act(ME, action);
  if (!res.ok) { table.nudge('That move is not allowed'); return; }
  clearInterval(state.timer);
  state.turn.locked = true;
  // My own placements don't depend on the rival, so their points can be shown now:
  // replay the action on a copy of my state with the same rules the match uses.
  const me = { board: before.board.slice(), score: before.score, streak: before.streak, powers: { ...before.powers }, held: before.held, sweeps: before.sweeps.slice() };
  const landed = applyAction(state.variant, state.match.table, me, before.offers, action, before.turn, lastTurn(before));
  if (action.hold) {
    table.hold(action.pick);
    say('Roll held for a later turn.');
  } else {
    table.lockMine(action.pick, landed, !!action.auto);
    say(`${action.auto ? 'Out of time. ' : ''}${landed.map((e) => `${state.match.table.zones[e.zone].name}: ${e.total}`).join('. ')}.${landed.some((e) => e.sweep) ? ' Sweep!' : ''}`);
  }
  updateHud(me);
  if (res.turnComplete) endTurn();
  else {
    // Don't keep the player waiting on a bot that is only pretending to think.
    clearTimeout(state.botTimer);
    state.botTimer = later(350 + Math.random() * 450, placeRival);
  }
}

// ---------- the rival ----------
// The bot decides from its own view, which never includes the player's pending
// action, so it makes no difference when in the turn it is asked.
function placeRival() {
  const { match, bot, botCtx } = state;
  if (bot.needsSolver && !botCtx.solver.done) { state.botTimer = later(40, placeRival); return; }
  let action = bot.choose(match.view(RIVAL), botCtx);
  if (action.peek) { match.peek(RIVAL); action = bot.choose(match.view(RIVAL), botCtx); }
  const res = match.act(RIVAL, action);
  if (!res.ok) return;
  table.rivalLocked();
  if (res.turnComplete) endTurn();
}

// Both actions are in: show where the rival's dice went, then deal again.
function endTurn() {
  clearTimers();
  later(1000, () => {
    const v = view();
    const turn = v.turn - 1;
    const landed = v.oppBoard.filter((e) => e && e.turn === turn).sort((x, y) => (y.heldFrom != null) - (x.heldFrom != null));
    table.revealRival(landed, !!v.oppHeld);
    later(850 + landed.length * 200, nextTurn);
  });
}

// ---------- the HUD under the table: power-ups, streak, sweeps ----------
const ICONS = {
  flip: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/>',
  double: '<path d="M5 7l6 10M11 7L5 17M14 9a2.5 2.5 0 1 1 4 2l-4 6h5"/>',
  hold: '<path d="M8 11V6a1.5 1.5 0 0 1 3 0v4M11 10V5a1.5 1.5 0 0 1 3 0v5M14 10V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.4-1.8L8 14"/>',
  peek: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.600 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
};

function buildHud() {
  const { variant } = state;
  $('#powers').classList.toggle('hidden', !variant.powers.length);
  $('#powers').innerHTML = variant.powers.map((id) => `
    <button class="power" data-power="${id}" title="${POWERS[id].blurb}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg><span>${POWERS[id].name}</span>
    </button>`).join('');
  for (const btn of document.querySelectorAll('.power')) btn.onclick = () => usePower(btn.dataset.power);
}

// Whether a power-up can be pressed right now, and how its button should read.
function powerState(id, v = view()) {
  const t = state.turn || {};
  const have = !!v.powers[id];
  const idle = have && !t.locked && v.status === 'placing';
  if (id === 'flip') return { used: !have, enabled: idle, on: !!t.flipMode || !!t.flip, label: t.flip ? 'Unflip' : t.flipMode ? 'Tap a die' : POWERS.flip.name };
  if (id === 'double') return { used: !have, enabled: idle && !t.stage?.double, on: !!t.double || !!t.stage?.double, label: POWERS.double.name };
  if (id === 'hold') return { used: !have, enabled: idle && !v.held && !t.stage && !lastTurn(v), on: false, label: POWERS.hold.name };
  return { used: !have, enabled: idle && !lastTurn(v), on: false, label: POWERS.peek.name };
}

// `me` is the player's state after the action just sent, when the match has not
// committed the turn yet; otherwise the match's own view is used.
function updateHud(me) {
  const { variant, match } = state;
  const v = view();
  const mine = me || v;
  for (const btn of document.querySelectorAll('.power')) {
    const s = powerState(btn.dataset.power, me ? { ...v, powers: me.powers, held: me.held } : v);
    btn.disabled = !s.enabled;
    btn.classList.toggle('used', s.used);
    btn.setAttribute('aria-pressed', String(s.on));
    btn.querySelector('span').textContent = s.used ? 'Used' : s.label;
  }
  const facts = [];
  if (variant.streak.step) {
    const next = mine.streak ? Math.min(mine.streak, variant.streak.cap) * variant.streak.step : 0;
    facts.push(`<span class="${mine.streak ? 'good' : ''}">Streak ${mine.streak}${next ? ` (+${next} next)` : ''}</span>`);
  }
  match.table.sets.forEach((set, s) => {
    const name = `Sweep ${set[0] + 1}–${set[set.length - 1] + 1}`;
    const filled = set.filter((z) => mine.board[z]);
    if (mine.sweeps[s]) facts.push(`<span class="good">${name}: +${variant.sweep}</span>`);
    else if (filled.some((z) => mine.board[z].base === 0)) facts.push(`<span class="lost">${name}: missed</span>`);
    else facts.push(`<span>${name}: ${filled.length}/${set.length}</span>`);
  });
  $('#facts').innerHTML = facts.join('');
}

// ---------- reveal & end ----------
function startReveal() {
  const run = state.run;
  $('#skip-btn').classList.remove('hidden');
  state.turn = null;
  for (const btn of document.querySelectorAll('.power')) btn.disabled = true;
  say('All rolls placed. Scoring the zones.');
  table.reveal(state.match.result(), () => { if (run === state.run) endMatch(); });
}

const diceHTML = (e) => (e
  ? `<span class="dice" aria-label="rolled ${e.dice.join(', ')}">${e.dice.map((d, k) => `<b class="${e.gold === k ? 'gold' : d === 1 || d === 4 ? 'red' : ''}">${d}</b>`).join('')}</span>`
  : '');

function tagsHTML(e, bounty) {
  const tags = [];
  if (e?.goldPts) tags.push(`+${e.goldPts} gold`);
  if (e && e.mult > 1) tags.push(`×${e.mult}`);
  if (e?.streakBonus) tags.push(`+${e.streakBonus} streak`);
  if (e?.flipped != null) tags.push('flipped');
  if (e?.auto) tags.push('timed out');
  if (bounty) tags.push(`+${bounty} bounty`);
  return tags.length ? `<small>${tags.join(', ')}</small>` : '';
}

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

  const side = (s, cls2, won, lost) => `<td class="num ${cls2} ${won ? 'won' : lost ? 'lost' : ''}">${diceHTML(s.entry)}<span class="pts">${s.points}</span>${tagsHTML(s.entry, s.bounty)}</td>`;
  const rows = r.steps.map((s) => (s.type === 'zone' ? `
    <tr>
      <td class="zone">${s.name}${s.hot ? '<small class="hot">hot</small>' : ''}</td>
      ${side(s.a, '', s.winner === 'a', s.winner === 'b')}
      ${side(s.b, 'rival', s.winner === 'b', s.winner === 'a')}
      <td class="num">${s.totalA} – ${s.totalB}</td>
    </tr>` : `
    <tr class="sweep">
      <td class="zone">Sweep</td>
      <td class="num"><span class="pts">${s.a ? `+${s.a}` : '–'}</span></td>
      <td class="num rival"><span class="pts">${s.b ? `+${s.b}` : '–'}</span></td>
      <td class="num">${s.totalA} – ${s.totalB}</td>
    </tr>`)).join('');
  $('#log').innerHTML = `
    <table class="log">
      <thead><tr><th>Zone</th><th class="num">You</th><th class="num">${bot.name}</th><th class="num">Running</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Zones won</td><td class="num">${r.zonesWonA}</td><td class="num">${r.zonesWonB}</td><td></td></tr></tfoot>
    </table>`;
  $('#audit').textContent = `Match seed ${match.audit().seed}. Both players were dealt the same table and the same rolls from it.`;
}

// Abandon whatever is running and go to `screen`.
function leaveMatch(screen) {
  state.run++;
  state.turn = null;
  clearTimers();
  if (table) table.stop();
  show(screen);
}

// ---------- wiring ----------
document.title = GAME_NAME;
// The menu title sits on two balanced lines: "Bad to" / "the Bone".
const words = GAME_NAME.split(' ');
const half = Math.ceil(words.length / 2);
$('#title').innerHTML = words.length > 1 ? `${words.slice(0, half).join(' ')}<br>${words.slice(half).join(' ')}` : GAME_NAME;
$('#start-btn').onclick = startMatch;
$('#rematch-btn').onclick = startMatch;
$('#play-btn').onclick = () => show('setup');
$('#back-btn').onclick = () => show('menu');
$('#howto-btn').onclick = () => $('#howto-dialog').showModal();
$('#tutorial-btn').onclick = () => $('#tutorial-dialog').showModal(); // placeholder until the tutorial exists
$('#menu-btn').onclick = () => leaveMatch('setup');
$('#quit-btn').onclick = () => leaveMatch('menu');
$('#skip-btn').onclick = () => table.skip();
// The sound switch appears on the menu and under the table; both show the same state.
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z"/>';
function renderSound() {
  const on = !isMuted();
  for (const btn of document.querySelectorAll('.sound-btn')) {
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Sound on' : 'Sound off';
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}${on ? '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>' : '<path d="M17 9.5l5 5M22 9.5l-5 5"/>'}</svg>`;
  }
}
for (const btn of document.querySelectorAll('.sound-btn')) btn.onclick = () => { setMuted(!isMuted()); renderSound(); };
renderSound();
const KEYS = { f: 'flip', d: 'double', h: 'hold', p: 'peek' };
document.addEventListener('keydown', (e) => {
  if ($('#play').classList.contains('hidden') || !state.turn || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) { if (!view().board[n - 1] && n <= view().board.length) tapZone(n - 1); }
  else if (key === 'a' || key === 'arrowleft') selectRoll(0);
  else if ((key === 'b' || key === 'arrowright') && view().offers?.length > 1) selectRoll(1);
  else if (key === 'x' && view().held) selectRoll('held');
  else if (KEYS[key] && state.variant.powers.includes(KEYS[key])) usePower(KEYS[key]);
});
renderBots();
renderHowTo();
show('menu');
// The table boots and fetches its artwork behind the menu, so it is ready by the
// time a match starts.
table = new Table($('#table'));
loadSounds();
table.onSelect = selectRoll;
table.onDie = tapDie;
table.onZone = tapZone;
