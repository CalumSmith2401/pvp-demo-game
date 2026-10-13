// The authoritative match layer — the "server". There is no network transport in
// this repo yet (Spell Draft runs its opponent locally too), so this module is the
// seam: everything a client is allowed to know comes out of view(), and everything
// a client is allowed to do goes in through place() / timeout(). Put it behind a
// socket and the rules below still hold.
//
//   - Blind simultaneous lockstep: a placement stays hidden from the opponent
//     until both players have submitted for the turn.
//   - Placements are final; anything after lock-in is rejected.
//   - Rolls are dealt one at a time. The seed and the future sequence never leave
//     this module while the match is live — a client that knew the seed could
//     compute every roll to come.
//   - Scoring runs here (engine.js) and is the source of truth.
import { makeRolls, emptyBoard, openZones, zonePoints, buildReveal } from './engine.js';
import { solverFor } from './solver.js';

const other = (p) => (p === 'a' ? 'b' : 'a');

export function createMatch({ seed, variant }) {
  const rolls = makeRolls(seed, variant);
  const boards = { a: emptyBoard(variant), b: emptyBoard(variant) };
  const pending = { a: null, b: null }; // this turn's submitted-but-hidden placement
  const log = [];
  let turn = 0;
  let reveal = null;

  const finished = () => turn >= rolls.length;
  const zoneIndex = (id) => variant.zones.findIndex((z) => z.id === id);

  function commitTurn() {
    for (const p of ['a', 'b']) {
      const { zone, auto } = pending[p];
      boards[p][zone] = rolls[turn];
      log.push({
        turn: turn + 1, player: p, zone: variant.zones[zone].id, roll: rolls[turn],
        points: zonePoints(variant, zone, rolls[turn]), auto,
      });
      pending[p] = null;
    }
    turn++;
    if (finished()) reveal = buildReveal(variant, boards.a, boards.b);
  }

  function submit(player, zone, auto) {
    if (player !== 'a' && player !== 'b') return { ok: false, error: 'unknown-player' };
    if (finished()) return { ok: false, error: 'match-locked' };
    if (pending[player]) return { ok: false, error: 'already-placed' };
    if (zone < 0 || zone >= variant.zones.length) return { ok: false, error: 'unknown-zone' };
    if (boards[player][zone]) return { ok: false, error: 'zone-filled' };
    pending[player] = { zone, auto };
    const turnComplete = !!pending[other(player)];
    if (turnComplete) commitTurn();
    return { ok: true, turnComplete };
  }

  return {
    variant,
    isFinished: finished,

    place: (player, zoneId) => submit(player, zoneIndex(zoneId), false),

    // Turn timer expired for `player`: forfeit the roll into their least valuable
    // open zone (lowest average payout) and flag it in the log.
    timeout(player) {
      if (finished() || pending[player]) return { ok: false, error: 'not-waiting' };
      const { zoneEV } = solverFor(variant);
      const zone = openZones(boards[player]).reduce((best, z) => (zoneEV[z] < zoneEV[best] ? z : best));
      return { ...submit(player, zone, true), zone: variant.zones[zone].id };
    },

    // Everything `player` may see right now. The opponent's board only contains
    // completed turns; their pending placement shows up as `oppLocked` and no more.
    view(player) {
      const opp = other(player);
      const total = (p) => boards[p].reduce((t, r, i) => t + zonePoints(variant, i, r), 0);
      return {
        status: finished() ? 'finished' : 'placing',
        turn, turns: rolls.length,
        roll: finished() ? null : rolls[turn],
        board: boards[player].slice(),
        oppBoard: boards[opp].slice(),
        score: total(player),
        oppScore: total(opp),
        // My own locked-in zone for this turn (it lands on the board once the turn completes).
        placed: pending[player] ? pending[player].zone : null,
        oppLocked: !!pending[opp],
      };
    },

    // Placement log, flagged with `auto` for timer forfeits. Only completed turns.
    log: () => log.slice(),

    // The zone-by-zone reveal. Null until the last placement is in.
    result: () => reveal,

    // Post-match only: lets anyone replay and audit the sequence.
    audit: () => (finished() ? { seed, rolls: rolls.map((r) => r.slice()) } : null),
  };
}
