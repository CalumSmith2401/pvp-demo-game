// All tunable game data lives here: the title, the pool of zones and what they
// pay, the extras (power-ups, hot zone, golden die, streaks, sweeps, bounties) and
// the named variants. Rebalancing or rotating a season is a data change in this
// file — nothing else hardcodes a point value.

export const GAME_NAME = 'Bad to the Bone'; // the only place the code spells it out

// One clock for the whole match, per player. It only runs while that player has a
// decision to make (dice on the table, nothing locked in), so animations and the
// rival's thinking time are free. When it runs out, every turn still to come is
// placed automatically.
export const MATCH_SECONDS = 180;
export const CLOCK_WARNING_SECONDS = 15; // the tray starts pulsing below this
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
  parity: {
    score: (r, p) => r.filter((d) => (d % 2 === 0) === p.even).length * p.per,
    rule: (p) => `Each ${p.even ? 'even' : 'odd'} die`,
    hint: (p) => `${p.per} pts per ${p.even ? 'even' : 'odd'} die`,
    max: (p, n) => p.per * n,
  },
  exact: {
    score: (r, p) => (p.totals.includes(sum(r)) ? p.points : 0),
    rule: (p) => `Total exactly ${p.totals.join(' or ')}`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  distinct: {
    score: (r, p) => (new Set(r).size === r.length ? p.points : 0),
    rule: (p, n) => `All ${n} dice different`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  pairOf: {
    score: (r, p) => (p.faces.some((f) => count(r, f) >= 2) ? p.points : 0),
    rule: (p) => `A pair of ${p.faces.map((f) => `${f}s`).join(', ').replace(/, ([^,]*)$/, ' or $1')}`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  pairSum: {
    score: (r, p) => (r.some((d, i) => r.some((e, j) => j > i && d + e === p.target)) ? p.points : 0),
    rule: (p) => `Two dice add up to ${p.target}`,
    hint: (p) => `${p.points} pts`,
    max: (p) => p.points,
  },
  total: {
    score: (r, p) => Math.round(sum(r) * p.mult),
    rule: () => 'Any roll — never zero',
    hint: (p) => (p.mult === 1 ? 'Pays the total' : p.mult === 0.5 ? 'Pays half the total' : `Pays total × ${p.mult}`),
    max: (p, n) => Math.round(6 * n * p.mult),
  },
};
const setWord = (n) => (n === 2 ? 'double' : n === 3 ? 'triple' : 'set');

// How each rule is drawn on its zone: either the dice that show it (0 = any die)
// or a short phrase, plus what it pays in as few characters as possible. The longer
// `rule` / `hint` strings above are for How to play and the reports.
const fill = (n, faces) => Array.from({ length: n }, (_, i) => faces[i] ?? 0);
const PICTURES = {
  low:      { picture: (p, n) => ({ chip: `Total ${n + 1} to ${Math.ceil(3.5 * n) - 1}` }), pays: (p) => `${p.step} a pip` },
  high:     { picture: (p, n) => ({ chip: `Total ${Math.floor(3.5 * n) + 1} to ${6 * n - 1}` }), pays: (p) => `${p.step} a pip` },
  set:      { picture: (p, n) => ({ dice: fill(n, Array(n).fill(5)) }), pays: (p) => `${p.points}` },
  pair:     { picture: (p, n) => ({ dice: fill(n, [3, 3]) }), pays: (p) => `${p.points}` },
  run:      { picture: (p, n) => ({ dice: fill(n, [2, 3, 4, 5, 6]) }), pays: (p) => `${p.points}` },
  face:     { picture: (p, n) => ({ dice: fill(n, [p.face]) }), pays: (p) => `${p.first} each` },
  parity:   { picture: (p, n) => ({ dice: fill(n, p.even ? [2, 4, 6] : [1, 3, 5]) }), pays: (p) => `${p.per} each` },
  exact:    { picture: (p) => ({ chip: `Total ${p.totals.join(' or ')}` }), pays: (p) => `${p.points}` },
  distinct: { picture: () => ({ chip: 'All different' }), pays: (p) => `${p.points}` },
  pairOf:   { picture: (p) => ({ chip: `Pair, ${Math.min(...p.faces)}s or up` }), pays: (p) => `${p.points}` },
  pairSum:  { picture: (p) => ({ chip: `Two add to ${p.target}` }), pays: (p) => `${p.points}` },
  total:    { picture: () => ({ chip: 'Any roll' }), pays: (p) => (p.mult === 1 ? 'its total' : `total × ${p.mult}`) },
};

// ---------- the zone pool ----------
// Every zone the game knows. A match deals `deal` of them (or uses a fixed list).
// `celebrate` ranks how big a hit in that zone should feel (see table.js); it has
// no effect on scoring. Values are tuned — see BALANCE.md before changing them, and
// re-run `node sim/balance.js --write` after.
const ZONE_POOL = [
  { id: 'small',    name: 'Small',     kind: 'low',      pay: { base: 2, step: 2 }, celebrate: 1 },
  { id: 'big',      name: 'Big',       kind: 'high',     pay: { base: 2, step: 2 }, celebrate: 1 },
  { id: 'triple',   name: 'Triple',    kind: 'set',      pay: { points: 30 }, celebrate: 3 },
  { id: 'double',   name: 'Double',    kind: 'pair',     pay: { points: 10, perPip: 0 }, celebrate: 1 },
  { id: 'straight', name: 'Straight',  kind: 'run',      pay: { points: 15 }, celebrate: 2 },
  { id: 'sixes',    name: 'Sixes',     kind: 'face',     pay: { face: 6, first: 4, extra: 4 }, celebrate: 1 },
  { id: 'ones',     name: 'Ones',      kind: 'face',     pay: { face: 1, first: 4, extra: 4 }, celebrate: 1 },
  { id: 'total',    name: 'Total',     kind: 'total',    pay: { mult: 1 }, celebrate: 1 },
  { id: 'evens',    name: 'Evens',     kind: 'parity',   pay: { even: true, per: 3 }, celebrate: 1 },
  { id: 'odds',     name: 'Odds',      kind: 'parity',   pay: { even: false, per: 3 }, celebrate: 1 },
  { id: 'bullseye', name: 'Bullseye',  kind: 'exact',    pay: { totals: [10, 11], points: 12 }, celebrate: 1 },
  { id: 'rainbow',  name: 'Rainbow',   kind: 'distinct', pay: { points: 6 }, celebrate: 1 },
  { id: 'highpair', name: 'High Pair', kind: 'pairOf',   pay: { faces: [4, 5, 6], points: 14 }, celebrate: 2 },
  { id: 'lucky7',   name: 'Lucky 7',   kind: 'pairSum',  pay: { target: 7, points: 8 }, celebrate: 1 },
];
const CLASSIC_EIGHT = ['small', 'big', 'triple', 'double', 'straight', 'sixes', 'ones', 'total'];

// ---------- the extras ----------
// One block of switches and numbers per variant. Everything here is the same for
// both players, and nothing random happens that isn't dealt to both.
const EXTRAS = {
  offers: 2,          // rolls shown each turn; you place one ("pick one of two")
  deal: 8,            // zones dealt from the pool each match; or `zoneIds: [...]` for a fixed table
  hot: true,          // one zone per match pays an extra 1×
  gold: true,         // one die per roll is gold: it adds its face to whatever the roll scores
  streak: { step: 1, cap: 5 }, // each scoring placement in a row adds `step` more, up to step × cap
  sweep: 12,          // bonus for scoring in all four zones of a set (zones 1–4, zones 5–8)
  bounty: 2,          // bonus for winning a zone outright at the reveal
  powers: ['flip', 'double', 'hold', 'peek'], // each usable once per match
};
const NO_EXTRAS = { offers: 1, zoneIds: CLASSIC_EIGHT, hot: false, gold: false, streak: null, sweep: 0, bounty: 0, powers: [] };

// With two rolls to pick from and a Flip in hand, a Triple turns up far more often
// than in the original game (a pair plus its opposite face flips into one), and it
// can then be doubled. At the original 30 it out-earned every other zone 2.7 to 1.
const ARCADE_PAY = { triple: { points: 18 } };

// What each power-up does, for the buttons and How to play.
export const POWERS = {
  flip:   { name: 'Flip',   blurb: 'Turn one die over to its opposite face.' },
  double: { name: 'Double', blurb: 'This placement pays an extra 1×.' },
  hold:   { name: 'Hold',   blurb: 'Keep this roll and place it on a later turn.' },
  peek:   { name: 'Peek',   blurb: 'See the next two rolls now.' },
};

// ---------- variants ----------
// A variant is a named game mode: its extras, plus per-zone overrides of the pool's
// pay values. Add an entry and it shows up in the menu, the simulator and the tests
// automatically.
export const VARIANTS = {
  arcade: {
    id: 'arcade', name: 'Arcade', blurb: 'Everything on: two rolls to pick from, power-ups, a hot zone and a golden die.',
    dice: 3, rolls: 8, pay: ARCADE_PAY, ...EXTRAS,
  },
  triples: {
    id: 'triples', name: 'Triples Season', blurb: 'Arcade rules, and Triple pays 30. Is it worth your Flip?',
    dice: 3, rolls: 8, pay: { ...ARCADE_PAY, triple: { points: 30 } }, ...EXTRAS,
  },
  classic: {
    id: 'classic', name: 'Classic', blurb: 'The original: eight fixed zones, one roll at a time, no extras.',
    dice: 3, rolls: 8, pay: {}, ...NO_EXTRAS,
  },
};
export const DEFAULT_VARIANT = 'arcade';

// Resolve a variant into something playable: the pool as zones with a bound
// `score(dice)` and display strings generated from their (possibly overridden) pay
// values. engine.makeTable() then deals a match's zones from `pool`.
export function buildVariant(id = DEFAULT_VARIANT, overrides = {}) {
  const v = { ...(VARIANTS[id] || VARIANTS[DEFAULT_VARIANT]), ...overrides };
  const pool = ZONE_POOL.map((z) => {
    const pay = { ...z.pay, ...(v.pay[z.id] || {}) };
    const rule = RULES[z.kind];
    return {
      id: z.id, name: z.name, kind: z.kind, pay, celebrate: z.celebrate,
      rule: rule.rule(pay, v.dice),
      hint: rule.hint(pay, v.dice),
      max: rule.max(pay, v.dice),
      picture: PICTURES[z.kind].picture(pay, v.dice),
      pays: PICTURES[z.kind].pays(pay),
      score: (dice) => rule.score(dice, pay),
    };
  });
  const { pay, ...rest } = v;
  return { ...rest, pool, streak: v.streak || { step: 0, cap: 0 } };
}
