// Opponent bots, tiered easy → hard. Every bot plays through the same view the
// human gets from match.view(): the current roll, both boards as revealed so far,
// and nothing about future rolls or the opponent's pending placement.
//
//   1 Tourist   — random open zone
//   2 Regular   — greedy: wherever this roll scores most right now
//   3 Grinder   — greedy, but counts what an average roll would have earned there
//   4 Shark     — exact expected-score solver (see solver.js)
//   5 The House — Shark, plus an exact win-probability endgame that reads the
//                 scoreboard: protects a lead, gambles when behind
import { openZones } from './engine.js';
import { solverFor, maskOf } from './solver.js';

const argmax = (items, score, rand) => {
  let best = [], bestS = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestS + 1e-9) { best = [it]; bestS = s; } else if (s > bestS - 1e-9) best.push(it);
  }
  return best.length === 1 ? best[0] : best[Math.floor(rand() * best.length)];
};

function tourist(view, { rand }) {
  const open = openZones(view.board);
  return open[Math.floor(rand() * open.length)];
}

function regular(view, { variant, rand }) {
  return argmax(openZones(view.board), (z) => variant.zones[z].score(view.roll), rand);
}

// Points above what the zone averages from a random roll: a one-step read on
// opportunity cost that a thoughtful human can do in their head.
function grinder(view, { variant, rand }) {
  const { zoneEV } = solverFor(variant);
  return argmax(openZones(view.board), (z) => variant.zones[z].score(view.roll) - zoneEV[z], rand);
}

function shark(view, { variant }) {
  return solverFor(variant).pick(view.board, view.roll);
}

// ---- The House: win-probability endgame ----
// With few rolls left, maximising expected score is not the same as maximising
// the chance of winning. From ENDGAME rolls out, search exactly: I pick the zone
// with the best win chance, assuming the opponent plays the expected-score line.
export const HOUSE = { endgame: 6 }; // rolls from the end where the search takes over

function winChance(s, myMask, oppMask, diff, left) {
  if (left === 0) return diff > 0 ? 1 : diff === 0 ? 0.5 : 0;
  // Positions repeat constantly across rolls and matches, so remember them.
  const memo = (s.winMemo ||= new Map());
  const key = ((myMask << 8) | oppMask) * 1024 + diff + 512;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const { table, pts, choice } = s;
  const R = table.prob.length;
  let total = 0;
  for (let r = 0; r < R; r++) {
    const oz = choice[oppMask * R + r];
    const d = diff - pts[oz][r];
    const om = oppMask ^ (1 << oz);
    let best = 0;
    for (let z = 0; (1 << z) <= myMask; z++) {
      if (!(myMask & (1 << z))) continue;
      const w = winChance(s, myMask ^ (1 << z), om, d + pts[z][r], left - 1);
      if (w > best) best = w;
    }
    total += table.prob[r] * best;
  }
  memo.set(key, total);
  return total;
}

function house(view, { variant }) {
  const s = solverFor(variant);
  const left = view.turns - view.turn; // rolls still to place, including this one
  if (left > HOUSE.endgame) return s.pick(view.board, view.roll);
  const r = s.table.indexOf(view.roll);
  const myMask = maskOf(view.board);
  const oppMask = maskOf(view.oppBoard);
  const oz = s.choice[oppMask * s.table.prob.length + r];
  const diff = view.score - view.oppScore - s.pts[oz][r];
  let best = -1, bestZ = -1, bestEV = -1;
  for (const z of openZones(view.board)) {
    const w = winChance(s, myMask ^ (1 << z), oppMask ^ (1 << oz), diff + s.pts[z][r], left - 1);
    const e = s.value(view.board, view.roll, z);
    // Equal win chance → fall back on expected score.
    if (w > best + 1e-9 || (w > best - 1e-9 && e > bestEV)) { best = w; bestZ = z; bestEV = e; }
  }
  return bestZ;
}

// choose(view, ctx) → zone index.  ctx = { variant, rand }
export const BOTS = [
  { id: 'tourist', name: 'Tourist', tier: 1, blurb: 'Drops dice wherever there is room.', choose: tourist },
  { id: 'regular', name: 'Regular', tier: 2, blurb: 'Always takes the biggest payout on the table right now.', choose: regular },
  { id: 'grinder', name: 'Grinder', tier: 3, blurb: 'Weighs each payout against what the zone usually earns.', choose: grinder },
  { id: 'shark', name: 'Shark', tier: 4, blurb: 'Plays the exact odds on every roll.', choose: shark },
  { id: 'house', name: 'The House', tier: 5, blurb: 'Plays the odds, then plays you: sits on a lead, gambles when behind.', choose: house },
];

export const getBot = (id) => BOTS.find((b) => b.id === id) || BOTS[0];
