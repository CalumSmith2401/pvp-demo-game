// Pure, deterministic rules: the shared roll sequence, board scoring, and the
// zone-by-zone reveal log. No DOM, no clock, no randomness beyond the seed —
// which is what lets the authoritative match layer and the tests share it.
import { mulberry32 } from './rng.js';
import { TIEBREAK_ZONES_WON } from './config.js';

// The match's shared sequence: `variant.rolls` rolls of `variant.dice` dice.
export function makeRolls(seed, variant) {
  const rand = mulberry32(seed);
  return Array.from({ length: variant.rolls }, () =>
    Array.from({ length: variant.dice }, () => 1 + Math.floor(rand() * 6)));
}

// A board is an array indexed like variant.zones; each entry is a roll or null.
export const emptyBoard = (variant) => Array(variant.zones.length).fill(null);

export function openZones(board) {
  const out = [];
  for (let i = 0; i < board.length; i++) if (!board[i]) out.push(i);
  return out;
}

export const zonePoints = (variant, zoneIndex, roll) => (roll ? variant.zones[zoneIndex].score(roll) : 0);

export function boardTotal(variant, board) {
  let t = 0;
  for (let i = 0; i < board.length; i++) t += zonePoints(variant, i, board[i]);
  return t;
}

// The structured reveal: zones resolve in table order, each with both players'
// rolls, points and the running totals. `result` is 'a', 'b' or 'draw'.
export function buildReveal(variant, boardA, boardB) {
  let totalA = 0, totalB = 0, wonA = 0, wonB = 0;
  const zones = variant.zones.map((zone, i) => {
    const a = zonePoints(variant, i, boardA[i]);
    const b = zonePoints(variant, i, boardB[i]);
    totalA += a;
    totalB += b;
    if (a > b) wonA++;
    else if (b > a) wonB++;
    return {
      zone: zone.id, name: zone.name,
      a: { roll: boardA[i], points: a },
      b: { roll: boardB[i], points: b },
      winner: a > b ? 'a' : b > a ? 'b' : 'draw',
      totalA, totalB,
      lead: totalA > totalB ? 'a' : totalB > totalA ? 'b' : 'draw',
    };
  });
  let result = totalA > totalB ? 'a' : totalB > totalA ? 'b' : 'draw';
  let tiebreak = false;
  if (result === 'draw' && TIEBREAK_ZONES_WON && wonA !== wonB) {
    result = wonA > wonB ? 'a' : 'b';
    tiebreak = true;
  }
  return { zones, totalA, totalB, zonesWonA: wonA, zonesWonB: wonB, result, tiebreak };
}
