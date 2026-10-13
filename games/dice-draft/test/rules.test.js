import assert from 'node:assert';
import { buildVariant, VARIANTS, GAME_NAME } from '../js/config.js';
import { makeRolls, buildReveal, boardTotal, emptyBoard } from '../js/engine.js';
import { createMatch } from '../js/match.js';
import { buildSolver, rollTable } from '../js/solver.js';
import { BOTS, getBot } from '../js/bots.js';
import { playMatch } from '../sim/play.js';

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const classic = buildVariant('classic');
const pts = (id, roll) => classic.zones.find((z) => z.id === id).score(roll);

console.log('zone scoring (classic pay table)');

t('title lives in one constant', () => assert.strictEqual(typeof GAME_NAME, 'string'));

t('Small pays 2 per pip under 11, nothing from 11 up', () => {
  assert.strictEqual(pts('small', [1, 1, 2]), 14);
  assert.strictEqual(pts('small', [3, 3, 4]), 2);
  assert.strictEqual(pts('small', [5, 5, 1]), 0);
});

t('Big pays 2 per pip over 10, nothing from 10 down', () => {
  assert.strictEqual(pts('big', [6, 6, 5]), 14);
  assert.strictEqual(pts('big', [5, 5, 1]), 2);
  assert.strictEqual(pts('big', [3, 3, 4]), 0);
});

t('a triple scores nothing in Small or Big', () => {
  assert.strictEqual(pts('small', [1, 1, 1]), 0);
  assert.strictEqual(pts('small', [2, 2, 2]), 0);
  assert.strictEqual(pts('big', [5, 5, 5]), 0);
  assert.strictEqual(pts('big', [6, 6, 6]), 0);
});

t('Triple needs all three to match', () => {
  assert.strictEqual(pts('triple', [4, 4, 4]), 30);
  assert.strictEqual(pts('triple', [4, 4, 5]), 0);
});

t('Double counts a pair, and a triple', () => {
  assert.strictEqual(pts('double', [2, 5, 2]), 10);
  assert.strictEqual(pts('double', [3, 3, 3]), 10);
  assert.strictEqual(pts('double', [1, 2, 3]), 0);
});

t('Straight is three consecutive faces in any order', () => {
  assert.strictEqual(pts('straight', [4, 2, 3]), 15);
  assert.strictEqual(pts('straight', [6, 4, 5]), 15);
  assert.strictEqual(pts('straight', [1, 2, 4]), 0);
  assert.strictEqual(pts('straight', [6, 1, 2]), 0); // no wrap-around
  assert.strictEqual(pts('straight', [3, 3, 4]), 0);
});

t('Sixes and Ones pay per matching die', () => {
  assert.strictEqual(pts('sixes', [6, 6, 1]), 8);
  assert.strictEqual(pts('ones', [6, 6, 1]), 4);
  assert.strictEqual(pts('sixes', [2, 3, 4]), 0);
  assert.strictEqual(pts('ones', [1, 1, 1]), 12);
});

t('Total is never zero', () => {
  assert.strictEqual(pts('total', [1, 1, 1]), 3);
  assert.strictEqual(pts('total', [6, 6, 6]), 18);
});

t('each zone advertises its true maximum', () => {
  for (const id of Object.keys(VARIANTS)) {
    const v = buildVariant(id);
    const { rolls } = rollTable(v.dice);
    for (const z of v.zones) assert.strictEqual(Math.max(...rolls.map(z.score)), z.max, `${id}/${z.id}`);
  }
});

console.log('variants and parameters');

t('a season is a data-only override of the pay table', () => {
  const season = buildVariant('triples');
  assert.strictEqual(season.zones.find((z) => z.id === 'triple').score([2, 2, 2]), VARIANTS.triples.pay.triple.points);
  assert.strictEqual(pts('triple', [2, 2, 2]), 30); // classic untouched
  assert.match(season.zones.find((z) => z.id === 'triple').hint, /50/);
});

