import assert from 'node:assert';
import { buildVariant, VARIANTS, DEFAULT_VARIANT, ORIGINAL_GAME, POWERS, GAME_NAME } from '../js/config.js';
import { makeTable, makeOffers, newPlayer, scorePlacement, checkAction, applyAction, buildReveal, flipDie } from '../js/engine.js';
import { createMatch } from '../js/match.js';
import { createSolver, rollTable } from '../js/solver.js';
import { BOTS, getBot } from '../js/bots.js';
import { playMatch } from '../sim/play.js';

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// The original no-extras game: not playable, but the engine still has to run it (it
// is the simulator's baseline) and its pool carries the base pay values.
const classic = buildVariant(DEFAULT_VARIANT, ORIGINAL_GAME);
const arcade = buildVariant();
const pool = (variant, id) => variant.pool.find((z) => z.id === id);
const pts = (id, dice) => pool(classic, id).score(dice);

// A hand-built Arcade table so tests don't depend on what a seed happens to deal.
// Zones 0–3 are set A, 4–7 set B; `hot` is a zone index.
function tableOf(variant, ids, hot = -1) {
  const zones = ids.map((id, index) => ({ ...pool(variant, id), index, set: Math.floor(index / 4) }));
  return { zones, hot, sets: variant.sweep ? [[0, 1, 2, 3], [4, 5, 6, 7]] : [] };
}
const TABLE = tableOf(arcade, ['total', 'evens', 'odds', 'double', 'small', 'big', 'triple', 'straight'], 3);
const roll = (dice, gold = null) => ({ dice, gold });

console.log('zone scoring');

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
  assert.strictEqual(pts('small', [2, 2, 2]), 0);
  assert.strictEqual(pts('big', [5, 5, 5]), 0);
});

t('Triple, Double and Straight', () => {
  assert.strictEqual(pts('triple', [4, 4, 4]), 30);
  assert.strictEqual(pts('triple', [4, 4, 5]), 0);
  assert.strictEqual(pts('double', [2, 5, 2]), 10);
  assert.strictEqual(pts('double', [3, 3, 3]), 10);
  assert.strictEqual(pts('double', [1, 2, 3]), 0);
  assert.strictEqual(pts('straight', [4, 2, 3]), 15);
  assert.strictEqual(pts('straight', [6, 1, 2]), 0); // no wrap-around
});

t('Sixes, Ones and Total', () => {
  assert.strictEqual(pts('sixes', [6, 6, 1]), 8);
  assert.strictEqual(pts('ones', [6, 6, 1]), 4);
  assert.strictEqual(pts('total', [1, 1, 1]), 3);
  assert.strictEqual(pts('total', [6, 6, 6]), 18);
});

t('the six zones added to the pool', () => {
  assert.strictEqual(pts('evens', [2, 4, 5]), 6);
  assert.strictEqual(pts('odds', [2, 4, 5]), 3);
  assert.strictEqual(pts('bullseye', [4, 3, 3]), 12);
  assert.strictEqual(pts('bullseye', [4, 4, 4]), 0);
  assert.strictEqual(pts('rainbow', [1, 5, 6]), 6);
  assert.strictEqual(pts('rainbow', [1, 5, 5]), 0);
  assert.strictEqual(pts('highpair', [5, 5, 1]), 14);
  assert.strictEqual(pts('highpair', [3, 3, 6]), 0);
  assert.strictEqual(pts('lucky7', [1, 6, 3]), 8);
  assert.strictEqual(pts('lucky7', [1, 5, 3]), 0);
});

t('each zone advertises its true maximum, with and without the pay overrides', () => {
  const { rolls } = rollTable(3);
  for (const v of [arcade, classic]) {
    for (const z of v.pool) assert.strictEqual(Math.max(...rolls.map(z.score)), z.max, `${v.id}/${z.id}`);
  }
});

t('the rule set overrides the pool pay values as data', () => {
  assert.strictEqual(pool(arcade, 'triple').score([2, 2, 2]), VARIANTS[DEFAULT_VARIANT].pay.triple.points);
  assert.match(pool(arcade, 'triple').hint, new RegExp(String(VARIANTS[DEFAULT_VARIANT].pay.triple.points)));
  assert.strictEqual(pool(classic, 'triple').score([2, 2, 2]), 30);
});

console.log('the table and the rolls');

