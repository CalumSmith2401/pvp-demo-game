import { mulberry32 } from './rng.js';
import { buildPool, makeSequence, SEASONS } from './spells.js';
import { resolveCombat, START_HP } from './combat.js';
import { chooseSlot } from './ai.js';
import { Arena } from './arena.js';

let arena = null;

const SLOTS = 8;
const SEQ_LEN = 8;

const state = {
  seasonId: 'classic',
  seed: 0,
  sequence: [],
  cardIndex: 0,
  playerBuild: Array(SLOTS).fill(null),
  aiBuild: Array(SLOTS).fill(null),
  combat: null,
  autoOn: false,
};

const $ = (sel) => document.querySelector(sel);
const SCREENS = ['menu', 'draft', 'lock', 'combat', 'end'];
function show(name) {
  SCREENS.forEach((s) => $('#' + s).classList.toggle('hidden', s !== name));
}

// ---------- shared card rendering ----------
function cardHTML(spell, big) {
  const meta = `${spell.type}${spell.value != null ? ` · ${spell.value}` : ''}${spell.duration ? ` · ${spell.duration}t` : ''}`;
  return `
    <div class="card-icon">${spell.icon}</div>
    <div class="card-name">${spell.name}</div>
    <div class="card-type type-${spell.type}">${meta}</div>
    ${big ? `<div class="card-desc">${spell.desc}</div>` : ''}`;
}

// ---------- menu ----------
function renderSeasons() {
  const list = $('#season-list');
  list.innerHTML = '';
  Object.values(SEASONS).forEach((season) => {
    const btn = document.createElement('button');
    btn.className = 'season' + (season.id === state.seasonId ? ' selected' : '');
    btn.innerHTML = `<strong>${season.name}</strong><span>${season.blurb}</span>`;
    btn.onclick = () => {
      state.seasonId = season.id;
      renderSeasons();
    };
    list.appendChild(btn);
  });
}

function startMatch(newSeed = true) {
  if (newSeed) state.seed = (Math.random() * 1e9) | 0;
  const rand = mulberry32(state.seed);
  const pool = buildPool(state.seasonId);
  state.sequence = makeSequence(pool, SEQ_LEN, rand);
  state.cardIndex = 0;
  state.playerBuild = Array(SLOTS).fill(null);
  state.aiBuild = Array(SLOTS).fill(null);
  state.combat = null;
  show('draft');
  renderDraft();
}

// ---------- draft ----------
function renderDraft() {
  const card = state.sequence[state.cardIndex];
  $('#card-num').textContent = state.cardIndex + 1;
  $('#card-total').textContent = SEQ_LEN;
  $('#current-card').innerHTML = cardHTML(card, true);
  renderPlayerGrid();
}

function renderPlayerGrid() {
  const grid = $('#player-grid');
  grid.innerHTML = '';
  state.playerBuild.forEach((spell, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (spell ? ' filled' : ' empty');
    if (spell) {
      slot.innerHTML = `<div class="slot-num">${i + 1}</div>${cardHTML(spell, false)}`;
    } else {
      slot.innerHTML = `<div class="slot-num">${i + 1}</div><div class="slot-plus">+</div>`;
      slot.onclick = () => placeCard(i);
    }
    grid.appendChild(slot);
  });
}

function placeCard(slotIndex) {
  const card = state.sequence[state.cardIndex];
  state.playerBuild[slotIndex] = card;
  // The AI drafts the very same card into its own hidden build, no lookahead.
  state.aiBuild[chooseSlot(card, state.aiBuild)] = card;

  state.cardIndex++;
  if (state.cardIndex >= SEQ_LEN) lockAndFight();
  else renderDraft();
}

// ---------- lock ----------
function lockAndFight() {
  show('lock');
  setTimeout(() => {
    state.combat = resolveCombat(state.playerBuild, state.aiBuild, { a: 'You', b: 'Opponent' });
    startCombat();
  }, 1400);
}

// ---------- combat ----------
function appendLog(ev) {
  const line = document.createElement('div');
  line.className = `log-line log-${ev.actor} kind-${ev.kind}`;
  line.textContent = ev.text;
  const log = $('#combat-log');
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function startCombat() {
  show('combat');
  $('#combat-log').innerHTML = '';
  state.autoOn = false;
  if (!arena) arena = new Arena($('#arena'));
  arena.onLog = appendLog;
  arena.start(state.combat.events, { a: 'You', b: 'Opponent', maxHp: START_HP });
  $('#step-btn').textContent = 'Next ▶';
  $('#step-btn').onclick = manualStep;
  $('#auto-btn').textContent = 'Auto-play';
  $('#auto-btn').onclick = toggleAuto;
}

function manualStep() {
  if (state.autoOn || arena.isBusy) return;
  if (arena.atEnd()) { endMatch(); return; }
  arena.step(() => {
    if (arena.atEnd()) $('#step-btn').textContent = 'View Result ▶';
  });
}

function autoLoop() {
  if (!state.autoOn) return;
  if (arena.isBusy) { setTimeout(autoLoop, 80); return; }
  if (arena.atEnd()) { stopAuto(); setTimeout(endMatch, 450); return; }
  arena.step(() => { if (state.autoOn) setTimeout(autoLoop, 150); });
}

function stopAuto() {
  state.autoOn = false;
  $('#auto-btn').textContent = 'Auto-play';
}

function toggleAuto() {
  if (state.autoOn) { stopAuto(); return; }
  state.autoOn = true;
  $('#auto-btn').textContent = 'Pause';
  autoLoop();
}

// ---------- end ----------
function endMatch() {
  stopAuto();
  if (arena) arena.stop();
  show('end');
  renderEnd();
}

function renderEnd() {
  const c = state.combat;
  const last = c.events.length ? c.events[c.events.length - 1].state : { hpA: START_HP, hpB: START_HP };
  const map = { a: ['Victory', 'win'], b: ['Defeat', 'lose'], draw: ['Draw', 'draw'] };
  const [title, cls] = map[c.result];
  const resultEl = $('#result');
  resultEl.className = 'result ' + cls;
  resultEl.innerHTML = `<div class="result-title">${title}</div>
    <div class="result-sub">You ${Math.max(0, last.hpA)} HP · Opponent ${Math.max(0, last.hpB)} HP</div>`;

  $('#builds-compare').innerHTML = `
    <div class="compare-col"><h4>Your Build</h4>${buildGridHTML(state.playerBuild)}</div>
    <div class="compare-col"><h4>Opponent Build</h4>${buildGridHTML(state.aiBuild)}</div>`;
}

function buildGridHTML(build) {
  return (
    '<div class="grid small">' +
    build
      .map((s, i) => `<div class="slot filled"><div class="slot-num">${i + 1}</div>${cardHTML(s, false)}</div>`)
      .join('') +
    '</div>'
  );
}

// ---------- wiring ----------
$('#start-btn').onclick = () => startMatch(true);
$('#rematch-btn').onclick = () => startMatch(true);
$('#menu-btn').onclick = () => show('menu');
renderSeasons();
show('menu');