t('roll count and dice per roll are parameters', () => {
  const craps = buildVariant('classic', { dice: 2, rolls: 5 });
  const rolls = makeRolls(7, craps);
  assert.strictEqual(rolls.length, 5);
  assert.ok(rolls.every((r) => r.length === 2 && r.every((d) => d >= 1 && d <= 6)));
  const score = (id, r) => craps.zones.find((z) => z.id === id).score(r);
  assert.strictEqual(score('small', [1, 2]), 8);   // totals under 7
  assert.strictEqual(score('small', [3, 4]), 0);   // 7 is neither small nor big
  assert.strictEqual(score('big', [3, 4]), 0);
  assert.strictEqual(score('big', [6, 5]), 8);
  assert.strictEqual(score('straight', [4, 5]), 15);
  // five rolls into eight zones: the match ends with three zones still open
  const m = playMatch(3, craps, getBot('shark'), getBot('regular'));
  assert.strictEqual(m.view('a').board.filter(Boolean).length, 5);
  assert.ok(m.result());
});

console.log('shared sequence and reveal');

t('the same seed gives the same rolls; different seeds differ', () => {
  assert.deepStrictEqual(makeRolls(42, classic), makeRolls(42, classic));
  assert.notDeepStrictEqual(makeRolls(42, classic), makeRolls(43, classic));
  assert.strictEqual(makeRolls(42, classic).length, 8);
});

t('reveal resolves zones in table order with running totals', () => {
  const m = playMatch(11, classic, getBot('shark'), getBot('tourist'));
  const r = m.result();
  assert.deepStrictEqual(r.zones.map((z) => z.zone), classic.zones.map((z) => z.id));
  let a = 0, b = 0;
  for (const z of r.zones) {
    a += z.a.points; b += z.b.points;
    assert.strictEqual(z.totalA, a);
    assert.strictEqual(z.totalB, b);
    assert.strictEqual(z.lead, a > b ? 'a' : b > a ? 'b' : 'draw');
  }
  assert.strictEqual(r.totalA, boardTotal(classic, m.view('a').board));
  assert.strictEqual(r.totalB, boardTotal(classic, m.view('b').board));
});

t('higher total wins; level totals go to zones won; level on both is a draw', () => {
  const b = (pairs) => { const board = emptyBoard(classic); for (const [id, roll] of pairs) board[classic.zones.findIndex((z) => z.id === id)] = roll; return board; };
  const high = b([['total', [6, 6, 5]]]);
  const low = b([['total', [1, 1, 2]]]);
  assert.strictEqual(buildReveal(classic, high, low).result, 'a');
  assert.strictEqual(buildReveal(classic, low, high).result, 'b');
  assert.strictEqual(buildReveal(classic, high, high).result, 'draw');
  // 15 points each: one zone for A, two zones for B → B takes the tie-break
  const one = b([['straight', [1, 2, 3]]]);
  const two = b([['double', [2, 2, 5]], ['total', [1, 1, 3]]]);
  const tie = buildReveal(classic, one, two);
  assert.strictEqual(tie.totalA, tie.totalB);
  assert.strictEqual(tie.result, 'b');
  assert.strictEqual(tie.tiebreak, true);
  assert.strictEqual(buildReveal(classic, two, one).result, 'a');
});

console.log('authoritative match layer');

t('opponent placement stays hidden until both have placed', () => {
  const m = createMatch({ seed: 5, variant: classic });
  assert.deepStrictEqual(m.place('a', 'total'), { ok: true, turnComplete: false });
  const seenByB = m.view('b');
  assert.ok(seenByB.oppBoard.every((r) => r === null));
  assert.strictEqual(seenByB.oppLocked, true);
  assert.strictEqual(seenByB.turn, 0);
  assert.strictEqual(m.view('a').placed, classic.zones.findIndex((z) => z.id === 'total'));
  assert.deepStrictEqual(m.log(), []);
  assert.deepStrictEqual(m.place('b', 'double'), { ok: true, turnComplete: true });
  assert.ok(m.view('b').oppBoard[classic.zones.findIndex((z) => z.id === 'total')]);
  assert.strictEqual(m.view('b').turn, 1);
});