t('the original game: eight fixed zones, one roll, no extras', () => {
  const tb = makeTable(99, classic);
  assert.deepStrictEqual(tb.zones.map((z) => z.id), ['small', 'big', 'triple', 'double', 'straight', 'sixes', 'ones', 'total']);
  assert.strictEqual(tb.hot, -1);
  assert.deepStrictEqual(tb.sets, []);
  const offers = makeOffers(99, classic);
  assert.ok(offers.every((turn) => turn.length === 1 && turn[0].gold === null));
  assert.deepStrictEqual(Object.keys(newPlayer(classic, tb).powers), []);
});

t('Arcade deals 8 distinct zones, a hot zone and two sets; the seed decides', () => {
  const a = makeTable(5, arcade), b = makeTable(5, arcade);
  assert.deepStrictEqual(a.zones.map((z) => z.id), b.zones.map((z) => z.id));
  assert.strictEqual(a.hot, b.hot);
  assert.strictEqual(new Set(a.zones.map((z) => z.id)).size, 8);
  assert.ok(a.hot >= 0 && a.hot < 8);
  assert.deepStrictEqual(a.sets, [[0, 1, 2, 3], [4, 5, 6, 7]]);
  const tables = new Set(Array.from({ length: 40 }, (_, i) => makeTable(i + 1, arcade).zones.map((z) => z.id).join()));
  assert.ok(tables.size > 30, 'different seeds should deal different tables');
});

t('every turn offers two rolls, each with one golden die', () => {
  const offers = makeOffers(7, arcade);
  assert.strictEqual(offers.length, 8);
  assert.deepStrictEqual(offers, makeOffers(7, arcade));
  assert.notDeepStrictEqual(offers, makeOffers(8, arcade));
  for (const turn of offers) {
    assert.strictEqual(turn.length, 2);
    for (const o of turn) assert.ok(o.dice.length === 3 && o.dice.every((d) => d >= 1 && d <= 6) && o.gold >= 0 && o.gold < 3);
  }
});

console.log('scoring a placement');

t('the golden die adds its face, but only if the roll scores', () => {
  assert.strictEqual(scorePlacement(arcade, TABLE, 0, roll([2, 3, 6], 2), false, 0).total, 11 + 6); // Total
  assert.strictEqual(scorePlacement(arcade, TABLE, 7, roll([2, 3, 6], 2), false, 0).total, 0);      // no Straight, no gold
});

t('the hot zone and Double each add 1×, and they stack to 3×', () => {
  const r = roll([4, 4, 1], 2); // Double: 10, gold 1
  assert.strictEqual(scorePlacement(arcade, TABLE, 3, r, false, 0).total, 22); // hot
  assert.strictEqual(scorePlacement(arcade, TABLE, 3, r, true, 0).total, 33);  // hot + Double
  assert.strictEqual(scorePlacement(arcade, TABLE, 0, r, true, 0).total, 20);  // Total 9 + gold 1, doubled
});

t('a streak adds 1 more per scoring placement in a row, capped, and a blank resets it', () => {
  const bonus = (streakBefore) => scorePlacement(arcade, TABLE, 0, roll([1, 1, 1]), false, streakBefore);
  assert.deepStrictEqual([0, 1, 2, 5, 6, 7].map((s) => bonus(s).streakBonus), [0, 1, 2, 5, 5, 5]);
  assert.strictEqual(bonus(3).streak, 4);
  const blank = scorePlacement(arcade, TABLE, 6, roll([1, 2, 3]), false, 4);
  assert.strictEqual(blank.total, 0);
  assert.strictEqual(blank.streak, 0);
});

console.log('actions and power-ups');

const fresh = () => newPlayer(arcade, TABLE);
const OFFERS = [roll([6, 6, 1], 0), roll([2, 3, 4], 1)];
const act = (player, action, turn = 0, last = false, offers = OFFERS) => {
  const error = checkAction(arcade, TABLE, player, offers, action, last);
  return error ? { error } : { landed: applyAction(arcade, TABLE, player, offers, action, turn, last) };
};

t('you place one of the two rolls on offer', () => {
  const p = fresh();
  act(p, { pick: 1, zone: 7 });
  assert.deepStrictEqual(p.board[7].dice, [2, 3, 4]);
  assert.strictEqual(p.score, 15 + 3);
  assert.strictEqual(act(p, { pick: 2, zone: 0 }).error, 'bad-pick');
  assert.strictEqual(act(p, { pick: 0, zone: 7 }).error, 'zone-filled');
});

t('Flip turns one die to its opposite face, once', () => {
  assert.deepStrictEqual(flipDie(roll([6, 6, 1], 0), 2).dice, [6, 6, 6]);
  const p = fresh();
  act(p, { pick: 0, flip: 2, zone: 6 }); // 6-6-1 → 6-6-6 into Triple
  assert.strictEqual(p.board[6].base, 18);
  assert.strictEqual(p.board[6].total, 18 + 6);
  assert.strictEqual(p.powers.flip, false);
  assert.strictEqual(act(p, { pick: 0, flip: 0, zone: 0 }).error, 'bad-flip');
});

