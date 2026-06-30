// Pure, deterministic combat engine. No DOM, no globals — drives both the canvas
// arena (via the typed event stream) and the Node test suite.
export const START_HP = 60;
export const MAX_HP = 60;

function newPlayer() {
  return { hp: START_HP, shield: 0, burns: [] };
}

/**
 * Resolve a duel between two locked 8-slot builds.
 * @param {Array} buildA - player's spells, index 0..7
 * @param {Array} buildB - opponent's spells, index 0..7
 * @param {{a:string,b:string}} labels - display names for the log
 * @returns {{events:Array, result:'a'|'b'|'draw', finalA:number, finalB:number}}
 *
 * Each event carries both a human-readable `text` (for the log) and animation
 * hints (`move`, `target`, amounts, `spellId`) the arena renders without parsing.
 */
export function resolveCombat(buildA, buildB, labels = { a: 'You', b: 'Opponent' }) {
  const players = { a: newPlayer(), b: newPlayer() };
  const events = [];

  const snap = () => ({
    hpA: Math.max(0, players.a.hp),
    hpB: Math.max(0, players.b.hp),
    shieldA: players.a.shield,
    shieldB: players.b.shield,
  });
  const push = (ev) => events.push({ ...ev, state: snap() });

  // Shields soak damage from the next damage/drain hit(s) until depleted;
  // excess carries through. Burn bypasses shields entirely.
  function applyDamage(target, amount) {
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    target.hp -= amount - absorbed;
    return absorbed;
  }

  function heal(p, amount) {
    const before = p.hp;
    p.hp = Math.min(MAX_HP, p.hp + amount);
    return p.hp - before;
  }

  // Burn ticks at the start of the affected player's turn, before their spell.
  function tick(key) {
    const p = players[key];
    if (!p.burns.length) return;
    let total = 0;
    for (const b of p.burns) {
      total += b.value;
      b.remaining -= 1;
    }
    p.hp -= total;
    p.burns = p.burns.filter((b) => b.remaining > 0);
    push({
      actor: key,
      kind: 'burn',
      move: 'tick',
      amount: total,
      text: `Burn scorches ${labels[key]} for ${total} damage.`,
    });
  }

  function cast(spell, casterKey, targetKey) {
    const caster = players[casterKey];
    const target = players[targetKey];
    const cl = labels[casterKey];
    const tl = labels[targetKey];
    const base = { actor: casterKey, spellId: spell.id, icon: spell.icon, value: spell.value };
    switch (spell.type) {
      case 'damage': {
        const ab = applyDamage(target, spell.value);
        push({
          ...base, kind: 'damage', target: targetKey,
          move: spell.id === 'lightning' ? 'bolt' : 'projectile',
          dmg: spell.value - ab, absorbed: ab,
          text: `${cl} cast ${spell.name} — ${spell.value - ab} damage to ${tl}${ab ? ` (${ab} absorbed)` : ''}.`,
        });
        break;
      }
      case 'drain': {
        const ab = applyDamage(target, spell.value);
        const got = heal(caster, spell.value); // heals full value regardless of absorption
        push({
          ...base, kind: 'drain', target: targetKey, move: 'projectile',
          dmg: spell.value - ab, absorbed: ab, heal: got,
          text: `${cl} cast ${spell.name} — ${spell.value - ab} damage to ${tl}, healed ${got}.`,
        });
        break;
      }
      case 'heal': {
        const got = heal(caster, spell.value);
        push({ ...base, kind: 'heal', move: 'self', heal: got,
          text: `${cl} cast ${spell.name} — restored ${got} HP.` });
        break;
      }
      case 'shield': {
        caster.shield += spell.value;
        push({ ...base, kind: 'shield', move: 'self', shieldGain: spell.value,
          text: `${cl} cast ${spell.name} — gained ${spell.value} shield.` });
        break;
      }
      case 'burn': {
        target.burns.push({ value: spell.value, remaining: spell.duration });
        push({
          ...base, kind: 'burn', target: targetKey, move: 'projectile', sub: 'cast',
          duration: spell.duration,
          text: `${cl} cast ${spell.name} — ${tl} burns for ${spell.value}/turn (${spell.duration} turns).`,
        });
        break;
      }
    }
  }

  let result = null;
  const A = players.a;
  const B = players.b;
  for (let i = 0; i < buildA.length; i++) {
    // --- player's turn ---
    tick('a');
    if (A.hp <= 0) { result = 'b'; break; }
    cast(buildA[i], 'a', 'b');
    if (B.hp <= 0) { result = 'a'; break; }
    // --- opponent's turn ---
    tick('b');
    if (B.hp <= 0) { result = 'a'; break; }
    cast(buildB[i], 'b', 'a');
    if (A.hp <= 0) { result = 'b'; break; }
  }

  if (result === null) {
    if (A.hp > B.hp) result = 'a';
    else if (B.hp > A.hp) result = 'b';
    else result = 'draw';
  }

  return { events, result, finalA: Math.max(0, A.hp), finalB: Math.max(0, B.hp) };
}
