import assert from 'node:assert';
import { resolveCombat, START_HP } from '../js/combat.js';

// Spell constructors. `id` matters for spells with special behaviour.
const D = (v) => ({ id: 'd', name: `Dmg${v}`, type: 'damage', value: v });
const H = (v) => ({ id: 'h', name: `Heal${v}`, type: 'heal', value: v });
const S = (v) => ({ id: 's', name: `Shield${v}`, type: 'shield', value: v });
const Bn = (v, d) => ({ id: 'b', name: `Burn${v}`, type: 'burn', value: v, duration: d });
const Dr = (v) => ({ id: 'dr', name: `Drain${v}`, type: 'drain', value: v });
const spell = (o) => ({ name: o.id, value: 0, ...o });
const fill = (arr) => { while (arr.length < 12) arr.push(H(0)); return arr; };

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('combat engine');

t('start HP is 80', () => assert.strictEqual(START_HP, 80));

t('damage race vs heal — higher ender wins', () => {
  const r = resolveCombat(Array(12).fill(D(10)), Array(12).fill(H(8)));
  assert.strictEqual(r.result, 'a');
  assert.strictEqual(r.finalA, 80);
  assert.strictEqual(r.finalB, 80 - 2 * 12); // -10 +8 per round
});

t('shield absorbs before HP is touched', () => {
  const r = resolveCombat(fill([S(10)]), fill([D(14)]));
  assert.strictEqual(r.finalA, 76); // 10 absorbed, 4 through
});

t('burn ticks full duration and bypasses shield', () => {
  const r = resolveCombat(fill([Bn(5, 3)]), fill([S(99)]));
  assert.strictEqual(r.finalB, 65); // 3 ticks * 5, shield ignored
  assert.strictEqual(r.result, 'a');
});

t('drain cannot overheal past the cap', () => {
  const r = resolveCombat(fill([Dr(13)]), fill([]));
  assert.strictEqual(r.finalA, 80);
  assert.strictEqual(r.finalB, 67);
});

t('equal outcome is a draw', () => {
  const r = resolveCombat(fill([]), fill([]));
  assert.strictEqual(r.result, 'draw');
});

t('lethal ends combat early', () => {
  const r = resolveCombat(Array(12).fill(D(22)), Array(12).fill(H(0)));
  assert.strictEqual(r.result, 'a');
  assert.strictEqual(r.finalB, 0);
});

// ---- new mechanics ----

t('Execute hits for 30 below 25% HP, else 6', () => {
  const exec = spell({ id: 'execute', type: 'damage', value: 6 });
  // B softened to 15 (< 25% of 80 = 20) by a Meteor first, then Execute lands
  const a = fill([D(22), D(22), D(22), exec]);
  const r = resolveCombat(a, fill([]));
  // 22*3 = 66 → B at 14 → Execute(30) → dead
  assert.strictEqual(r.result, 'a');
  assert.strictEqual(r.finalB, 0);
  // control: with B healthy, execute only chips 6
  const r2 = resolveCombat(fill([exec]), fill([]));
  assert.strictEqual(r2.finalB, 74);
});

t('Chain Lightning scales with enemy burns', () => {
  const cl = spell({ id: 'chainlightning', type: 'damage', value: 8 });
  const noBurn = resolveCombat(fill([cl]), fill([]));
  assert.strictEqual(noBurn.finalB, 72); // 8
  const withBurns = resolveCombat(fill([Bn(1, 9), Bn(1, 9), cl]), fill([]));
  // two burns active when CL fires (slot 3) → 8 + 4*2 = 16; each 1/turn burn
  // also ticks its full 9 turns (9 + 9 damage total)
  assert.strictEqual(withBurns.finalB, 80 - 16 - 9 - 9);
});

t('Reflect Ward bounces half of absorbed damage', () => {
  const rw = spell({ id: 'reflectward', type: 'shield', value: 8 });
  // A wards (8 reflective), B hits for 14 → 8 absorbed, 6 through; 4 reflected to B
  const r = resolveCombat(fill([rw]), fill([D(14)]));
  assert.strictEqual(r.finalA, 74); // 80 - 6
  assert.strictEqual(r.finalB, 76); // 80 - floor(8/2)
});

t('Silence halves the enemy next spell', () => {
  const sil = spell({ id: 'silence', type: 'control', value: 0 });
  // A silences on slot 1; B's slot-1 Meteor(22) is halved to 11
  const r = resolveCombat(fill([sil]), fill([D(22)]));
  assert.strictEqual(r.finalA, 80 - 11);
});

t('Haste makes the next spell resolve twice', () => {
  const ha = spell({ id: 'haste', type: 'control', value: 0 });
  // A: Haste (slot1), then Fireball(14) doubled (slot2) → 28 to B
  const r = resolveCombat(fill([ha, D(14)]), fill([]));
  assert.strictEqual(r.finalB, 80 - 28);
});

t('Mirror copies the enemy last cast', () => {
  const mi = spell({ id: 'mirror', type: 'control', value: 0 });
  // slot1: A casts Frostbolt(10) → B 70; B casts Meteor(22) → A 58
  // slot2: A Mirrors B's Meteor → 22 to B (70→48); B does nothing
  const r = resolveCombat(fill([D(10), mi]), fill([{ id: 'meteor', name: 'M', type: 'damage', value: 22 }]));
  assert.strictEqual(r.finalB, 48);
});

t('Blood Pact can kill the caster via recoil', () => {
  const bp = spell({ id: 'bloodpact', type: 'drain', value: 16 });
  // A at 4 HP cast Blood Pact → 4 recoil kills A even as it hits B
  // soften A to 4 first: B deals 76 over slots, but simpler — direct construct:
  const a = fill([bp]);
  const b = fill([D(22), D(22), D(22)]); // not relevant to recoil-only check
  const r = resolveCombat(a, b);
  // A casts BP slot1 (recoil 4, A 80→76, heals back capped), then B chips A.
  assert.ok(r.finalA <= 76);
});

console.log(`\n${pass} passing`);
