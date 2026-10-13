// All tunable game data lives here: the title, the zone pay table, and the named
// variants (seasonal pay tables / game modes). Rebalancing or rotating a season
// is a data change in this file — nothing else hardcodes a point value.

export const GAME_NAME = 'Dice Draft'; // working title; the only place it is spelled out

export const TURN_SECONDS = 20;        // per-roll placement timer
// Equal totals: the player who won more individual zones takes it. Still a draw
// if that is level too.
export const TIEBREAK_ZONES_WON = true;

// ---------- roll helpers ----------
export const sum = (r) => r.reduce((a, b) => a + b, 0);
export const count = (r, face) => r.reduce((n, d) => n + (d === face ? 1 : 0), 0);
const allMatch = (r) => r.every((d) => d === r[0]);
const hasPair = (r) => new Set(r).size < r.length;
// The (highest) face that appears at least twice.
const pairFace = (r) => Math.max(...r.filter((d, i) => r.indexOf(d) !== i));
function isRun(r) {
  const s = [...r].sort((a, b) => a - b);
  return s.every((d, i) => i === 0 || d === s[i - 1] + 1);
}

// ---------- rule library ----------
// Each rule scores a roll from the zone's `pay` params, and describes itself in
// plain English. Rules are written for any dice count: "low/high" split around
// the midpoint (3.5 per die), "set" means every die matches.
const mid = (r) => 3.5 * r.length;
const RULES = {
  low: {
    score: (r, p) => (sum(r) < mid(r) && !allMatch(r) ? p.base + (Math.ceil(mid(r)) - 1 - sum(r)) * p.step : 0),
    rule: (p, n) => `Total ${n + 1}–${Math.ceil(3.5 * n) - 1}, no ${setWord(n)}`,
    hint: (p, n) => (p.base === p.step
      ? `${p.step} pts per pip under ${Math.ceil(3.5 * n)}`
      : `${p.base} pts, +${p.step} per pip under ${Math.ceil(3.5 * n) - 1}`),
    max: (p, n) => p.base + (Math.ceil(3.5 * n) - 2 - n) * p.step,
  },
  high: {
    score: (r, p) => (sum(r) > mid(r) && !allMatch(r) ? p.base + (sum(r) - Math.floor(mid(r)) - 1) * p.step : 0),
    rule: (p, n) => `Total ${Math.floor(3.5 * n) + 1}–${6 * n - 1}, no ${setWord(n)}`,
    hint: (p, n) => (p.base === p.step
      ? `${p.step} pts per pip over ${Math.floor(3.5 * n)}`
      : `${p.base} pts, +${p.step} per pip over ${Math.floor(3.5 * n) + 1}`),
    max: (p, n) => p.base + (6 * n - 2 - Math.floor(3.5 * n)) * p.step,
  },
  set: {
    score: (r, p) => (allMatch(r) ? p.points : 0),
    rule: (p, n) => `All ${n} dice match`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  pair: {
    score: (r, p) => (hasPair(r) ? p.points + pairFace(r) * p.perPip : 0),
    rule: () => 'Any two dice match',
    hint: (p) => (p.perPip ? `${p.points} pts + ${p.perPip} × the pair` : `${p.points} pts`),
    max: (p) => p.points + 6 * p.perPip,
  },
  run: {
    score: (r, p) => (isRun(r) ? p.points : 0),
    rule: (p, n) => `${n} in a row, e.g. ${Array.from({ length: n }, (_, i) => i + 2).join('-')}`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  face: {
    score: (r, p) => { const c = count(r, p.face); return c ? p.first + (c - 1) * p.extra : 0; },
    rule: (p) => `Each ${p.face} rolled`,
    hint: (p) => (p.first === p.extra ? `${p.first} pts per ${p.face}` : `${p.first} pts, +${p.extra} per extra ${p.face}`),
    max: (p, n) => p.first + (n - 1) * p.extra,
  },
  total: {
    score: (r, p) => Math.round(sum(r) * p.mult),
    rule: () => 'Any roll — never zero',
    hint: (p) => (p.mult === 1 ? 'Pays the total' : p.mult === 0.5 ? 'Pays half the total' : `Pays total × ${p.mult}`),
    max: (p, n) => Math.round(6 * n * p.mult),
  },
};
const setWord = (n) => (n === 2 ? 'double' : n === 3 ? 'triple' : 'set');

// ---------- the classic pay table ----------
// Reveal order is array order (Zone 1 → Zone 8). `celebrate` ranks how big a hit
// in that zone should feel (see table.js); it has no effect on scoring.
// These values are tuned — see BALANCE.md before changing them, and re-run
// `node sim/balance.js` after.
const CLASSIC_ZONES = [
  { id: 'small',    name: 'Small',    kind: 'low',   pay: { base: 2, step: 2 }, celebrate: 1 },
  { id: 'big',      name: 'Big',      kind: 'high',  pay: { base: 2, step: 2 }, celebrate: 1 },
  { id: 'triple',   name: 'Triple',   kind: 'set',   pay: { points: 30 }, celebrate: 3 },
  { id: 'double',   name: 'Double',   kind: 'pair',  pay: { points: 10, perPip: 0 }, celebrate: 1 },
  { id: 'straight', name: 'Straight', kind: 'run',   pay: { points: 15 }, celebrate: 2 },
  { id: 'sixes',    name: 'Sixes',    kind: 'face',  pay: { face: 6, first: 4, extra: 4 }, celebrate: 1 },
  { id: 'ones',     name: 'Ones',     kind: 'face',  pay: { face: 1, first: 4, extra: 4 }, celebrate: 1 },
  { id: 'total',    name: 'Total',    kind: 'total', pay: { mult: 1 }, celebrate: 1 },
];

// ---------- variants ----------
// A variant is a named game mode: dice per roll, rolls per match, and a pay table
// expressed as per-zone overrides of the classic one. Add an entry and it shows up
// in the menu, the simulator and the tests automatically.
export const VARIANTS = {
  classic: {
    id: 'classic', name: 'Classic', blurb: 'The standard table. Every zone pulls its weight.',
    dice: 3, rolls: 8, pay: {},
  },
  triples: {
    id: 'triples', name: 'Triples Season', blurb: 'Triple pays big. How long dare you hold it open?',
    dice: 3, rolls: 8, pay: { triple: { points: 50 } },
  },
  lowroller: {
    id: 'lowroller', name: 'Low Roller', blurb: 'Small and Ones are juiced. Low totals are gold.',
    dice: 3, rolls: 8, pay: { small: { base: 3, step: 3 }, ones: { first: 6, extra: 6 } },
  },
};

// Resolve a variant into playable zones: each gets a bound `score(roll)` plus the
// display strings generated from its (possibly overridden) pay values.
export function buildVariant(id = 'classic', overrides = {}) {
  const v = { ...(VARIANTS[id] || VARIANTS.classic), ...overrides };
  const zones = CLASSIC_ZONES.map((z, index) => {
    const pay = { ...z.pay, ...(v.pay[z.id] || {}) };
    const rule = RULES[z.kind];
    return {
      id: z.id, index, name: z.name, kind: z.kind, pay, celebrate: z.celebrate,
      rule: rule.rule(pay, v.dice),
      hint: rule.hint(pay, v.dice),
      max: rule.max(pay, v.dice),
      score: (roll) => rule.score(roll, pay),
    };
  });
  return { id: v.id, name: v.name, blurb: v.blurb, dice: v.dice, rolls: v.rolls, zones };
}
