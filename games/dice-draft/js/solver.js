// Solver for one player's placement problem on a given table.
//
// The value of a position is the expected points still to come under best play:
//
//   V(state) = E over the rolls offered [ max over actions ( points now + V(next state) ) ]
//
// A state is everything the future depends on: which zones are open, the running
// streak, which sets can still sweep, and whether Flip and Double are unused. That
// is a few thousand states × 126 distinct rolls (a golden face plus two others), so
// it is solved exactly, once per table. It is the yardstick the balance simulator
// measures every other policy against, and the brain of the stronger bots.
//
// What it leaves out: Hold and Peek. Neither fits in the table (a held roll, or a
// known next turn, multiplies the state space), so the bots that use them search a
// turn ahead on top of these values (see bots.js).
import { openZones } from './engine.js';

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
  return { rolls: types.map((t) => t.roll), prob: types.map((t) => t.p) };
}

const popcount = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };

// Bit i of a mask is set when zone i is still open.
export const maskOf = (board) => board.reduce((m, r, i) => (r ? m : m | (1 << i)), 0);

export function createSolver(variant, table) {
  const Z = table.zones.length;
  if (variant.rolls !== Z) throw new Error('the solver assumes one placement per zone');
  const { step, cap } = variant.streak;
  const S = cap + 2;                    // streak states 0..cap+1 (cap+1 = "at the cap or beyond")
  const sweep = variant.sweep || 0;
  const setOf = table.zones.map((z) => (table.sets[z.set] ? z.set : -1));
  const setMask = table.sets.map((set) => set.reduce((m, z) => m | (1 << z), 0));
  const ALL_ALIVE = (1 << table.sets.length) - 1;

  // ---- roll types: [gold face, ...the other dice sorted] ----
  const rest = rollTable(variant.dice - 1);
  const types = [], prob = [], index = new Map();
  for (let g = 1; g <= 6; g++) {
    rest.rolls.forEach((others, i) => {
      index.set(`${g}|${others.join('')}`, types.length);
      types.push([g, ...others]);
      prob.push(rest.prob[i] / 6);
    });
  }
  const T = types.length;
  // With no golden die the first die is just a die; its face adds nothing.
  const goldFace = types.map((t) => (variant.gold ? t[0] : 0));
  const base = table.zones.map((z) => types.map((t) => z.score(t)));
  const typeIndex = (dice, gold) => {
    const g = gold ?? 0;
    return index.get(`${dice[g]}|${dice.filter((_, i) => i !== g).sort((a, b) => a - b).join('')}`);
  };
  // flipTo[t]: the types reachable by turning one die of t over (duplicates removed).
  const flipTo = types.map((t) => [...new Set(t.map((_, i) => typeIndex(t.map((d, k) => (k === i ? 7 - d : d)), 0)))]);

  // ---- states ----
  const A = 1 << table.sets.length;
  const stateIndex = (mask, streak, alive, flip, dbl) => (((mask * S + streak) * A + alive) * 2 + flip) * 2 + dbl;
  const V = new Float32Array((1 << Z) * S * A * 4);

  // One placement: points now, and where it leaves the player.
  const out = { pts: 0, mask: 0, streak: 0, alive: 0 };
  function place(mask, streak, alive, z, t, dbl) {
    const b = base[z][t];
    out.mask = mask & ~(1 << z);
    if (b > 0) {
      out.pts = (b + goldFace[t]) * (1 + (table.hot === z ? 1 : 0) + dbl) + step * Math.min(streak, cap);
      out.streak = Math.min(streak + 1, S - 1);
      out.alive = alive;
    } else {
      out.pts = 0;
      out.streak = 0;
      out.alive = setOf[z] >= 0 ? alive & ~(1 << setOf[z]) : alive;
    }
    const s = setOf[z];
    if (s >= 0 && (out.alive >> s) & 1 && !(out.mask & setMask[s])) out.pts += sweep;
    return out;
  }

  // Best value of placing roll type t from a state, with the Flip flag fixed at
  // `flipNext` for what follows. Fills w[t] for every t.
  function fillBest(w, mask, streak, alive, flipNext, dbl) {
    for (let t = 0; t < T; t++) {
      let best = -1;
      for (let z = 0; z < Z; z++) {
        if (!(mask & (1 << z))) continue;
        for (let d = 0; d <= dbl; d++) {
          const o = place(mask, streak, alive, z, t, d);
          const v = o.pts + V[stateIndex(o.mask, o.streak, o.alive, flipNext, dbl - d)];
          if (v > best) best = v;
        }
      }
      w[t] = best;
    }
  }

  // E[ max of `offers` independent draws ] from per-type values.
  const order = Array.from({ length: T }, (_, i) => i);
  function expectBest(best) {
    if (variant.offers === 1) { let e = 0; for (let t = 0; t < T; t++) e += prob[t] * best[t]; return e; }
    order.sort((x, y) => best[x] - best[y]);
    let e = 0, below = 0;
    for (const t of order) { // P(max = this) = F(≤)^n − F(<)^n
      const upto = below + prob[t];
      e += best[t] * (upto ** variant.offers - below ** variant.offers);
      below = upto;
    }
    return e;
  }

  const w0 = new Float32Array(T), w1 = new Float32Array(T), best = new Float32Array(T);
  function solveMask(mask) {
    for (let streak = 0; streak < S; streak++) for (let alive = 0; alive < A; alive++) for (let dbl = 0; dbl < 2; dbl++) {
      fillBest(w1, mask, streak, alive, 0, dbl);            // Flip already gone, or spent this turn
      V[stateIndex(mask, streak, alive, 0, dbl)] = expectBest(w1);
      fillBest(w0, mask, streak, alive, 1, dbl);            // Flip kept for later
      for (let t = 0; t < T; t++) {
        let b = w0[t];
        for (const f of flipTo[t]) if (w1[f] > b) b = w1[f];
        best[t] = b;
      }
      V[stateIndex(mask, streak, alive, 1, dbl)] = expectBest(best);
    }
  }

  // Masks are solved fewest-open-zones first; step() does one batch so the browser
  // can spread the work over a few frames instead of freezing.
  const queue = Array.from({ length: (1 << Z) - 1 }, (_, i) => i + 1).sort((x, y) => popcount(x) - popcount(y));
  let next = 0;

  const solver = {
    done: false,
    step(budgetMs = 8) {
      const until = Date.now() + budgetMs;
      while (next < queue.length && Date.now() < until) solveMask(queue[next++]);
      solver.done = next >= queue.length;
      return solver.done;
    },
    solve() { while (next < queue.length) solveMask(queue[next++]); solver.done = true; return solver; },

    // Expected points still to come from a fresh table.
    startValue: () => V[stateIndex((1 << Z) - 1, 0, ALL_ALIVE, variant.powers.includes('flip') ? 1 : 0, variant.powers.includes('double') ? 1 : 0)],

    // The solver's read of where a player stands, from their view.
    stateOf(view) {
      let alive = 0;
      table.sets.forEach((set, s) => { if (!set.some((z) => view.board[z] && view.board[z].base === 0)) alive |= 1 << s; });
      return { mask: maskOf(view.board), streak: Math.min(view.streak, S - 1), alive, flip: view.powers.flip ? 1 : 0, dbl: view.powers.double ? 1 : 0 };
    },

    // Every way to place one of `offers` from state `st` (no Hold), each scored as
    // points now + expected points to come. Sorted best first.
    options(st, offers) {
      const list = [];
      offers.forEach((offer, pick) => {
        for (let f = -1; f < (st.flip ? variant.dice : 0); f++) {
          const dice = f < 0 ? offer.dice : offer.dice.map((d, k) => (k === f ? 7 - d : d));
          const t = typeIndex(dice, offer.gold);
          for (let z = 0; z < Z; z++) {
            if (!(st.mask & (1 << z))) continue;
            for (let d = 0; d <= st.dbl; d++) {
              const o = place(st.mask, st.streak, st.alive, z, t, d);
              const after = { mask: o.mask, streak: o.streak, alive: o.alive, flip: f < 0 ? st.flip : 0, dbl: st.dbl - d };
              list.push({
                action: { pick, flip: f < 0 ? null : f, zone: z, double: d === 1 },
                points: o.pts, after, type: t,
                value: o.pts + V[stateIndex(after.mask, after.streak, after.alive, after.flip, after.dbl)],
              });
            }
          }
        }
      });
      return list.sort((x, y) => y.value - x.value);
    },

    // Value of entering next turn from `st` with roll type `heldType` set aside:
    // next turn's pick and the held roll both get placed, the held one first.
    holdValue(st, heldType) {
      for (let t = 0; t < T; t++) {
        let b = -1;
        for (let zh = 0; zh < Z; zh++) {
          if (!(st.mask & (1 << zh))) continue;
          for (let dh = 0; dh <= st.dbl; dh++) {
            const h = place(st.mask, st.streak, st.alive, zh, heldType, dh);
            const hp = h.pts, hm = h.mask, hs = h.streak, ha = h.alive;
            for (let z = 0; z < Z; z++) {
              if (!(hm & (1 << z))) continue;
              for (let d = 0; d <= st.dbl - dh; d++) {
                const o = place(hm, hs, ha, z, t, d);
                const v = hp + o.pts + V[stateIndex(o.mask, o.streak, o.alive, st.flip, st.dbl - dh - d)];
                if (v > b) b = v;
              }
            }
          }
        }
        best[t] = b;
      }
      return expectBest(best);
    },

    // The best way to place a held roll and one of `offers` together.
    bestWithHeld(st, held, offers) {
      const ht = typeIndex(held.dice, held.gold);
      let top = null;
      offers.forEach((offer, pick) => {
        const t = typeIndex(offer.dice, offer.gold);
        for (const zh of openZones(st.board)) for (let dh = 0; dh <= st.dbl; dh++) {
          const h = place(st.mask, st.streak, st.alive, zh, ht, dh);
          const hp = h.pts, hm = h.mask, hs = h.streak, ha = h.alive;
          for (let z = 0; z < Z; z++) {
            if (!(hm & (1 << z))) continue;
            for (let d = 0; d <= st.dbl - dh; d++) {
              const o = place(hm, hs, ha, z, t, d);
              const value = hp + o.pts + V[stateIndex(o.mask, o.streak, o.alive, st.flip, st.dbl - dh - d)];
              if (!top || value > top.value) top = { value, action: { pick, flip: null, zone: z, double: d === 1, held: { zone: zh, double: dh === 1 } } };
            }
          }
        }
      });
      return top;
    },

    typeIndex,
  };
  return solver;
}