t('a view never carries future rolls or the seed', () => {
  const m = createMatch({ seed: 5, variant: classic });
  const v = m.view('a');
  assert.deepStrictEqual(v.roll, makeRolls(5, classic)[0]);
  assert.ok(!JSON.stringify(v).includes(JSON.stringify(makeRolls(5, classic)[1])));
  assert.strictEqual(m.audit(), null);
  assert.strictEqual(m.result(), null);
});

t('placements are final: no second placement, no filled zone, nothing after lock', () => {
  const m = createMatch({ seed: 9, variant: classic });
  m.place('a', 'total');
  assert.strictEqual(m.place('a', 'double').error, 'already-placed');
  m.place('b', 'total');
  assert.strictEqual(m.place('a', 'total').error, 'zone-filled');
  assert.strictEqual(m.place('a', 'nope').error, 'unknown-zone');
  assert.strictEqual(m.place('c', 'double').error, 'unknown-player');
  const done = playMatch(9, classic, getBot('shark'), getBot('shark'));
  assert.strictEqual(done.place('a', 'total').error, 'match-locked');
  assert.strictEqual(done.timeout('a').ok, false);
  assert.deepStrictEqual(done.audit().rolls, makeRolls(9, classic));
});

t('a timeout forfeits into the lowest-value open zone and is flagged', () => {
  const m = createMatch({ seed: 21, variant: classic });
  const res = m.timeout('a');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.zone, 'triple'); // lowest average payout on an open board
  assert.strictEqual(m.timeout('a').ok, false); // already locked for this turn
  m.place('b', 'total');
  const [first] = m.log().filter((e) => e.player === 'a');
  assert.strictEqual(first.auto, true);
  assert.strictEqual(first.zone, 'triple');
  assert.strictEqual(m.log().find((e) => e.player === 'b').auto, false);
});

console.log('solver and bots');

t('solver expected score matches brute-force play on a small table', () => {
  // Two rolls into two zones: enumerate every pair of rolls and both orders of play.
  const tiny = { dice: 2, rolls: 2, zones: [classic.zones[5], classic.zones[7]] }; // Sixes, Total
  const s = buildSolver(tiny);
  const { rolls, prob } = rollTable(2);
  let ev = 0;
  rolls.forEach((r1, i) => {
    // after the first roll goes to zone z, the second roll takes the other zone
    const follow = (z) => rolls.reduce((sum, r2, j) => sum + prob[j] * tiny.zones[1 - z].score(r2), 0);
    ev += prob[i] * Math.max(tiny.zones[0].score(r1) + follow(0), tiny.zones[1].score(r1) + follow(1));
  });
  assert.ok(Math.abs(s.ev[0b11] - ev) < 1e-9);
});

t('every bot makes legal placements for a whole match, in every variant', () => {
  for (const id of Object.keys(VARIANTS)) {
    const v = buildVariant(id);
    for (const bot of BOTS) for (let seed = 1; seed <= 20; seed++) playMatch(seed, v, bot, getBot('tourist'));
  }
});

t('the bot ladder is ordered: each tier beats the one below', () => {
  for (let i = 1; i < BOTS.length; i++) {
    let hi = 0, lo = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const r = playMatch(seed, classic, BOTS[i], BOTS[i - 1]).result().result;
      if (r === 'a') hi++; else if (r === 'b') lo++;
    }
    assert.ok(hi > lo * 1.2, `${BOTS[i].name} ${hi} vs ${BOTS[i - 1].name} ${lo}`);
  }
});

t('seats are symmetric: swapping players mirrors the result', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const x = playMatch(seed, classic, getBot('shark'), getBot('house')).result();
    const y = playMatch(seed, classic, getBot('house'), getBot('shark')).result();
    assert.strictEqual(x.totalA, y.totalB);
    assert.strictEqual(x.totalB, y.totalA);
    assert.strictEqual(x.result, { a: 'b', b: 'a', draw: 'draw' }[y.result]);
  }
});

console.log(`\n${pass} passed`);
