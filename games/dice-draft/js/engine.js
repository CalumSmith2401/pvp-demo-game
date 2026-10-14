// Pure, deterministic rules: the table a match is played on, the rolls it offers,
// what a placement is worth, what a turn's action does to a player, and the
// zone-by-zone reveal. No DOM, no clock, no randomness beyond the seed — which is
// what lets the authoritative match layer, the bots, the simulator and the tests
// all share it.
import { mulberry32, shuffle } from './rng.js';
import { TIEBREAK_ZONES_WON } from './config.js';

const SET_SIZE = 4;

// ---------- the table ----------
// The zones a match is played on (dealt from the variant's pool, or its fixed
// list), which one is hot, and the sets that pay a sweep. Reveal order is zone order.
export function makeTable(seed, variant) {
  const rand = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const byId = new Map(variant.pool.map((z) => [z.id, z]));
  const picked = variant.zoneIds ? variant.zoneIds.map((id) => byId.get(id)) : shuffle(variant.pool, rand).slice(0, variant.deal);
  const zones = picked.map((z, index) => ({ ...z, index, set: Math.floor(index / SET_SIZE) }));
  const hot = variant.hot ? Math.floor(rand() * zones.length) : -1;
  const sets = [];
  if (variant.sweep) for (let i = 0; i + SET_SIZE <= zones.length; i += SET_SIZE) sets.push(zones.slice(i, i + SET_SIZE).map((z) => z.index));
  return { zones, hot, sets };
}

// ---------- the rolls ----------
// A roll on offer is { dice, gold }: gold is the index of the golden die, or null.
// Every turn offers `variant.offers` of them; both players see the same ones.
export function makeOffers(seed, variant) {
  const rand = mulberry32(seed);
  return Array.from({ length: variant.rolls }, () => Array.from({ length: variant.offers }, () => {
    const dice = Array.from({ length: variant.dice }, () => 1 + Math.floor(rand() * 6));
    return { dice, gold: variant.gold ? Math.floor(rand() * variant.dice) : null };
  }));
}

// Flip: one die turned over to its opposite face.
export const flipDie = (offer, i) => ({ ...offer, dice: offer.dice.map((d, k) => (k === i ? 7 - d : d)) });

// ---------- scoring a placement ----------
// base   what the zone's rule pays for the dice
// goldPts the golden die's face, added if the roll scores at all
// mult   1, plus 1 for the hot zone, plus 1 for a Double
// streak scoring placements in a row, counting this one; a blank resets it
// total  (base + goldPts) × mult + the streak bonus
export function scorePlacement(variant, table, zone, offer, double, streakBefore) {
  const base = table.zones[zone].score(offer.dice);
  const goldPts = base > 0 && offer.gold != null ? offer.dice[offer.gold] : 0;
  const mult = 1 + (table.hot === zone ? 1 : 0) + (double ? 1 : 0);
  const streak = base > 0 ? streakBefore + 1 : 0;
  const streakBonus = base > 0 ? variant.streak.step * Math.min(streak - 1, variant.streak.cap) : 0;
  return { base, goldPts, mult, streak, streakBonus, total: (base + goldPts) * mult + streakBonus };
}

// ---------- a player ----------
export const newPlayer = (variant, table) => ({
  board: Array(table.zones.length).fill(null), // per zone: the placement that landed there
  score: 0,
  streak: 0,
  powers: Object.fromEntries(variant.powers.map((p) => [p, true])), // true while unused
  held: null,     // the roll set aside with Hold
  sweeps: table.sets.map(() => false),
});

export function openZones(board) {
  const out = [];
  for (let i = 0; i < board.length; i++) if (!board[i]) out.push(i);
  return out;
}

// A set pays its sweep when its last zone is filled and every zone in it scored.
function settleSweep(variant, table, player, zone) {
  const s = table.zones[zone].set;
  const set = table.sets[s];
  if (!set || player.sweeps[s] || set.some((z) => !player.board[z])) return 0;
  if (set.some((z) => player.board[z].base === 0)) return 0;
  player.sweeps[s] = true;
  player.score += variant.sweep;
  return variant.sweep;
}

function land(variant, table, player, zone, offer, opts) {
  const pts = scorePlacement(variant, table, zone, offer, opts.double, player.streak);
  const entry = { zone, dice: offer.dice, gold: offer.gold, ...opts, ...pts };
  player.board[zone] = entry;
  player.streak = pts.streak;
  player.score += pts.total;
  entry.sweep = settleSweep(variant, table, player, zone);
  return entry;
}