t('Double can be spent once', () => {
  const p = fresh();
  act(p, { pick: 0, zone: 0, double: true });
  assert.strictEqual(p.board[0].total, (13 + 6) * 2);
  assert.strictEqual(act(p, { pick: 0, zone: 1, double: true }).error, 'bad-double');
});

t('Hold sets a roll aside; it lands first on a later turn, alongside that turn\'s roll', () => {
  const p = fresh();
  assert.deepStrictEqual(act(p, { pick: 1, hold: true }).landed, []);
  assert.deepStrictEqual(p.held.dice, [2, 3, 4]);
  assert.strictEqual(p.powers.hold, false);
  assert.strictEqual(act(p, { pick: 0, hold: true }, 1).error, 'bad-hold'); // only once
  const { landed } = act(p, { pick: 0, zone: 0, held: { zone: 7 } }, 1);
  assert.deepStrictEqual(landed.map((e) => e.zone), [7, 0]);
  assert.strictEqual(landed[0].heldFrom, 0);
  assert.strictEqual(landed[1].streak, 2); // the held roll scored first
  assert.strictEqual(p.held, null);
  assert.strictEqual(act(p, { pick: 0, zone: 1, held: { zone: 2 } }, 2).error, 'nothing-held');
});

t('you cannot Hold on the last turn, and a roll still held then drops into the last zone', () => {
  assert.strictEqual(act(fresh(), { pick: 0, hold: true }, 7, true).error, 'bad-hold');
  const p = fresh();
  act(p, { pick: 1, hold: true });
  for (let z = 0; z < 6; z++) act(p, { pick: 0, zone: z }, z + 1);
  const { landed } = act(p, { pick: 0, zone: 6 }, 7, true);
  assert.deepStrictEqual(landed.map((e) => e.zone), [6, 7]);
  assert.strictEqual(landed[1].auto, true);
  assert.ok(p.board.every(Boolean));
});

t('a sweep pays when all four zones of a set score, and not if one is blank', () => {
  const p = fresh();
  const evenOdd = [roll([2, 3, 4], 0)];
  for (const z of [0, 1, 2]) act(p, { pick: 0, zone: z }, z, false, evenOdd);
  const before = p.score;
  const { landed } = act(p, { pick: 0, zone: 3 }, 3, false, [roll([5, 5, 2], 2)]);
  assert.strictEqual(landed[0].sweep, arcade.sweep);
  assert.deepStrictEqual(p.sweeps, [true, false]);
  assert.strictEqual(p.score - before, landed[0].total + arcade.sweep);
  const q = fresh();
  for (const z of [0, 1, 2]) act(q, { pick: 0, zone: z }, z, false, evenOdd);
  assert.strictEqual(act(q, { pick: 0, zone: 3 }, 3, false, evenOdd).landed[0].sweep, 0); // no pair: Double is blank
  assert.deepStrictEqual(q.sweeps, [false, false]);
});

console.log('the reveal');

t('zones resolve in table order with bounties, sweeps and running totals', () => {
  const m = playMatch(11, arcade, getBot('shark'), getBot('tourist'));
  const r = m.result();
  assert.deepStrictEqual(r.zones.map((z) => z.zone), m.table.zones.map((z) => z.id));
  let a = 0, b = 0;
  for (const s of r.steps) {
    if (s.type === 'zone') {
      a += s.a.points + s.a.bounty;
      b += s.b.points + s.b.bounty;
      assert.strictEqual(s.a.bounty, s.winner === 'a' ? arcade.bounty : 0);
      assert.strictEqual(s.b.bounty, s.winner === 'b' ? arcade.bounty : 0);
    } else {
      assert.ok(s.a === arcade.sweep || s.b === arcade.sweep);
      a += s.a;
      b += s.b;
    }
    assert.strictEqual(s.totalA, a);
    assert.strictEqual(s.totalB, b);
  }
  assert.strictEqual(r.totalA, a);
  // the reveal total = what the player banked during the match + bounties
  assert.strictEqual(r.totalA, m.view('a').score + r.zones.reduce((s, z) => s + z.a.bounty, 0));
  assert.strictEqual(r.totalB, m.view('b').score + r.zones.reduce((s, z) => s + z.b.bounty, 0));
});

