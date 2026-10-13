// Opponent bots, tiered easy → hard. Every bot plays through the same view the
// human gets from match.view(): the rolls on offer, both boards as revealed so far,
// its own power-ups, and nothing about future rolls or the opponent's pending
// action. A bot returns an action for match.act(), or { peek: true } to spend its
// Peek and be asked again.
//
//   1 Tourist   — a random roll into a random open zone; never touches a power-up
//   2 Regular   — greedy: whatever scores most right now
//   3 Grinder   — greedy, but counts what an average roll would have earned there
//   4 Shark     — the exact solver (solver.js): right roll, right zone, Flip and
//                 Double at the right moment
//   5 The House — Shark, plus Hold and Peek, searched a turn ahead
import { openZones, scorePlacement, flipDie } from './engine.js';
import { zoneAverages } from './match.js';

const pickRandom = (list, rand) => list[Math.floor(rand() * list.length)];

function tourist(view, { rand }) {
  return { pick: Math.floor(rand() * view.offers.length), zone: pickRandom(openZones(view.board), rand) };
}

// Shared by the two greedy bots: score every roll × zone (and every Flip) by
// `worth`, take the best, and spend Flip / Double when the gain clears a bar.
function greedy(view, { variant, table, rand }, worth, bars) {
  const open = openZones(view.board);
  const rate = (flips) => {
    let top = [], best = -Infinity;
    view.offers.forEach((offer, pick) => {
      for (const flip of flips) {
        const rolled = flip == null ? offer : flipDie(offer, flip);
        for (const zone of open) {
          const pts = scorePlacement(variant, table, zone, rolled, false, view.streak);
          const w = worth(pts, zone);
          if (w > best + 1e-9) { top = []; best = w; }
          if (w > best - 1e-9) top.push({ pick, flip, zone, pts });
        }
      }
    });
    return { best, choice: pickRandom(top, rand) };
  };
  const plain = rate([null]);
  let { choice } = plain;
  if (view.powers.flip) {
    const flipped = rate([null, ...Array.from({ length: variant.dice }, (_, i) => i)]);
    if (flipped.best >= plain.best + bars.flip) choice = flipped.choice;
  }
  // Doubling adds another (base + gold): worth it on a big hit, or when time is running out.
  const gain = choice.pts.base + choice.pts.goldPts;
  const double = !!view.powers.double && (gain >= bars.double || (view.turn >= view.turns - 2 && gain > 0));
  return { pick: choice.pick, flip: choice.flip, zone: choice.zone, double };
}

const regular = (view, ctx) => greedy(view, ctx, (pts) => pts.total, { flip: 5, double: 14 });

// Points above what the zone averages from a random roll: a one-step read on
// opportunity cost that a thoughtful human can do in their head.
function grinder(view, ctx) {
  const avg = zoneAverages(ctx.variant, ctx.table);
  return greedy(view, ctx, (pts, zone) => pts.total - avg[zone] * (ctx.table.hot === zone ? 2 : 1), { flip: 4, double: 12 });
}

function shark(view, { solver }) {
  return solver.options(solver.stateOf(view), view.offers)[0].action;
}

// ---- The House ----
// Margins: how much better (in expected points) Hold has to look before it is
// spent, and how tight a decision has to be before Peek is.
const HOLD_EDGE = 0.4;
const PEEK_GAP = 1.5;

function house(view, { solver, variant }) {
  const st = solver.stateOf(view);
  const lastTurn = view.turn === view.turns - 1;

  // A roll set aside last turn: place it now, together with this turn's pick.
  if (view.held) return solver.bestWithHeld({ ...st, board: view.board }, view.held, view.offers).action;

  const options = solver.options(st, view.offers);
  let best = options[0];

  // Peeked: the next turn is known, so score each move by this turn + the best reply to it.
  if (view.next) {
    let top = -Infinity;
    for (const o of options) {
      const v = o.points + solver.options(o.after, view.next)[0].value;
      if (v > top) { top = v; best = o; }
    }
    return best.action;
  }

  if (lastTurn) return best.action;

  // Hold: is keeping one of these rolls for a double placement next turn worth more?
  if (view.powers.hold) {
    let hold = null;
    view.offers.forEach((offer, pick) => {
      for (let f = -1; f < (st.flip ? variant.dice : 0); f++) {
        const rolled = f < 0 ? offer : flipDie(offer, f);
        const v = solver.holdValue({ ...st, flip: f < 0 ? st.flip : 0 }, solver.typeIndex(rolled.dice, rolled.gold));
        if (!hold || v > hold.value) hold = { value: v, action: { pick, flip: f < 0 ? null : f, hold: true } };
      }
    });
    if (hold.value > best.value + HOLD_EDGE) return hold.action;
  }

  // Peek: spend it on a close call (two different placements nearly level), or
  // before it expires.
  if (view.powers.peek) {
    const rival = options.find((o) => o.action.zone !== best.action.zone || o.action.pick !== best.action.pick);
    if ((rival && best.value - rival.value < PEEK_GAP) || view.turn === view.turns - 2) return { peek: true };
  }
  return best.action;
}

// choose(view, ctx) → action.  ctx = { variant, table, rand, solver }
// `solver` is only needed by bots with `needsSolver`.
export const BOTS = [
  { id: 'tourist', name: 'Tourist', tier: 1, blurb: 'Drops dice wherever there is room.', choose: tourist },
  { id: 'regular', name: 'Regular', tier: 2, blurb: 'Always takes the biggest payout on the table right now.', choose: regular },
  { id: 'grinder', name: 'Grinder', tier: 3, blurb: 'Weighs each payout against what the zone usually earns.', choose: grinder },
  { id: 'shark', name: 'Shark', tier: 4, blurb: 'Plays the exact odds on every roll.', choose: shark, needsSolver: true },
  { id: 'house', name: 'The House', tier: 5, blurb: 'Plays the odds, holds rolls back and looks ahead.', choose: house, needsSolver: true },
];

export const getBot = (id) => BOTS.find((b) => b.id === id) || BOTS[0];
