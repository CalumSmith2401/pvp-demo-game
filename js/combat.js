// Pure, deterministic combat engine. No DOM, no globals — drives both the canvas
// arena (via the typed event stream) and the Node test suite.
//
// Spell behaviour is keyed off each spell's `id`/`type`. Stateful effects that
// persist across turns (shields, reflect, burns, silence, haste, last-cast for
// Mirror) live on the per-player state below.
export const START_HP = 80;
export const MAX_HP = 80;

function newPlayer() {
  return {
    hp: START_HP,
    shield: 0,
    reflect: 0,      // portion of `shield` that reflects 50% of what it absorbs
    burns: [],       // [{ value, remaining }]
    silenced: false, // next cast halved
    haste: false,    // next cast resolves twice
    lastCast: null,  // most recent spell cast (for Mirror)
  };
}

const isOffensive = (spell) =>
  spell.type === 'damage' || spell.type === 'drain' || spell.type === 'burn';

/**
 * Resolve a duel between two locked builds (any equal length).
 * @returns {{events:Array, result:'a'|'b'|'draw', finalA:number, finalB:number}}
 */
export function resolveCombat(buildA, buildB, labels = { a: 'You', b: 'Opponent' }) {
  const players = { a: newPlayer(), b: newPlayer() };
  const A = players.a;
  const B = players.b;
  const events = [];

  const snap = () => ({
    hpA: Math.max(0, A.hp), hpB: Math.max(0, B.hp),
    shieldA: A.shield, shieldB: B.shield,
  });
  const push = (ev) => events.push({ ...ev, state: snap() });

  function heal(p, amount) {
    const before = p.hp;
    p.hp = Math.min(MAX_HP, p.hp + amount);
    return p.hp - before;
  }

  // Apply `amount` to a target's shield then HP. Returns absorption details,
  // including the reflecting portion of the shield that was consumed.
  function absorb(target, amount) {
    const reflectBefore = target.reflect;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    const reflectingPortion = Math.min(absorbed, reflectBefore);
    target.reflect = Math.min(reflectBefore - reflectingPortion, target.shield);
    const through = amount - absorbed;
    target.hp -= through;
    return { absorbed, through, reflectingPortion };
  }

  function emitReflect(victimKey, amount) {
    absorb(players[victimKey], amount); // attacker's own shield may soak it
    push({ actor: victimKey, kind: 'reflect', move: 'tick', amount,
      text: `Reflect Ward lashes ${labels[victimKey]} for ${amount}.` });
  }

  function removeStrongestBurn(p) {
    if (!p.burns.length) return false;
    let idx = 0;
    let best = -1;
    p.burns.forEach((b, i) => {
      const total = b.value * b.remaining;
      if (total > best) { best = total; idx = i; }
    });
    p.burns.splice(idx, 1);
    return true;
  }

  // Burn ticks at the start of the affected player's turn, before their spell.
  function tick(key) {
    const p = players[key];
    if (!p.burns.length) return;
    let total = 0;
    for (const b of p.burns) { total += b.value; b.remaining -= 1; }
    p.hp -= total;
    p.burns = p.burns.filter((b) => b.remaining > 0);
    push({ actor: key, kind: 'burn', move: 'tick', amount: total,
      text: `Burn scorches ${labels[key]} for ${total} damage.` });
  }

  // Resolve a single spell's effect once (Haste may invoke this twice).
  function resolveSpell(spell, ck, tk, opts) {
    const caster = players[ck];
    const target = players[tk];
    const cl = labels[ck];
    const tl = labels[tk];
    const sf = opts.silenced ? 0.5 : 1;
    const S = (x) => Math.max(0, Math.floor(x * sf));
    const pre = opts.mirrored ? 'Mirror: ' : '';
    const sil = opts.silenced ? ' (silenced)' : '';
    const base = { actor: ck, spellId: spell.id, icon: spell.icon, value: spell.value, mirrored: opts.mirrored };

    switch (spell.type) {
      case 'damage': {
        let dmg;
        if (spell.id === 'chainlightning') dmg = S(spell.value + 4 * target.burns.length);
        else if (spell.id === 'execute') dmg = S(target.hp < MAX_HP * 0.25 ? 30 : spell.value);
        else dmg = S(spell.value);
        const { absorbed, through, reflectingPortion } = absorb(target, dmg);
        push({ ...base, kind: 'damage', target: tk,
          move: spell.id === 'lightning' ? 'bolt' : 'projectile', dmg: through, absorbed,
          text: `${pre}${cl} cast ${spell.name} — ${through} damage to ${tl}${absorbed ? ` (${absorbed} absorbed)` : ''}${sil}.` });
        const reflected = Math.floor(reflectingPortion * 0.5);
        if (reflected > 0) emitReflect(ck, reflected);
        break;
      }
      case 'drain': {
        const dmg = S(spell.value);
        const healAmt = spell.id === 'vampiric'
          ? S(caster.hp < MAX_HP * 0.5 ? 10 : 5)
          : S(spell.value);
        const { absorbed, through, reflectingPortion } = absorb(target, dmg);
        const got = heal(caster, healAmt);
        const recoil = spell.id === 'bloodpact' ? 4 : 0;
        push({ ...base, kind: 'drain', target: tk, move: 'projectile', dmg: through, absorbed, heal: got,
          text: `${pre}${cl} cast ${spell.name} — ${through} to ${tl}, healed ${got}${recoil ? `, ${recoil} recoil` : ''}${sil}.` });
        const reflected = Math.floor(reflectingPortion * 0.5);
        if (reflected > 0) emitReflect(ck, reflected);
        if (recoil > 0) {
          caster.hp -= recoil;
          push({ actor: ck, kind: 'recoil', move: 'tick', amount: recoil,
            text: `Blood Pact recoils into ${cl} for ${recoil}.` });
        }
        break;
      }
      case 'heal': {
        const got = heal(caster, S(spell.value));
        push({ ...base, kind: 'heal', move: 'self', heal: got,
          text: `${pre}${cl} cast ${spell.name} — restored ${got} HP${sil}.` });
        break;
      }
      case 'shield': {
        const gain = S(spell.value);
        caster.shield += gain;
        let extra = '';
        if (spell.id === 'reflectward') { caster.reflect += gain; extra = ', reflective'; }
        if (spell.id === 'manabarrier' && removeStrongestBurn(caster)) extra = ', cleansed a burn';
        push({ ...base, kind: 'shield', move: 'self', shieldGain: gain,
          text: `${pre}${cl} cast ${spell.name} — +${gain} shield${extra}${sil}.` });
        break;
      }
      case 'burn': {
        let val = spell.value;
        if (spell.id === 'corrosion' && target.burns.length > 0) val *= 2;
        val = S(val);
        target.burns.push({ value: val, remaining: spell.duration });
        push({ ...base, kind: 'burn', target: tk, move: 'projectile', sub: 'cast', duration: spell.duration,
          text: `${pre}${cl} cast ${spell.name} — ${tl} burns ${val}/turn for ${spell.duration}${sil}.` });
        break;
      }
      case 'control': {
        if (spell.id === 'silence') {
          target.silenced = true;
          push({ ...base, kind: 'control', move: 'projectile', target: tk, note: 'Silenced',
            text: `${pre}${cl} cast Silence — ${tl}'s next spell is weakened.` });
        } else if (spell.id === 'haste') {
          caster.haste = true;
          push({ ...base, kind: 'control', move: 'self', note: 'Haste!',
            text: `${pre}${cl} cast Haste — the next spell will fire twice.` });
        }
        break;
      }
    }
  }

  function cast(spell, ck, tk) {
    const caster = players[ck];
    const cl = labels[ck];

    // Mirror resolves into the opponent's most recent cast.
    let actual = spell;
    let mirrored = false;
    if (spell.type === 'control' && spell.id === 'mirror') {
      const last = players[tk].lastCast;
      caster.lastCast = spell;
      if (!last || last.id === 'mirror') {
        caster.haste = false;
        caster.silenced = false;
        push({ actor: ck, kind: 'control', move: 'self', spellId: 'mirror', icon: spell.icon,
          note: 'Fizzle', text: `${cl} cast Mirror — but there was nothing to copy.` });
        return;
      }
      actual = last;
      mirrored = true;
    } else {
      caster.lastCast = spell;
    }

    const repeats = caster.haste ? 2 : 1;
    caster.haste = false;
    const silenced = caster.silenced;
    caster.silenced = false;

    for (let r = 0; r < repeats; r++) {
      resolveSpell(actual, ck, tk, { silenced, mirrored });
      if (players[tk].hp <= 0 && isOffensive(actual)) break; // don't swing at a corpse
    }
  }

  let result = null;
  function decided() {
    if (A.hp > 0 && B.hp > 0) return false;
    if (A.hp <= 0 && B.hp <= 0) result = 'draw';
    else if (A.hp <= 0) result = 'b';
    else result = 'a';
    return true;
  }

  for (let i = 0; i < buildA.length; i++) {
    tick('a'); if (decided()) break;
    cast(buildA[i], 'a', 'b'); if (decided()) break;
    tick('b'); if (decided()) break;
    cast(buildB[i], 'b', 'a'); if (decided()) break;
  }

  if (result === null) {
    if (A.hp > B.hp) result = 'a';
    else if (B.hp > A.hp) result = 'b';
    else result = 'draw';
  }

  return { events, result, finalA: Math.max(0, A.hp), finalB: Math.max(0, B.hp) };
}
