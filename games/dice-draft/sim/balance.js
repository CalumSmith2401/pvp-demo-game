// Headless balance simulator. Plays seeded bot-vs-bot matches through the real
// match layer and reports whether the game is demonstrably skill-based.
//
//   node sim/balance.js                 print the report (100,000 matches per pairing)
//   node sim/balance.js --write         also write it to BALANCE.md
//   node sim/balance.js --matches 5000  quicker, noisier run
//
// Re-run with --write after any change to the pay table in js/config.js.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, VARIANTS, buildVariant, TIEBREAK_ZONES_WON } from '../js/config.js';
import { BOTS, getBot, HOUSE } from '../js/bots.js';
import { solverFor } from '../js/solver.js';
import { emptyBoard, openZones } from '../js/engine.js';
import { playMatch } from './play.js';

const args = process.argv.slice(2);
const N = args.includes('--matches') ? Number(args[args.indexOf('--matches') + 1]) : 100000;
const BATCHES = 10;

// The pay table from the original brief, kept only so the report can show what tuning changed.
const BRIEF_PAY = {
  small: { base: 1, step: 1 }, big: { base: 1, step: 1 }, triple: { points: 30 },
  double: { points: 8, perPip: 0 }, straight: { points: 15 },
  sixes: { first: 4, extra: 4 }, ones: { first: 4, extra: 4 }, total: { mult: 0.5 },
};

// A strong-but-human player: the solver, except it takes the second-best zone
// one decision in `rate`.
const slipper = (rate) => ({
  id: 'slipper', name: `Near-expert (slips 1 in ${rate})`,
  choose(view, { variant, rand }) {
    const s = solverFor(variant);
    const ranked = openZones(view.board).sort((x, y) => s.value(view.board, view.roll, y) - s.value(view.board, view.roll, x));
    return ranked.length > 1 && rand() < 1 / rate ? ranked[1] : ranked[0];
  },
});

