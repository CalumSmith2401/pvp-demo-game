import assert from 'node:assert';
import { resolveCombat } from '../js/combat.js';

// Tiny spell constructors so tests aren't tied to the live pool's balance.
const D = (v) => ({ name: `Dmg${v}`, type: 'damage', value: v });
const H = (v) => ({ name: `Heal${v}`, type: 'heal', value: v });
const S = (v) => ({ name: `Shield${v}`, type: 'shield', value: v });
const Bn = (v, d) => ({ name: `Burn${v}`, type: 'burn', value: v, duration: d });
const Dr = (v) => ({ name: `Drain${v}`, type: 'drain', value: v });
const fill = (arr) => { while (arr.length < 8) arr.push(H(0)); return arr; };

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

console.log('combat engine');

t('damage race vs heal — higher ender wins', () => {
  const r = resolveCombat(Array(8).fill(D(10)), Array(8).fill(H(8)));
  assert.strictEqual(r.result, 'a');
  assert.strictEqual(r.finalA, 60);
  assert.strictEqual(r.finalB, 44);
});

t('shield absorbs before HP is touched', () => {
  const r = resolveCombat(fill([S(10)]), fill([D(14)]));
  assert.strictEqual(r.finalA, 56); // 10 absorbed, 4 through
});

t('burn ticks for its full duration and bypasses shield', () => {
  const r = resolveCombat(fill([Bn(5, 3)]), fill([S(99)]));
  assert.strictEqual(r.finalB, 45); // 3 ticks * 5, shield ignored
  assert.strictEqual(r.result, 'a');
});

t('drain cannot overheal past the cap', () => {
  const r = resolveCombat(fill([Dr(13)]), fill([]));
  assert.strictEqual(r.finalA, 60); // already at cap, heal wasted
  assert.strictEqual(r.finalB, 47);
});

t('equal outcome is a draw', () => {
  const r = resolveCombat(fill([]), fill([]));
  assert.strictEqual(r.result, 'draw');
  assert.strictEqual(r.finalA, 60);
  assert.strictEqual(r.finalB, 60);
});

t('lethal ends combat early', () => {
  const r = resolveCombat(Array(8).fill(D(22)), Array(8).fill(H(0)));
  assert.strictEqual(r.result, 'a');
  assert.strictEqual(r.finalB, 0);
});

console.log(`\n${pass} passing`);
