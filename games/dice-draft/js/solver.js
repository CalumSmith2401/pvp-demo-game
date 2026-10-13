// Exact solver for one player's placement problem. With the remaining rolls
// unknown, the best expected score from a set of open zones is a small DP:
//
//   V(open) = Σ over roll types  p(roll) · max over z in open ( pts[z][roll] + V(open − z) )
//
// 2^zones states × (56 distinct 3-dice rolls) — instant. This is the yardstick
// the balance simulator measures every other policy against, and the brain of
// the stronger bots.

// Every distinct roll (order ignored) of `dice` dice with its probability.
export function rollTable(dice) {
  const byKey = new Map();
  const total = 6 ** dice;
  for (let n = 0; n < total; n++) {
    const r = [];
    for (let i = 0, x = n; i < dice; i++, x = Math.floor(x / 6)) r.push(1 + (x % 6));
    r.sort((a, b) => a - b);
    const key = r.join('');
    if (!byKey.has(key)) byKey.set(key, { roll: r, p: 0 });
    byKey.get(key).p += 1 / total;
  }
  const types = [...byKey.values()];
  const index = new Map(types.map((t, i) => [t.roll.join(''), i]));
  return {
    rolls: types.map((t) => t.roll),
    prob: types.map((t) => t.p),
    indexOf: (roll) => index.get([...roll].sort((a, b) => a - b).join('')),
  };
}

const popcount = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };

// Bit i of a mask is set when zone i is still open.
export const maskOf = (board) => board.reduce((m, r, i) => (r ? m : m | (1 << i)), 0);

export function buildSolver(variant) {
  const Z = variant.zones.length;
  const table = rollTable(variant.dice);
  const R = table.rolls.length;
  const pts = variant.zones.map((z) => table.rolls.map((r) => z.score(r)));
  const ev = new Float64Array(1 << Z);       // expected future points from `mask`
  const choice = new Uint8Array((1 << Z) * R); // best zone for (mask, roll type)

  for (let mask = 1; mask < 1 << Z; mask++) {
    // Rolls still to come when `mask` is open (supports rolls < zones).
    if (variant.rolls - (Z - popcount(mask)) <= 0) continue;
    let v = 0;
    for (let r = 0; r < R; r++) {
      let best = -1, bestZ = 0;
      for (let z = 0; z < Z; z++) {
        if (!(mask & (1 << z))) continue;
        const s = pts[z][r] + ev[mask ^ (1 << z)];
        if (s > best + 1e-9) { best = s; bestZ = z; }
      }
      choice[mask * R + r] = bestZ;
      v += table.prob[r] * best;
    }
    ev[mask] = v;
  }

  return {
    table, pts, ev, choice,
    // Average points a zone earns from one random roll.
    zoneEV: pts.map((row) => row.reduce((a, s, r) => a + s * table.prob[r], 0)),
    // The expected-score-maximising zone for `roll` on `board`.
    pick: (board, roll) => choice[maskOf(board) * R + table.indexOf(roll)],
    // Expected final-score contribution of placing `roll` in `zone` (for ranking moves).
    value: (board, roll, zone) => pts[zone][table.indexOf(roll)] + ev[maskOf(board) ^ (1 << zone)],
  };
}

const cache = new Map();
export function solverFor(variant) {
  if (!cache.has(variant)) cache.set(variant, buildSolver(variant));
  return cache.get(variant);
}
