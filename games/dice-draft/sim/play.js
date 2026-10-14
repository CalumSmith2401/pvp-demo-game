// Headless match runner: two bots play one seeded match through the real
// authoritative layer (match.js), exactly as the browser client does.
import { createMatch } from '../js/match.js';
import { createSolver } from '../js/solver.js';
import { mulberry32 } from '../js/rng.js';

// Solving a table takes a moment, and the simulator replays many roll sequences on
// each table, so solvers are kept per (variant, table seed).
const solvers = new Map();
export function solverFor(variant, match, tableSeed) {
  if (!solvers.has(variant)) solvers.set(variant, new Map());
  const byTable = solvers.get(variant);
  if (!byTable.has(tableSeed)) byTable.set(tableSeed, createSolver(variant, match.table).solve());
  return byTable.get(tableSeed);
}

export function playMatch(seed, variant, botA, botB, tableSeed = seed) {
  const match = createMatch({ seed, variant, tableSeed });
  const solver = botA.needsSolver || botB.needsSolver ? solverFor(variant, match, tableSeed) : null;
  // Each seat gets its own stream for tie-breaks, independent of the roll seed.
  const ctx = {
    a: { variant, table: match.table, solver, rand: mulberry32((seed ^ 0x9e3779b9) >>> 0) },
    b: { variant, table: match.table, solver, rand: mulberry32((seed ^ 0x85ebca6b) >>> 0) },
  };
  const bots = { a: botA, b: botB };
  const decide = (p) => {
    let action = bots[p].choose(match.view(p), ctx[p]);
    if (action.peek) { // spend Peek, then decide with the next turn in view
      if (!match.peek(p).ok) throw new Error(`${bots[p].id} asked for a Peek it cannot have`);
      action = bots[p].choose(match.view(p), ctx[p]);
    }
    return action;
  };
  while (!match.isFinished()) {
    // Both choose from views taken before either action lands: blind lockstep.
    const moves = { a: decide('a'), b: decide('b') };
    for (const p of ['a', 'b']) {
      const res = match.act(p, moves[p]);
      if (!res.ok) throw new Error(`${bots[p].id} made an illegal move: ${res.error} ${JSON.stringify(moves[p])}`);
    }
  }
  return match;
}