// ---------- measurement ----------
// A plays seat `a`, B plays seat `b`, over seeds 1..n.
function series(variant, botA, botB, n = N, onMatch) {
  const out = { n, a: 0, b: 0, draw: 0, level: 0, sumA: 0, sumB: 0, sumGap2: 0, batchWins: [] };
  const per = Math.floor(n / BATCHES);
  let batch = 0;
  for (let i = 1; i <= n; i++) {
    const match = playMatch(i, variant, botA, botB);
    const r = match.result();
    out[r.result]++;
    if (r.result === 'a') batch++;
    if (r.totalA === r.totalB) out.level++;
    out.sumA += r.totalA;
    out.sumB += r.totalB;
    out.sumGap2 += (r.totalA - r.totalB) ** 2;
    if (i % per === 0) { out.batchWins.push(batch / per); batch = 0; }
    if (onMatch) onMatch(match, r);
  }
  out.meanA = out.sumA / n;
  out.meanB = out.sumB / n;
  out.gap = out.meanA - out.meanB;
  out.gapSd = Math.sqrt(out.sumGap2 / n - out.gap ** 2);
  return out;
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const num = (x, d = 1) => x.toFixed(d);
const wdl = (s) => `${pct(s.a / s.n)} / ${pct(s.draw / s.n)} / ${pct(s.b / s.n)}`;
const decided = (s) => s.a / Math.max(1, s.a + s.b);
const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// Where the solver's points come from, and how it uses each zone.
function zoneProfile(variant, n = N) {
  const Z = variant.zones.length;
  const s = solverFor(variant);
  const pts = Array(Z).fill(0), bust = Array(Z).fill(0), turn = Array(Z).fill(0), last = Array(Z).fill(0);
  series(variant, getBot('shark'), getBot('shark'), n, (match) => {
    for (const e of match.log()) {
      if (e.player !== 'a') continue;
      const z = variant.zones.findIndex((zone) => zone.id === e.zone);
      pts[z] += e.points;
      turn[z] += e.turn;
      if (!e.points) bust[z]++;
      if (e.turn === variant.rolls) last[z]++;
    }
  });
  // "Best home" on an untouched board: the zone the solver sends each possible
  // roll to, weighted by how likely the roll is.
  const home = Array(Z).fill(0);
  s.table.rolls.forEach((roll, r) => { home[s.pick(emptyBoard(variant), roll)] += s.table.prob[r]; });
  const total = pts.reduce((x, y) => x + y, 0);
  return variant.zones.map((zone, z) => ({
    zone, share: pts[z] / total, mean: pts[z] / n, bust: bust[z] / n,
    turn: turn[z] / n, last: last[z] / n, home: home[z],
  }));
}

// ---------- the report ----------
const t0 = Date.now();
const classic = buildVariant('classic');
const brief = buildVariant('classic', { pay: BRIEF_PAY });
const bot = getBot;
const out = [];
const say = (s = '') => out.push(s);
const checks = [];
const check = (name, pass, detail) => { checks.push([name, pass === null ? 'NOTE' : pass ? 'PASS' : 'FAIL', detail]); };

// 1. optimal vs random
const vsRandom = series(classic, bot('shark'), bot('tourist'));
check('1. Solver beats random', vsRandom.a / N >= 0.95 && Math.min(...vsRandom.batchWins) >= 0.95,
  `wins ${pct(vsRandom.a / N)}, mean gap +${num(vsRandom.gap)} pts`);

// 2. optimal vs greedy, plus the rest of the ladder
const vsGreedy = series(classic, bot('shark'), bot('regular'));
check('2. Solver beats greedy', vsGreedy.a >= 3 * vsGreedy.b && vsGreedy.a / N >= 0.65,
  `wins ${pct(vsGreedy.a / N)}, loses ${pct(vsGreedy.b / N)}, mean gap +${num(vsGreedy.gap)} pts`);
const ladder = [];
for (let i = 1; i < BOTS.length; i++) ladder.push([BOTS[i], BOTS[i - 1], series(classic, BOTS[i], BOTS[i - 1])]);

// 3. zone balance
const zones = zoneProfile(classic);
const maxShare = Math.max(...zones.map((z) => z.share));
const minShare = Math.min(...zones.map((z) => z.share));
const maxHome = Math.max(...zones.map((z) => z.home));
check('3. No dominant zone', maxShare <= 0.25 && minShare >= 0.05 && maxHome <= 0.4,
  `largest share of solver points ${pct(maxShare)}, smallest ${pct(minShare)}; top first-roll home ${pct(maxHome)}`);

// 4. mirror match
const mirror = series(classic, bot('shark'), bot('shark'));
const houseVsShark = series(classic, bot('house'), bot('shark'));
const houseMirror = series(classic, bot('house'), bot('house'));
const shippingDepth = HOUSE.endgame;
HOUSE.endgame = classic.rolls;
const fullHouse = { ...bot('house'), id: 'house-full' };
const bestResponse = series(classic, fullHouse, bot('shark'));
const bestMirror = series(classic, fullHouse, fullHouse);
HOUSE.endgame = shippingDepth;
const slips = series(classic, slipper(8), slipper(8));
check('4. Mirror match is not a tie', null,
  `identical solvers draw ${pct(mirror.draw / N, 0)} (by construction); a solver that reads the scoreboard beats the pure-odds solver ${pct(bestResponse.a / N)} to ${pct(bestResponse.b / N)}`);

// 5. seat fairness
const seatA = series(classic, bot('shark'), bot('regular'));
const seatB = series(classic, bot('regular'), bot('shark'));
const randomMirror = series(classic, bot('tourist'), bot('tourist'));
const seatSkew = (randomMirror.a - randomMirror.b) / N;
const seatNoise = 3 * Math.sqrt((randomMirror.a + randomMirror.b) / N) / Math.sqrt(N); // 3σ of the difference
// The two seats draw tie-breaks from different streams, so compare a deterministic pairing exactly.
const detA = series(classic, bot('shark'), bot('house'), Math.min(N, 20000));
const detB = series(classic, bot('house'), bot('shark'), Math.min(N, 20000));
const exactMirror = detA.a === detB.b && detA.b === detB.a && detA.draw === detB.draw;
check('5. No seat advantage', exactMirror && Math.abs(seatSkew) <= seatNoise,
  `swapping seats mirrors results exactly; random-vs-random seat A ${pct(randomMirror.a / N)} vs seat B ${pct(randomMirror.b / N)}`);

// what tuning changed
const briefRandom = series(brief, bot('shark'), bot('tourist'));
const briefGreedy = series(brief, bot('shark'), bot('regular'));
const briefZones = zoneProfile(brief, Math.min(N, 20000));

const solverEV = (v) => solverFor(v).ev[(1 << v.zones.length) - 1];

say(`# ${GAME_NAME} — balance report`);
say();
say(`Generated by \`node sim/balance.js --write\`. ${N.toLocaleString('en-GB')} seeded matches per pairing (seeds 1–${N}), every`);
say('one played through the authoritative match layer (`js/match.js`), Classic pay table unless stated.');
say('Win / draw / loss figures are from the first-named player\'s side.');
say();
say('## Verdict');
say();
say(table(['Check', 'Result', 'Headline'], checks));
say();
say('Two things to read before relying on this:');
say();
say(`- **Check 2 passes, but the ceiling above a simple heuristic is low.** Greedy play still scores ${pct(vsGreedy.meanB / vsGreedy.meanA, 0)} of`);
say(`  the solver's points, and the one-step "Grinder" heuristic scores ${pct(ladder[2][2].meanB / ladder[2][2].meanA, 0)}. Tuning point values moved this only`);
say('  a little (see "What tuning changed"). The limit is structural: zones score independently, so there is');
say('  not much for deep planning to find. See Recommendations.');
say(`- **Check 4 does not hold as the brief wrote it.** Two players with the same information and the same`);
say('  deterministic policy place every roll identically and draw every time. That is true of any');
say('  shared-sequence game. What the data does show is that the match is not a pure solitaire race: a player');
say('  who watches the opponent\'s board and plays for the win, not the average, beats the pure-odds solver.');
say();

say('## 1. Optimal vs random');
say();
say(table(['Pairing', 'Win / draw / loss', 'Mean score', 'Mean gap', 'Win rate across 10 batches'], [
  ['Solver vs random', wdl(vsRandom), `${num(vsRandom.meanA)} vs ${num(vsRandom.meanB)}`, `+${num(vsRandom.gap)} (sd ${num(vsRandom.gapSd)})`,
    `${pct(Math.min(...vsRandom.batchWins))} – ${pct(Math.max(...vsRandom.batchWins))}`],
]));
say();
say(`The solver's exact expected score is ${num(solverEV(classic), 2)}; the simulated mean is ${num(vsRandom.meanA, 2)}.`);
say();

say('## 2. Optimal vs greedy, and the skill ladder');
say();
say(table(['Pairing', 'Win / draw / loss', 'Share of decided games', 'Mean score', 'Mean gap'], [
  ['Solver vs greedy', wdl(vsGreedy), pct(decided(vsGreedy)), `${num(vsGreedy.meanA)} vs ${num(vsGreedy.meanB)}`, `+${num(vsGreedy.gap)} (sd ${num(vsGreedy.gapSd)})`],
]));
say();
say('Each bot against the tier below it. A monotonic ladder is the evidence that better decisions win:');
say();
say(table(['Stronger', 'Weaker', 'Win / draw / loss', 'Share of decided games', 'Mean gap'],
  ladder.map(([hi, lo, s]) => [`${hi.tier} ${hi.name}`, `${lo.tier} ${lo.name}`, wdl(s), pct(decided(s)), `${s.gap >= 0 ? '+' : ''}${num(s.gap)}`])));
say();
say('Tourist = random, Regular = greedy, Grinder = greedy net of each zone\'s average payout, Shark = the');
say(`solver, The House = the solver plus a win-probability search over the last ${shippingDepth} rolls.`);
say();

say('## 3. Zone balance (solver play)');
say();
say('Every match fills all eight zones once, so "share of placements" is 12.5% each by construction. The');
say('useful questions are where the points come from, how often a zone is sacrificed, and where the solver');
say('sends a roll when everything is open.');
say();
say(table(['Zone', 'Rule', 'Pays', 'Share of points', 'Mean pts', 'Scores zero', 'Mean turn filled', 'Filled last', 'First-roll home'],
  zones.map((z) => [z.zone.name, z.zone.rule, z.zone.hint, pct(z.share), num(z.mean, 2), pct(z.bust), num(z.turn, 2), pct(z.last), pct(z.home)])));
say();
say('"First-roll home" is the share of all possible rolls the solver would place in that zone on an empty');
say('board. Triple and Straight are the hold-open zones: filled late and often for nothing, as intended.');
say();

say('## 4. Mirror match');
say();
say(table(['Pairing', 'Win / draw / loss', 'Share of decided games'], [
  ['Solver vs solver (identical policy)', wdl(mirror), '–'],
  [`The House (last ${shippingDepth} rolls) vs solver`, wdl(houseVsShark), pct(decided(houseVsShark))],
  ['Full-depth win-probability player vs solver', wdl(bestResponse), pct(decided(bestResponse))],
  ['Full-depth player vs itself', wdl(bestMirror), '–'],
  ['The House vs The House', wdl(houseMirror), '–'],
  ['Two near-experts (each slips 1 decision in 8)', wdl(slips), '–'],
]));
say();
say('The full-depth player assumes its opponent follows the expected-score line and picks, at every roll, the');
say('zone with the best chance of finishing ahead. Its mean score is lower than the solver\'s');
say(`(${num(bestResponse.meanA, 2)} vs ${num(bestResponse.meanB, 2)}) and it still wins more often: it trades average points for the right`);
say('kind of variance. That is the interactive layer of the game, and it only exists because opponent');
say('placements are revealed turn by turn.');
say();
say(`Equal totals are ${TIEBREAK_ZONES_WON ? 'broken by zones won' : 'a draw'}. In solver-vs-greedy play ${pct(vsGreedy.level / N)} of matches finish level on points`);
say(`and ${pct(vsGreedy.draw / N)} remain drawn after the tie-break.`);
say();

say('## 5. Seat fairness');
say();
say(table(['Pairing', 'Seat A wins', 'Draw', 'Seat B wins'], [
  ['Solver (A) vs greedy (B)', pct(seatA.a / N), pct(seatA.draw / N), pct(seatA.b / N)],
  ['Greedy (A) vs solver (B), same seeds', pct(seatB.a / N), pct(seatB.draw / N), pct(seatB.b / N)],
  ['Solver (A) vs The House (B)', pct(detA.a / detA.n), pct(detA.draw / detA.n), pct(detA.b / detA.n)],
  ['The House (A) vs solver (B), same seeds', pct(detB.a / detB.n), pct(detB.draw / detB.n), pct(detB.b / detB.n)],
  ['Random (A) vs random (B)', pct(randomMirror.a / N), pct(randomMirror.draw / N), pct(randomMirror.b / N)],
]));
say();
say(`Both seats receive the same rolls and the scoring and tie-break code has no seat-dependent branch. The`);
say(`deterministic pairing mirrors ${exactMirror ? 'exactly' : '**inexactly — investigate**'} when seats are swapped. Greedy breaks equal payouts at random from a`);
say('per-seat stream, so its rows differ by sampling noise only. Random-vs-random seat skew is');
say(`${(100 * seatSkew).toFixed(2)} percentage points, inside the 3σ noise band of ±${(100 * seatNoise).toFixed(2)}.`);
say();

say('## What tuning changed');
say();
say(table(['Pay table', 'Small / Big', 'Double', 'Total', 'Solver vs random', 'Solver vs greedy (W / D / L)', 'Greedy gap', 'Largest zone share'], [
  ['Brief (starting values)', '11 − total / total − 10', '8', 'half the total', pct(briefRandom.a / N), wdl(briefGreedy),
    `+${num(briefGreedy.gap)} (${pct(briefGreedy.gap / briefGreedy.meanA)})`, pct(Math.max(...briefZones.map((z) => z.share)))],
  ['Tuned (shipping)', '2 × that', '10', 'the total', pct(vsRandom.a / N), wdl(vsGreedy),
    `+${num(vsGreedy.gap)} (${pct(vsGreedy.gap / vsGreedy.meanA)})`, pct(maxShare)],
]));
say();
say('Triple (30), Straight (15) and Sixes / Ones (4 per die) kept their starting values. The search covered');
say('about 2,500 pay tables; doubling Small / Big and paying the full total on Total gives the greediest');
say('player more tempting early cash-ins that the solver declines. Nothing in the searched space pushed the');
say('solver much past a 75 / 15 split against greedy.');
say();

say('## Variants');
say();
const variantRows = Object.keys(VARIANTS).map((id) => {
  const v = buildVariant(id);
  const n = Math.min(N, 20000);
  const r = series(v, bot('shark'), bot('tourist'), n);
  const g = series(v, bot('shark'), bot('regular'), n);
  const z = zoneProfile(v, n);
  const top = z.reduce((x, y) => (y.share > x.share ? y : x));
  return [v.name, num(solverEV(v), 1), pct(r.a / n), wdl(g), `${top.zone.name} ${pct(top.share)}`];
});
say(table(['Variant', 'Solver expected score', 'Solver vs random', 'Solver vs greedy (W / D / L)', 'Largest zone share'], variantRows));
say();
say(`${Math.min(N, 20000).toLocaleString('en-GB')} matches each. A new season should clear the same three bars before it ships.`);
say();

say('## Recommendations');
say();
say('- **Add one cross-zone rule if more depth is wanted.** A bonus that depends on two or more zones (for');
say('  example, a payout for scoring in both Small and Big, or in every zone of a row) makes placements');
say('  interact, which is what a greedy player cannot see. Point values alone will not get there.');
say('- **Decide whether mid-match reveals stay.** Showing the opponent\'s board each turn is what gives the');
say('  reading-the-opponent edge in check 4. Hiding boards until the end turns the game into two solitaire');
say('  runs compared at the finish; simpler to explain, and identical optimal play then always draws.');
say('- **Expect draws between strong players.** Two near-experts draw about a third of the time. If the');
say('  platform needs a winner, add a second tie-break (for example fastest total decision time).');
say();

const report = out.join('\n') + '\n';
console.log(report);
console.error(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (args.includes('--write')) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'BALANCE.md');
  writeFileSync(file, report);
  console.error(`wrote ${file}`);
}
if (checks.some((c) => c[1] === 'FAIL')) process.exitCode = 1;
