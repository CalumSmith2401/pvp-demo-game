// The spell pool is data, not code: seasonal rotations are just different
// numbers fed through buildPool(), never a logic change. See SEASONS below.
// Spell *behaviour* (conditionals, control effects, reflect, etc.) lives in
// combat.js, keyed off each spell's `id`.
import { shuffle } from './rng.js';

export const BASE_SPELLS = [
  // --- damage ---
  { id: 'fireball',       name: 'Fireball',       type: 'damage',  value: 14, icon: '🔥' },
  { id: 'frostbolt',      name: 'Frostbolt',      type: 'damage',  value: 10, icon: '❄️' },
  { id: 'lightning',      name: 'Lightning Bolt', type: 'damage',  value: 18, icon: '⚡' },
  { id: 'meteor',         name: 'Meteor',         type: 'damage',  value: 22, icon: '☄️' },
  { id: 'chainlightning', name: 'Chain Lightning',type: 'damage',  value: 8,  icon: '🌩️' },
  { id: 'execute',        name: 'Execute',        type: 'damage',  value: 6,  icon: '🗡️' },
  // --- heal ---
  { id: 'heal',           name: 'Heal',           type: 'heal',    value: 12, icon: '💚' },
  { id: 'bolster',        name: 'Bolster',        type: 'heal',    value: 8,  icon: '🌿' },
  // --- shield ---
  { id: 'shield',         name: 'Shield',         type: 'shield',  value: 10, icon: '🛡️' },
  { id: 'wardstone',      name: 'Wardstone',      type: 'shield',  value: 16, icon: '🪨' },
  { id: 'reflectward',    name: 'Reflect Ward',   type: 'shield',  value: 8,  icon: '🔱' },
  { id: 'manabarrier',    name: 'Mana Barrier',   type: 'shield',  value: 6,  icon: '🔮' },
  // --- burn ---
  { id: 'embergrasp',     name: 'Embergrasp',     type: 'burn',    value: 5, duration: 3, icon: '♨️' },
  { id: 'plague',         name: 'Plague Touch',   type: 'burn',    value: 4, duration: 4, icon: '☠️' },
  { id: 'corrosion',      name: 'Corrosion',      type: 'burn',    value: 3, duration: 5, icon: '🧪' },
  // --- drain ---
  { id: 'drain',          name: 'Drain',          type: 'drain',   value: 9,  icon: '🩸' },
  { id: 'soulsiphon',     name: 'Soul Siphon',    type: 'drain',   value: 13, icon: '💀' },
  { id: 'vampiric',       name: 'Vampiric Touch', type: 'drain',   value: 5,  icon: '🦇' },
  { id: 'bloodpact',      name: 'Blood Pact',     type: 'drain',   value: 16, icon: '🫀' },
  // --- control ---
  { id: 'silence',        name: 'Silence',        type: 'control', value: 0,  icon: '🤐' },
  { id: 'haste',          name: 'Haste',          type: 'control', value: 0,  icon: '⏩' },
  { id: 'mirror',         name: 'Mirror',         type: 'control', value: 0,  icon: '🪞' },
];

// Bespoke effect text for spells whose rules aren't captured by type + value.
const DESCRIPTIONS = {
  chainlightning: (s) => `Deal ${s.value} damage, +4 for each burn on the enemy.`,
  execute:        (s) => `Deal ${s.value} damage — or 30 if the enemy is below 25% HP.`,
  reflectward:    (s) => `Gain a ${s.value} shield that reflects 50% of absorbed damage.`,
  manabarrier:    (s) => `Gain a ${s.value} shield and clear your strongest burn.`,
  corrosion:      (s) => `Burn ${s.value}/turn for ${s.duration} turns — doubled if the enemy already burns.`,
  vampiric:       (s) => `Deal ${s.value} damage; heal ${s.value} — or ${s.value * 2} while below 50% HP.`,
  bloodpact:      (s) => `Deal ${s.value} and heal ${s.value}, but take 4 recoil damage.`,
  silence:        () => `Halve the value of the enemy's next spell.`,
  haste:          () => `Your next spell resolves twice.`,
  mirror:         () => `Recast the enemy's most recent spell as your own.`,
};

// A season applies per-type multipliers / duration tweaks to the base pool.
// Add new ones here only — no engine or UI changes required.
export const SEASONS = {
  classic: {
    id: 'classic', name: 'Classic', blurb: 'The balanced baseline pool.', mods: {},
  },
  burn: {
    id: 'burn', name: 'Burn Season',
    blurb: 'Damage-over-time hits harder and lingers a turn longer.',
    mods: { burn: { valueMul: 1.4, durationAdd: 1 } },
  },
  glassCannon: {
    id: 'glassCannon', name: 'Glass Cannon',
    blurb: 'Direct blasts soar; shields crumble.',
    mods: { damage: { valueMul: 1.35 }, shield: { valueMul: 0.55 } },
  },
  fortify: {
    id: 'fortify', name: 'Fortify',
    blurb: 'Defense reigns — heals and wards swell, blasts soften.',
    mods: {
      heal: { valueMul: 1.4 }, shield: { valueMul: 1.4 },
      damage: { valueMul: 0.85 }, drain: { valueMul: 0.85 },
    },
  },
};

function describe(s) {
  if (DESCRIPTIONS[s.id]) return DESCRIPTIONS[s.id](s);
  switch (s.type) {
    case 'damage': return `Deal ${s.value} damage to the enemy.`;
    case 'heal':   return `Restore ${s.value} HP to yourself.`;
    case 'shield': return `Gain a ${s.value}-point shield that soaks incoming hits.`;
    case 'burn':   return `Burn the enemy ${s.value}/turn for ${s.duration} of their turns.`;
    case 'drain':  return `Deal ${s.value} damage and heal yourself ${s.value}.`;
    default:       return '';
  }
}

// Returns the full pool with the chosen season's modifiers baked in.
export function buildPool(seasonId = 'classic') {
  const season = SEASONS[seasonId] || SEASONS.classic;
  return BASE_SPELLS.map((base) => {
    const s = { ...base };
    const mod = season.mods[s.type];
    if (mod) {
      if (mod.valueMul != null) s.value = Math.max(0, Math.round(s.value * mod.valueMul));
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