// What a turn's action must look like. All fields optional except `pick`:
//   { pick, flip, hold, zone, double, held: { zone, double } }
//   pick   which offered roll to take
//   flip   index of a die to turn over (uses Flip)
//   hold   true to set the roll aside instead of placing it (uses Hold)
//   zone   where the roll goes (required unless holding)
//   double true to make that placement pay an extra 1× (uses Double)
//   held   place the roll set aside earlier as well; it lands first
// Returns an error string, or null if the action is legal.
export function checkAction(variant, table, player, offers, action, lastTurn) {
  const a = action || {};
  if (!Number.isInteger(a.pick) || a.pick < 0 || a.pick >= offers.length) return 'bad-pick';
  if (a.flip != null && (!player.powers.flip || !Number.isInteger(a.flip) || a.flip < 0 || a.flip >= variant.dice)) return 'bad-flip';
  const isOpen = (z) => Number.isInteger(z) && z >= 0 && z < player.board.length && !player.board[z];
  if (a.hold) {
    if (!player.powers.hold || player.held || lastTurn) return 'bad-hold';
    if (a.zone != null || a.double || a.held) return 'bad-hold';
    return null;
  }
  if (!isOpen(a.zone)) return 'zone-filled';
  if (a.held) {
    if (!player.held) return 'nothing-held';
    if (!isOpen(a.held.zone) || a.held.zone === a.zone) return 'zone-filled';
  }
  const doubles = (a.double ? 1 : 0) + (a.held?.double ? 1 : 0);
  if (doubles > 1 || (doubles && !player.powers.double)) return 'bad-double';
  return null;
}

// Apply a legal action. Returns the placements that landed, in order. On the last
// turn a roll still being held drops into the one zone left, so nothing is lost.
export function applyAction(variant, table, player, offers, action, turn, lastTurn) {
  const a = action;
  let offer = offers[a.pick];
  if (a.flip != null) { offer = flipDie(offer, a.flip); player.powers.flip = false; }
  const tags = { turn, pick: a.pick, flipped: a.flip ?? null, auto: !!a.auto };
  if (a.hold) {
    player.powers.hold = false;
    player.held = { ...offer, ...tags };
    return [];
  }
  const landed = [];
  const placeHeld = (zone, double, forced) => {
    const h = player.held;
    player.held = null;
    landed.push(land(variant, table, player, zone, h, { turn, pick: h.pick, flipped: h.flipped, heldFrom: h.turn, double: !!double, auto: !!forced }));
  };
  if (a.held) placeHeld(a.held.zone, a.held.double, false);
  if (a.double || a.held?.double) player.powers.double = false;
  landed.push(land(variant, table, player, a.zone, offer, { ...tags, heldFrom: null, double: !!a.double }));
  if (lastTurn && player.held) placeHeld(openZones(player.board)[0], false, true);
  return landed;
}

// ---------- the reveal ----------
// Zones resolve in table order. Each step carries both players' placements, the
// bounty for winning the zone outright, and the running totals; after the last
// zone of a set comes that set's sweep. `result` is 'a', 'b' or 'draw'.
export function buildReveal(variant, table, a, b) {
  let totalA = 0, totalB = 0, wonA = 0, wonB = 0;
  const steps = [];
  const zones = table.zones.map((zone, i) => {
    const ea = a.board[i], eb = b.board[i];
    const pa = ea ? ea.total : 0, pb = eb ? eb.total : 0;
    const winner = pa > pb ? 'a' : pb > pa ? 'b' : 'draw';
    const bountyA = winner === 'a' ? variant.bounty : 0, bountyB = winner === 'b' ? variant.bounty : 0;
    if (winner === 'a') wonA++; else if (winner === 'b') wonB++;
    totalA += pa + bountyA;
    totalB += pb + bountyB;
    const step = {
      type: 'zone', index: i, zone: zone.id, name: zone.name, hot: table.hot === i,
      a: { entry: ea, points: pa, bounty: bountyA }, b: { entry: eb, points: pb, bounty: bountyB },
      winner, totalA, totalB,
    };
    steps.push(step);
    const s = zone.set, set = table.sets[s];
    if (set && set[set.length - 1] === i && (a.sweeps[s] || b.sweeps[s])) {
      totalA += a.sweeps[s] ? variant.sweep : 0;
      totalB += b.sweeps[s] ? variant.sweep : 0;
      steps.push({ type: 'sweep', set: s, a: a.sweeps[s] ? variant.sweep : 0, b: b.sweeps[s] ? variant.sweep : 0, totalA, totalB });
    }
    return step;
  });
  let result = totalA > totalB ? 'a' : totalB > totalA ? 'b' : 'draw';
  let tiebreak = false;
  if (result === 'draw' && TIEBREAK_ZONES_WON && wonA !== wonB) {
    result = wonA > wonB ? 'a' : 'b';
    tiebreak = true;
  }
  return { steps, zones, totalA, totalB, zonesWonA: wonA, zonesWonB: wonB, result, tiebreak };
}