t('higher total wins; level totals go to zones won; level on both is a draw', () => {
  const tb = makeTable(1, classic);
  const z = (id) => tb.zones.findIndex((q) => q.id === id);
  const player = (pairs) => {
    const p = newPlayer(classic, tb);
    pairs.forEach(([id, dice], i) => applyAction(classic, tb, p, [roll(dice)], { pick: 0, zone: z(id) }, i, false));
    return p;
  };
  const high = player([['total', [6, 6, 5]]]), low = player([['total', [1, 1, 2]]]);
  assert.strictEqual(buildReveal(classic, tb, high, low).result, 'a');
  assert.strictEqual(buildReveal(classic, tb, low, high).result, 'b');
  assert.strictEqual(buildReveal(classic, tb, high, high).result, 'draw');
  // 15 points each: one zone for A, two zones for B → B takes the tie-break
  const one = player([['straight', [1, 2, 3]]]);
  const two = player([['double', [2, 2, 5]], ['total', [1, 1, 3]]]);
  const tie = buildReveal(classic, tb, one, two);
  assert.strictEqual(tie.totalA, tie.totalB);
  assert.strictEqual(tie.result, 'b');
  assert.strictEqual(tie.tiebreak, true);
});

console.log('authoritative match layer');

const zoneId = (m, i) => m.table.zones[i].id;

t('an action stays hidden until both players have acted', () => {
  const m = createMatch({ seed: 5, variant: arcade });
  assert.deepStrictEqual(m.act('a', { pick: 0, zone: 0, double: true }), { ok: true, turnComplete: false });
  const seenByB = m.view('b');
  assert.ok(seenByB.oppBoard.every((e) => e === null));
  assert.strictEqual(seenByB.oppLocked, true);
  assert.strictEqual(seenByB.oppPowers.double, true); // not spent as far as B can tell
  assert.strictEqual(seenByB.oppScore, 0);
  assert.strictEqual(seenByB.turn, 0);
  assert.strictEqual(m.view('a').placed.zone, 0);
  assert.deepStrictEqual(m.log(), []);
  assert.deepStrictEqual(m.act('b', { pick: 1, zone: 3 }), { ok: true, turnComplete: true });
  const after = m.view('b');
  assert.ok(after.oppBoard[0]);
  assert.strictEqual(after.oppPowers.double, false);
  assert.strictEqual(after.turn, 1);
});

t('a view never carries future rolls or the seed', () => {
  const m = createMatch({ seed: 5, variant: arcade });
  const offers = makeOffers(5, arcade);
  const v = m.view('a');
  assert.deepStrictEqual(v.offers, offers[0]);
  assert.strictEqual(v.next, null);
  assert.ok(!JSON.stringify(v).includes(JSON.stringify(offers[1])));
  assert.strictEqual(m.audit(), null);
  assert.strictEqual(m.result(), null);
});

t('Peek shows the next turn to that player only, for one turn, once', () => {
  const m = createMatch({ seed: 5, variant: arcade });
  const offers = makeOffers(5, arcade);
  assert.deepStrictEqual(m.peek('a'), { ok: true, next: offers[1] });
  assert.deepStrictEqual(m.view('a').next, offers[1]);
  assert.strictEqual(m.view('b').next, null);
  assert.strictEqual(m.view('b').oppPowers.peek, false); // B can see that it was spent, not what it showed
  assert.strictEqual(m.peek('a').ok, false);
  m.act('a', { pick: 0, zone: 0 });
  m.act('b', { pick: 0, zone: 0 });
  assert.strictEqual(m.view('a').next, null);
  // not after locking in, and not on the last turn
  m.act('b', { pick: 0, zone: 1 });
  assert.strictEqual(m.peek('b').ok, false);
  const late = createMatch({ seed: 6, variant: arcade });
  for (let z = 0; z < 7; z++) { late.act('a', { pick: 0, zone: z }); late.act('b', { pick: 0, zone: z }); }
  assert.strictEqual(late.peek('a').ok, false);
});

t('actions are final: no second action, no filled zone, nothing after lock', () => {
  const m = createMatch({ seed: 9, variant: arcade });
  m.act('a', { pick: 0, zone: 0 });
  assert.strictEqual(m.act('a', { pick: 0, zone: 1 }).error, 'already-placed');
  m.act('b', { pick: 0, zone: 0 });
  assert.strictEqual(m.act('a', { pick: 0, zone: 0 }).error, 'zone-filled');
  assert.strictEqual(m.act('a', { pick: 0, zone: 99 }).error, 'zone-filled');
  assert.strictEqual(m.act('c', { pick: 0, zone: 1 }).error, 'unknown-player');
  const done = playMatch(9, arcade, getBot('shark'), getBot('shark'));
  assert.strictEqual(done.act('a', { pick: 0, zone: 0 }).error, 'match-locked');
  assert.strictEqual(done.timeout('a').ok, false);
  assert.strictEqual(done.peek('a').ok, false);
  assert.deepStrictEqual(done.audit().offers, makeOffers(9, arcade));
});

