// Five opponent bots spanning a real difficulty gradient. Every bot drafts under
// the same rule as the human: it sees the current card and its own partial build,
// never the future sequence or the player's build. Strength comes from how well it
// places cards, not from peeking.
//
//   1 Novice       — random placement
//   2 Apprentice   — crude front/back split by spell school
//   3 Adept        — value-aware positional heuristic
//   4 Strategist   — simulates the duel (Monte Carlo) before each placement
//   5 Grandmaster  — deep rollouts + greedy self-completion, optimizes win rate
//
// The simulation bots model the opponent as an Adept drafting the full (sampled)
// sequence from scratch — an honest stand-in for the unknown human build.
import { resolveCombat } from './combat.js';
import { shuffle } from './rng.js';

const SLOTS = 12;

function emptySlots(build) {
  const out = [];
  for (let i = 0; i < build.length; i++) if (!build[i]) out.push(i);
  return out;
}

// ---- tier 1: random ----
function noviceSlot(card, build, ctx) {
  const empty = emptySlots(build);
  const rand = (ctx && ctx.rand) || Math.random;
  return empty[Math.floor(rand() * empty.length)];
}

// ---- tier 2: crude front/back split ----
function apprenticeSlot(card, build) {
  const empty = emptySlots(build);
  const aggressive = card.type === 'damage' || card.type === 'burn';
  // offense grabs the earliest open slot, everything else the latest
  return aggressive ? empty[0] : empty[empty.length - 1];
}

// ---- tier 3: value-aware positional heuristic ----
// Returns a 0..1 "ideal phase": 0 = fire as early as possible, 1 = save for last.
// Scaled to the actual slot count at placement time so it works for any board size.
function adeptFrac(card) {
  switch (card.id) {
    case 'execute':        return 1.0;  // finisher — wants the enemy already low
    case 'mirror':         return 0.6;  // after the enemy has shown a strong spell
    case 'chainlightning': return 0.55; // after burns are stacked
    case 'vampiric':       return 0.7;  // comeback card, better when you're hurt
    case 'bloodpact':      return 0.3;
    case 'reflectward':    return 0.1;  // up early to punish openers
    case 'manabarrier':    return 0.45;
    case 'silence':        return 0.4;
    case 'haste':          return 0.25; // early, so a later spell gets doubled
    case 'corrosion':      return 0.0;
    default: break;
  }
  switch (card.type) {
    case 'burn':    return 0.0;
    case 'damage':  return card.value >= 20 ? 0 : card.value >= 16 ? 0.1 : card.value >= 12 ? 0.3 : 0.4;
    case 'drain':   return 0.2;
    case 'shield':  return 0.15;
    case 'heal':    return 1.0; // hold for topping off late
    case 'control': return 0.4;
    default:        return 0.45;
  }
}

function adeptSlot(card, build) {
  const empty = emptySlots(build);
  const ideal = Math.round(adeptFrac(card) * (build.length - 1));
  let best = empty[0];
  let bestDist = Infinity;
  for (const s of empty) {
    const d = Math.abs(s - ideal);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// Place an ordered run of cards into a copy of `build` using the Adept heuristic.
function adeptComplete(build, futures) {
  const b = build.slice();
  for (const c of futures) b[adeptSlot(c, b)] = c;
  return b;
}

const adeptFullBuild = (cards) => adeptComplete(Array(SLOTS).fill(null), cards);

// Greedy self-completion: place the first few future cards with a 1-ply lookahead
// (try each slot, complete the rest with Adept, resolve vs the modelled opponent),
// then Adept the tail. Used only by the Grandmaster, capped for speed.
function greedyComplete(build, futures, oppFull) {
  const b = build.slice();
  const cap = 3;
  for (let i = 0; i < futures.length; i++) {
    const card = futures[i];
    if (i >= cap) { b[adeptSlot(card, b)] = card; continue; }
    const rest = futures.slice(i + 1);
    let bestS = -1;
    let bestSc = -Infinity;
    for (const s of emptySlots(b)) {
      const trial = b.slice();
      trial[s] = card;
      const r = resolveCombat(adeptComplete(trial, rest), oppFull);
      const sc = r.finalA - r.finalB;
      if (sc > bestSc) { bestSc = sc; bestS = s; }
    }
    b[bestS] = card;
  }
  return b;
}

function unseenCards(pool, seen) {
  const seenIds = new Set(seen.map((c) => c.id));
  return pool.filter((c) => !seenIds.has(c.id));
}

// Monte Carlo placement: for each candidate slot, sample plausible completions of
// the remaining sequence, resolve the duel, and keep the best-scoring slot.
function rollout(card, build, ctx, { samples, ownComplete, winRate }) {
  const empty = emptySlots(build);
  if (empty.length <= 1) return empty[0];
  const futureCount = empty.length - 1;
  const unseen = unseenCards(ctx.pool, ctx.seen);
  const rand = ctx.rand || Math.random;

  let bestSlot = empty[0];
  let bestScore = -Infinity;
  for (const s of empty) {
    const myStart = build.slice();
    myStart[s] = card;
    let score = 0;
    for (let n = 0; n < samples; n++) {
      const futures = shuffle(unseen, rand).slice(0, futureCount);
      const oppFull = adeptFullBuild(ctx.seen.concat(futures));
      const myFull = ownComplete(myStart, futures, oppFull);
      const r = resolveCombat(myFull, oppFull);
      score += winRate
        ? (r.result === 'a' ? 1 : r.result === 'draw' ? 0.5 : 0)
        : r.finalA - r.finalB;
    }
    if (score > bestScore) { bestScore = score; bestSlot = s; }
  }
  return bestSlot;
}

export const BOTS = [
  {
    id: 'novice', name: 'Novice', tier: 1,
    blurb: 'Hurls spells into random slots. A warm-up dummy.',
    choose: (card, build, ctx) => noviceSlot(card, build, ctx),
  },
  {
    id: 'apprentice', name: 'Apprentice', tier: 2,
    blurb: 'Crude instincts — blasts up front, succor in back.',
    choose: (card, build) => apprenticeSlot(card, build),
  },
  {
    id: 'adept', name: 'Adept', tier: 3,
    blurb: 'Knows where each school of magic wants to sit.',
    choose: (card, build) => adeptSlot(card, build),
  },
  {
    id: 'strategist', name: 'Strategist', tier: 4,
    blurb: 'Simulates the duel before committing each card.',
    choose: (card, build, ctx) =>
      rollout(card, build, ctx, { samples: 12, ownComplete: adeptComplete, winRate: false }),
  },
  {
    id: 'grandmaster', name: 'Grandmaster', tier: 5,
    blurb: 'Deep Monte Carlo rollouts, optimizing for the kill.',
    choose: (card, build, ctx) =>
      rollout(card, build, ctx, { samples: 64, ownComplete: greedyComplete, winRate: false }),
  },
];

export function getBot(id) {
  return BOTS.find((b) => b.id === id) || BOTS[0];
}
