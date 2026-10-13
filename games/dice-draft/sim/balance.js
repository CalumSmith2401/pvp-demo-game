// Headless balance simulator. Plays seeded bot-vs-bot matches through the real
// match layer and reports whether the game is demonstrably skill-based.
//
//   node sim/balance.js                 print the report
//   node sim/balance.js --write         also write it to BALANCE.md
//   node sim/balance.js --matches 4000  quicker, noisier run
//
// Re-run with --write after any change to the zone pool or the extras in js/config.js.
//
// Arcade deals a different table every match, and each table has to be solved
// before the solver can play it, so matches are spread over TABLES tables: every
// pairing plays the same roll sequences on the same tables.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, VARIANTS, DEFAULT_VARIANT, POWERS, buildVariant, TIEBREAK_ZONES_WON } from '../js/config.js';
import { BOTS, getBot } from '../js/bots.js';
import { makeTable } from '../js/engine.js';
import { createSolver } from '../js/solver.js';
import { playMatch } from './play.js';

const args = process.argv.slice(2);
const N = args.includes('--matches') ? Number(args[args.indexOf('--matches') + 1]) : 100000;
const TABLES = 50;
const BATCHES = 10;

// ---------- measurement ----------
// A plays seat `a`, B plays seat `b`: n matches spread evenly over the tables.
function series(variant, botA, botB, n = N, onMatch) {
  const out = { n: 0, a: 0, b: 0, draw: 0, level: 0, sumA: 0, sumB: 0, sumGap2: 0, batchWins: [] };
  const per = Math.max(1, Math.floor(n / TABLES));
  let batch = 0, inBatch = 0;
  const batchSize = Math.floor((per * TABLES) / BATCHES);
  for (let k = 0; k < per; k++) {
    for (let table = 1; table <= TABLES; table++) {
      const match = playMatch(table * 100003 + k, variant, botA, botB, table);
      const r = match.result();
      out.n++;
      out[r.result]++;
      if (r.result === 'a') batch++;
      if (r.totalA === r.totalB) out.level++;
      out.sumA += r.totalA;
      out.sumB += r.totalB;
      out.sumGap2 += (r.totalA - r.totalB) ** 2;
      if (++inBatch === batchSize) { out.batchWins.push(batch / batchSize); batch = 0; inBatch = 0; }
      if (onMatch) onMatch(match, r);
    }
  }
  out.meanA = out.sumA / out.n;
  out.meanB = out.sumB / out.n;
  out.gap = out.meanA - out.meanB;
  out.gapSd = Math.sqrt(out.sumGap2 / out.n - out.gap ** 2);
  return out;
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const num = (x, d = 1) => x.toFixed(d);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const wdl = (s) => `${pct(s.a / s.n)} / ${pct(s.draw / s.n)} / ${pct(s.b / s.n)}`;
const decided = (s) => s.a / Math.max(1, s.a + s.b);
const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// Where a bot's points come from, zone by zone and extra by extra.
function profile(variant, bot, n) {
  const zones = new Map(variant.pool.map((z) => [z.id, { zone: z, dealt: 0, pts: 0, blank: 0, turn: 0, hot: 0 }]));
  const parts = { base: 0, gold: 0, multiplier: 0, streak: 0, sweep: 0, bounty: 0 };
  const used = Object.fromEntries(variant.powers.map((p) => [p, 0]));
  let matches = 0, total = 0;
  series(variant, bot, getBot('regular'), n, (match, r) => {
    matches++;
    total += r.totalA;
    const me = match.view('a');
    me.board.forEach((e, i) => {
      const z = zones.get(match.table.zones[i].id);
      z.dealt++;
      z.pts += e.total;
      z.turn += e.turn + 1;
      if (!e.base) z.blank++;
      if (match.table.hot === i) z.hot++;
      parts.base += e.base;
      parts.gold += e.goldPts;
      parts.multiplier += (e.base + e.goldPts) * (e.mult - 1);
      parts.streak += e.streakBonus;
      parts.sweep += e.sweep;
    });
    parts.bounty += r.zones.reduce((s, z) => s + z.a.bounty, 0);
    for (const p of variant.powers) if (!me.powers[p]) used[p]++;
  });
  return { zones: [...zones.values()].filter((z) => z.dealt), parts, used, matches, mean: total / matches };
}

// ---------- the report ----------
const t0 = Date.now();
const arcade = buildVariant(DEFAULT_VARIANT);
const bot = getBot;
const out = [];
const say = (s = '') => out.push(s);
const checks = [];
const check = (name, pass, detail) => { checks.push([name, pass === null ? 'NOTE' : pass ? 'PASS' : 'FAIL', detail]); };
const progress = (msg) => process.stderr.write(`  ${msg} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

// 1. solver vs random
const vsRandom = series(arcade, bot('shark'), bot('tourist'));
check('1. Solver beats random', vsRandom.a / vsRandom.n >= 0.95 && Math.min(...vsRandom.batchWins) >= 0.95,
  `wins ${pct(vsRandom.a / vsRandom.n)}, mean gap ${signed(vsRandom.gap)} pts`);
progress('solver vs random');

// 2. solver vs greedy, plus the rest of the ladder
const vsGreedy = series(arcade, bot('shark'), bot('regular'));
check('2. Solver beats greedy', vsGreedy.a >= 3 * vsGreedy.b && vsGreedy.a / vsGreedy.n >= 0.65,
  `wins ${pct(vsGreedy.a / vsGreedy.n)}, loses ${pct(vsGreedy.b / vsGreedy.n)}, mean gap ${signed(vsGreedy.gap)} pts`);
const ladder = [];
for (let i = 1; i < BOTS.length; i++) {
  ladder.push([BOTS[i], BOTS[i - 1], series(arcade, BOTS[i], BOTS[i - 1], Math.min(N, BOTS[i].id === 'house' ? 20000 : 40000))]);
  progress(`${BOTS[i].name} vs ${BOTS[i - 1].name}`);
}
const ordered = ladder.every(([, , s]) => s.a > s.b);

// 3. where the points come from
const prof = profile(arcade, bot('shark'), Math.min(N, 20000));
const totalParts = Object.values(prof.parts).reduce((x, y) => x + y, 0);
const zoneRows = prof.zones.map((z) => ({ ...z, mean: z.pts / z.dealt })).sort((x, y) => y.mean - x.mean);
const zoneShare = zoneRows.map((z) => z.pts / prof.zones.reduce((s, q) => s + q.pts, 0) / (z.dealt / prof.zones.reduce((s, q) => s + q.dealt, 0)));
const topZone = Math.max(...zoneShare), lowZone = Math.min(...zoneShare);
const topPart = Math.max(...Object.entries(prof.parts).filter(([k]) => k !== 'base').map(([, v]) => v / totalParts));
check('3. No dominant zone or extra', topZone <= 2.5 && topPart <= 0.25,
  `the best zone earns ${num(topZone, 1)}× an average zone's points when dealt, the weakest ${num(lowZone, 1)}×; the largest extra is ${pct(topPart, 0)} of all points`);
progress('profile');

// 4. mirror match
const mirror = series(arcade, bot('shark'), bot('shark'), Math.min(N, 20000));
const houseVsShark = ladder[ladder.length - 1][2];
const houseMirror = series(arcade, bot('house'), bot('house'), Math.min(N, 5000));
check('4. Mirror match is not a tie', null,
  `identical solvers draw ${pct(mirror.draw / mirror.n, 0)} (by construction); the bot that also uses Hold and Peek beats the plain solver ${pct(houseVsShark.a / houseVsShark.n)} to ${pct(houseVsShark.b / houseVsShark.n)}`);
progress('mirror');

// 5. seat fairness
const seatN = Math.min(N, 10000);
const detA = series(arcade, bot('shark'), bot('house'), seatN);
const detB = series(arcade, bot('house'), bot('shark'), seatN);
const exactMirror = detA.a === detB.b && detA.b === detB.a && detA.draw === detB.draw;
const randomMirror = series(arcade, bot('tourist'), bot('tourist'));
const seatSkew = (randomMirror.a - randomMirror.b) / randomMirror.n;
const seatNoise = 3 * Math.sqrt((randomMirror.a + randomMirror.b) / randomMirror.n) / Math.sqrt(randomMirror.n); // 3σ of the difference
check('5. No seat advantage', exactMirror && Math.abs(seatSkew) <= seatNoise,
  `swapping seats mirrors results ${exactMirror ? 'exactly' : 'INEXACTLY'}; random-vs-random seat A ${pct(randomMirror.a / randomMirror.n)} vs seat B ${pct(randomMirror.b / randomMirror.n)}`);
progress('seats');

// the original game, for comparison
const classic = buildVariant('classic');
const classicN = Math.min(N, 40000);
const classicRandom = series(classic, bot('shark'), bot('tourist'), classicN);
const classicGreedy = series(classic, bot('shark'), bot('regular'), classicN);
const classicGrinder = series(classic, bot('shark'), bot('grinder'), classicN);
const arcadeGrinder = ladder[2][2];
progress('classic');

const startValues = Array.from({ length: TABLES }, (_, i) => createSolver(arcade, makeTable(i + 1, arcade)).solve().startValue());

say(`# ${GAME_NAME} — balance report`);
say();
say(`Generated by \`node sim/balance.js --write\`. ${N.toLocaleString('en-GB')} seeded matches for checks 1 and 2, fewer where stated, every one played`);
say(`through the authoritative match layer (\`js/match.js\`) on the ${arcade.name} rules, spread over ${TABLES} dealt tables.`);
say('Win / draw / loss figures are from the first-named player\'s side.');
say();
say('## Verdict');
say();
say(table(['Check', 'Result', 'Headline'], checks));
say();
say('Read these before relying on the table:');
say();
say('- **"Solver" is no longer provably optimal.** It is exact for everything except Hold and Peek: which roll');
say('  to take, where to put it, and when to spend Flip and Double. The House adds Hold and Peek by searching');
say('  one turn ahead, and beats it, so the true optimum is higher than either.');
say(`- **Check 4 does not hold as the original brief wrote it.** Two players with the same information and the`);
say('  same deterministic policy make identical moves and draw every time. That is true of any');
say('  shared-sequence game.');
say(`- **The extras made the game deeper, and swingier.** Greedy play now scores ${pct(vsGreedy.meanB / vsGreedy.meanA, 0)} of the solver's points`);
say(`  (it was ${pct(classicGreedy.meanB / classicGreedy.meanA, 0)} in the original game) and the one-step Grinder heuristic ${pct(arcadeGrinder.meanB / arcadeGrinder.meanA, 0)} (was ${pct(classicGrinder.meanB / classicGrinder.meanA, 0)}).`);
say(`  Scores are about ${num(vsGreedy.meanA / classicGreedy.meanA, 1)}× larger and the multipliers stack, so single placements decide more.`);
say();

say('## 1. Solver vs random');
say();
say(table(['Pairing', 'Win / draw / loss', 'Mean score', 'Mean gap', 'Win rate across 10 batches'], [
  ['Solver vs random', wdl(vsRandom), `${num(vsRandom.meanA)} vs ${num(vsRandom.meanB)}`, `${signed(vsRandom.gap)} (sd ${num(vsRandom.gapSd)})`,
    `${pct(Math.min(...vsRandom.batchWins))} – ${pct(Math.max(...vsRandom.batchWins))}`],
]));
say();
say(`The solver's own expected score ranges from ${num(Math.min(...startValues))} to ${num(Math.max(...startValues))} across the ${TABLES} tables (mean ${num(startValues.reduce((x, y) => x + y, 0) / TABLES)}),`);
say('before bounties. Both players always share a table, so a rich or poor deal favours neither.');
say();

say('## 2. Solver vs greedy, and the skill ladder');
say();
say(table(['Pairing', 'Win / draw / loss', 'Share of decided games', 'Mean score', 'Mean gap'], [
  ['Solver vs greedy', wdl(vsGreedy), pct(decided(vsGreedy)), `${num(vsGreedy.meanA)} vs ${num(vsGreedy.meanB)}`, `${signed(vsGreedy.gap)} (sd ${num(vsGreedy.gapSd)})`],
]));
say();
say(`Each bot against the tier below it. The ladder is ${ordered ? 'monotonic: better decisions win' : '**not monotonic — investigate**'}.`);
say();
say(table(['Stronger', 'Weaker', 'Matches', 'Win / draw / loss', 'Share of decided games', 'Mean gap'],
  ladder.map(([hi, lo, s]) => [`${hi.tier} ${hi.name}`, `${lo.tier} ${lo.name}`, s.n.toLocaleString('en-GB'), wdl(s), pct(decided(s)), signed(s.gap)])));
say();
say('Tourist = random with no power-ups. Regular = greedy. Grinder = greedy net of each zone\'s average payout.');
say('Shark = the solver. The House = the solver plus Hold and Peek.');
say();

say('## 3. Where the points come from (solver play)');
say();
say(`${prof.matches.toLocaleString('en-GB')} matches. Mean score ${num(prof.mean)}.`);
say();
say(table(['Source', 'Mean pts per match', 'Share'], [
  ['Zone payouts', num(prof.parts.base / prof.matches), pct(prof.parts.base / totalParts)],
  ['Golden die', num(prof.parts.gold / prof.matches), pct(prof.parts.gold / totalParts)],
  ['Hot zone and Double (the extra 1×)', num(prof.parts.multiplier / prof.matches), pct(prof.parts.multiplier / totalParts)],
  ['Streak', num(prof.parts.streak / prof.matches), pct(prof.parts.streak / totalParts)],
  ['Sweeps', num(prof.parts.sweep / prof.matches), pct(prof.parts.sweep / totalParts)],
  ['Bounties', num(prof.parts.bounty / prof.matches), pct(prof.parts.bounty / totalParts)],
]));
say();
say(`Streak tops out at ${arcade.streak.step * [...Array(arcade.rolls).keys()].reduce((s, i) => s + Math.min(i, arcade.streak.cap), 0)} and sweeps at ${arcade.sweep * 2}; the solver collects ${pct(prof.parts.streak / prof.matches / (arcade.streak.step * [...Array(arcade.rolls).keys()].reduce((s, i) => s + Math.min(i, arcade.streak.cap), 0)), 0)} and ${pct(prof.parts.sweep / prof.matches / (arcade.sweep * 2), 0)} of those on average.`);
say();
say('Power-ups the solver spent (Shark never uses Hold or Peek; The House\'s use is below):');
say();
const houseProf = profile(arcade, bot('house'), Math.min(N, 5000));
say(table(['Power-up', 'What it does', 'Shark', 'The House'], arcade.powers.map((p) =>
  [POWERS[p].name, POWERS[p].blurb, pct(prof.used[p] / prof.matches, 0), pct(houseProf.used[p] / houseProf.matches, 0)])));
say();
say('Zones, when dealt (each is on the table in about 8 matches in 14):');
say();
say(table(['Zone', 'Rule', 'Pays', 'Mean pts when dealt', 'Left blank', 'Mean turn filled'],
  zoneRows.map((z) => [z.zone.name, z.zone.rule, z.zone.hint, num(z.mean), pct(z.blank / z.dealt), num(z.turn / z.dealt, 1)])));
say();
say('"Mean pts" includes the golden die, multipliers and streak landing on that zone, so it is not the pay');
say('table value. Triple and Straight are the hold-open zones: filled late and often for nothing, as intended.');
say();

say('## 4. Mirror match');
say();
say(table(['Pairing', 'Matches', 'Win / draw / loss', 'Share of decided games'], [
  ['Solver vs solver (identical policy)', mirror.n.toLocaleString('en-GB'), wdl(mirror), '–'],
  ['The House vs solver', houseVsShark.n.toLocaleString('en-GB'), wdl(houseVsShark), pct(decided(houseVsShark))],
  ['The House vs The House', houseMirror.n.toLocaleString('en-GB'), wdl(houseMirror), '–'],
]));
say();
say(`Equal totals are ${TIEBREAK_ZONES_WON ? 'broken by zones won' : 'a draw'}. In solver-vs-greedy play ${pct(vsGreedy.level / vsGreedy.n)} of matches finish level on points`);
say(`and ${pct(vsGreedy.draw / vsGreedy.n)} remain drawn after the tie-break.`);
say();

say('## 5. Seat fairness');
say();
say(table(['Pairing', 'Seat A wins', 'Draw', 'Seat B wins'], [
  ['Solver (A) vs The House (B)', pct(detA.a / detA.n), pct(detA.draw / detA.n), pct(detA.b / detA.n)],
  ['The House (A) vs solver (B), same seeds', pct(detB.a / detB.n), pct(detB.draw / detB.n), pct(detB.b / detB.n)],
  ['Random (A) vs random (B)', pct(randomMirror.a / randomMirror.n), pct(randomMirror.draw / randomMirror.n), pct(randomMirror.b / randomMirror.n)],
]));
say();
say('Both seats receive the same table and the same rolls, and the scoring, bounty and tie-break code has no');
say(`seat-dependent branch. The deterministic pairing mirrors ${exactMirror ? 'exactly' : '**inexactly — investigate**'} when seats are swapped. Random-vs-random`);
say(`seat skew is ${(100 * seatSkew).toFixed(2)} percentage points, against a 3σ noise band of ±${(100 * seatNoise).toFixed(2)}.`);
say();

say('## Arcade against the original game');
say();
say(table(['Rules', 'Solver vs random', 'Solver vs greedy (W / D / L)', 'Greedy scores', 'Solver vs Grinder (W / D / L)', 'Grinder scores'], [
  [`${classic.name} (no extras)`, pct(classicRandom.a / classicRandom.n), wdl(classicGreedy), `${pct(classicGreedy.meanB / classicGreedy.meanA, 0)} of solver`, wdl(classicGrinder), `${pct(classicGrinder.meanB / classicGrinder.meanA, 0)} of solver`],
  [arcade.name, pct(vsRandom.a / vsRandom.n), wdl(vsGreedy), `${pct(vsGreedy.meanB / vsGreedy.meanA, 0)} of solver`, wdl(arcadeGrinder), `${pct(arcadeGrinder.meanB / arcadeGrinder.meanA, 0)} of solver`],
]));
say();
say('The original report\'s main caveat was that a simple heuristic was nearly optimal. That gap is the thing');
say('to watch in this table.');
say();

say('## Other variants');
say();
const variantRows = Object.keys(VARIANTS).filter((id) => id !== DEFAULT_VARIANT && id !== 'classic').map((id) => {
  const v = buildVariant(id);
  const n = Math.min(N, 10000);
  const r = series(v, bot('shark'), bot('tourist'), n);
  const g = series(v, bot('shark'), bot('regular'), n);
  return [v.name, pct(r.a / r.n), wdl(g), `${num(g.meanA)} vs ${num(g.meanB)}`];
});
say(table(['Variant', 'Solver vs random', 'Solver vs greedy (W / D / L)', 'Mean score'], variantRows));
say();
say(`${Math.min(N, 10000).toLocaleString('en-GB')} matches each. A new season should clear checks 1 to 3 before it ships.`);
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
