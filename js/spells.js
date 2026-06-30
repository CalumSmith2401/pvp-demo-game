// The spell pool is data, not code: seasonal rotations are just different
// numbers fed through buildPool(), never a logic change. See SEASONS below.
import { shuffle } from './rng.js';

export const BASE_SPELLS = [
  { id: 'fireball',   name: 'Fireball',       type: 'damage', value: 14, icon: '🔥' },
  { id: 'frostbolt',  name: 'Frostbolt',      type: 'damage', value: 10, icon: '❄️' },
  { id: 'lightning',  name: 'Lightning Bolt', type: 'damage', value: 18, icon: '⚡' },
  { id: 'meteor',     name: 'Meteor',         type: 'damage', value: 22, icon: '☄️' },
  { id: 'heal',       name: 'Heal',           type: 'heal',   value: 12, icon: '💚' },
  { id: 'bolster',    name: 'Bolster',        type: 'heal',   value: 8,  icon: '🌿' },
  { id: 'shield',     name: 'Shield',         type: 'shield', value: 10, icon: '🛡️' },
  { id: 'wardstone',  name: 'Wardstone',      type: 'shield', value: 16, icon: '🪨' },
  { id: 'embergrasp', name: 'Embergrasp',     type: 'burn',   value: 5, duration: 3, icon: '♨️' },
  { id: 'plague',     name: 'Plague Touch',   type: 'burn',   value: 4, duration: 4, icon: '☠️' },
  { id: 'drain',      name: 'Drain',          type: 'drain',  value: 9,  icon: '🩸' },
  { id: 'soulsiphon', name: 'Soul Siphon',    type: 'drain',  value: 13, icon: '💀' },
];

// A season applies per-type multipliers / duration tweaks to the base pool.
// Add new ones here only — no engine or UI changes required.
export const SEASONS = {
  classic: {
    id: 'classic',
    name: 'Classic',
    blurb: 'The balanced baseline pool.',
    mods: {},
  },
  burn: {
    id: 'burn',
    name: 'Burn Season',
    blurb: 'Damage-over-time hits harder and lingers a turn longer.',
    mods: { burn: { valueMul: 1.4, durationAdd: 1 } },
  },
  glassCannon: {
    id: 'glassCannon',
    name: 'Glass Cannon',
    blurb: 'Direct blasts soar; shields crumble.',
    mods: { damage: { valueMul: 1.35 }, shield: { valueMul: 0.55 } },
  },
  fortify: {
    id: 'fortify',
    name: 'Fortify',
    blurb: 'Defense reigns — heals and wards swell, blasts soften.',
    mods: {
      heal: { valueMul: 1.4 },
      shield: { valueMul: 1.4 },
      damage: { valueMul: 0.85 },
      drain: { valueMul: 0.85 },
    },
  },
};

function describe(s) {
  switch (s.type) {
    case 'damage': return `Deal ${s.value} damage to the enemy.`;
    case 'heal':   return `Restore ${s.value} HP to yourself.`;
    case 'shield': return `Gain a ${s.value}-point shield that soaks incoming hits.`;
    case 'burn':   return `Burn the enemy ${s.value}/turn for ${s.duration} of their turns.`;
    case 'drain':  return `Deal ${s.value} damage and heal yourself ${s.value}.`;
    default:       return '';
  }
}

// Returns the 12-spell pool with the chosen season's modifiers baked in.
export function buildPool(seasonId = 'classic') {
  const season = SEASONS[seasonId] || SEASONS.classic;
  return BASE_SPELLS.map((base) => {
    const s = { ...base };
    const mod = season.mods[s.type];
    if (mod) {
      if (mod.valueMul != null) s.value = Math.max(1, Math.round(s.value * mod.valueMul));
      if (mod.durationAdd != null && s.duration != null) s.duration += mod.durationAdd;
    }
    s.desc = describe(s);
    return s;
  });
}

// Picks `count` distinct spells from the pool in a shuffled order.
export function makeSequence(pool, count, rand) {
  return shuffle(pool, rand).slice(0, count);
}