t('a timeout takes the first roll into the lowest-value open zone and is flagged', () => {
  const m = createMatch({ seed: 21, variant: classic });
  const res = m.timeout('a');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(zoneId(m, res.zone), 'triple'); // lowest average payout on an open board
  assert.strictEqual(m.timeout('a').ok, false);      // already locked for this turn
  m.act('b', { pick: 0, zone: 7 });
  const mine = m.log().find((e) => e.player === 'a');
  assert.strictEqual(mine.auto, true);
  assert.strictEqual(mine.zone, 'triple');
  assert.strictEqual(m.log().find((e) => e.player === 'b').auto, false);
});

console.log('solver and bots');

t('solver expected score matches brute force on a two-zone table', () => {
  // Classic rules, two zones, two turns: enumerate every first roll and both placements.
  const tiny = { ...classic, rolls: 2 };
  const tb = { zones: [pool(classic, 'sixes'), pool(classic, 'total')].map((z, index) => ({ ...z, index, set: 0 })), hot: -1, sets: [] };
  const { rolls, prob } = rollTable(3);
  const follow = (z) => rolls.reduce((s, r, j) => s + prob[j] * tb.zones[1 - z].score(r), 0);
  const ev = rolls.reduce((s, r, i) => s + prob[i] * Math.max(tb.zones[0].score(r) + follow(0), tb.zones[1].score(r) + follow(1)), 0);
  assert.ok(Math.abs(createSolver(tiny, tb).solve().startValue() - ev) < 1e-4);
});

t('picking the better of two rolls is worth more than being dealt one', () => {
  const tb = makeTable(3, arcade);
  const two = createSolver(arcade, tb).solve().startValue();
  const one = createSolver({ ...arcade, offers: 1 }, tb).solve().startValue();
  assert.ok(two > one + 10, `${two} vs ${one}`);
});

t('the solver can be run in slices and gives the same answer', () => {
  const tb = makeTable(4, arcade);
  const sliced = createSolver(arcade, tb);
  let steps = 0;
  while (!sliced.step(2)) steps++;
  assert.ok(steps > 1);
  assert.strictEqual(sliced.startValue(), createSolver(arcade, tb).solve().startValue());
});

t('every bot plays whole matches legally, with and without the extras', () => {
  for (const v of [arcade, classic]) {
    for (const bot of BOTS) for (let seed = 1; seed <= 12; seed++) playMatch(seed, v, bot, getBot('tourist'), 1 + (seed % 3));
  }
});

t('The House really does use Hold and Peek', () => {
  let held = 0, peeked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const log = playMatch(seed, arcade, getBot('house'), getBot('regular'), 1 + (seed % 4)).log().filter((e) => e.player === 'a');
    if (log.some((e) => e.held)) held++;
    if (log.some((e) => e.peeked)) peeked++;
  }
  assert.ok(held > 10 && peeked > 40, `held ${held}, peeked ${peeked}`);
});

t('the bot ladder is ordered: each tier beats the one below (Arcade)', () => {
  for (let i = 1; i < BOTS.length; i++) {
    let hi = 0, lo = 0;
    for (let k = 0; k < 600; k++) {
      const r = playMatch(1000 + k, arcade, BOTS[i], BOTS[i - 1], 1 + (k % 6)).result().result;
      if (r === 'a') hi++; else if (r === 'b') lo++;
    }
    assert.ok(hi > lo * 1.2, `${BOTS[i].name} ${hi} vs ${BOTS[i - 1].name} ${lo}`);
  }
});

t('seats are symmetric: swapping players mirrors the result', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const x = playMatch(seed, arcade, getBot('shark'), getBot('house'), 1 + (seed % 5)).result();
    const y = playMatch(seed, arcade, getBot('house'), getBot('shark'), 1 + (seed % 5)).result();
    assert.strictEqual(x.totalA, y.totalB);
    assert.strictEqual(x.totalB, y.totalA);
    assert.strictEqual(x.result, { a: 'b', b: 'a', draw: 'draw' }[y.result]);
  }
});

t('every power-up has a name and a one-line description', () => {
  for (const p of buildVariant(DEFAULT_VARIANT).powers) assert.ok(POWERS[p].name && POWERS[p].blurb);
});

console.log(`\n${pass} passed`);
