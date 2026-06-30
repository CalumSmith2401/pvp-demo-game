// Heuristic AI opponent. It drafts from the same shared sequence under the same
// rule as the player: place the current card into one empty slot, no lookahead.
//
// Slot index = combat timing (slot 0 fires first). The AI maps each spell to an
// "ideal" position and places it in the still-open slot nearest that position.

function idealPos(spell) {
  switch (spell.type) {
    case 'burn':   return 0; // earliest → maximum ticks
    case 'shield': return 1; // up early to soak the opening blows
    case 'drain':  return 2; // tempo + sustain, front-loaded
    case 'damage': return spell.value >= 18 ? 1 : spell.value >= 14 ? 3 : 4;
    case 'heal':   return 7; // save for topping off after taking damage
    default:       return 4;
  }
}

export function chooseSlot(spell, build) {
  const empty = [];
  for (let i = 0; i < build.length; i++) if (!build[i]) empty.push(i);
  const ideal = idealPos(spell);
  empty.sort((x, y) => Math.abs(x - ideal) - Math.abs(y - ideal) || x - y);
  return empty[0];
}
