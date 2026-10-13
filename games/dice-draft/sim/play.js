// Headless match runner: two bots play one seeded match through the real
// authoritative layer (match.js), exactly as the browser client does.
import { createMatch } from '../js/match.js';
import { mulberry32 } from '../js/rng.js';

export function playMatch(seed, variant, botA, botB) {
  const match = createMatch({ seed, variant });
  // Each seat gets its own stream for tie-breaks, independent of the roll seed.
  const ctx = {
    a: { variant, rand: mulberry32((seed ^ 0x9e3779b9) >>> 0) },
    b: { variant, rand: mulberry32((seed ^ 0x85ebca6b) >>> 0) },
  };
  const bots = { a: botA, b: botB };
  while (!match.isFinished()) {
    // Both choose from views taken before either placement lands: blind lockstep.
    const moves = {};
    for (const p of ['a', 'b']) moves[p] = bots[p].choose(match.view(p), ctx[p]);
    for (const p of ['a', 'b']) {
      const res = match.place(p, variant.zones[moves[p]].id);
      if (!res.ok) throw new Error(`${bots[p].id} made an illegal placement: ${res.error}`);
    }
  }
  return match;
}
