// The authoritative match layer — the "server". There is no network transport in
// this repo yet (Spell Draft runs its opponent locally too), so this module is the
// seam: everything a client is allowed to know comes out of view(), and everything
// a client is allowed to do goes in through act() / peek() / timeout(). Put it
// behind a socket and the rules below still hold.
//
//   - Blind simultaneous lockstep: an action stays hidden from the opponent until
//     both players have submitted for the turn.
//   - Actions are final; anything after lock-in is rejected.
//   - Rolls are dealt a turn at a time. The seed and the future sequence never
//     leave this module while the match is live — a client that knew the seed could
//     compute every roll to come. Peek is the one sanctioned look ahead, and it is
//     granted here, per player, once.
//   - Scoring runs here (engine.js) and is the source of truth.
import { makeTable, makeOffers, newPlayer, openZones, checkAction, applyAction, buildReveal } from './engine.js';
import { rollTable } from './solver.js';

const other = (p) => (p === 'a' ? 'b' : 'a');

// Average base payout of each zone from one random roll: what "least valuable
// open zone" means for a timeout, and a yardstick for the simpler bots.
export function zoneAverages(variant, table) {
  if (!table.averages) {
    const { rolls, prob } = rollTable(variant.dice);
    table.averages = table.zones.map((z) => rolls.reduce((sum, r, i) => sum + z.score(r) * prob[i], 0));
  }
  return table.averages;
}

// `tableSeed` lets the simulator replay many roll sequences on one table.
export function createMatch({ seed, variant, tableSeed = seed }) {
  const table = makeTable(tableSeed, variant);
  const offers = makeOffers(seed, variant);
  const players = { a: newPlayer(variant, table), b: newPlayer(variant, table) };
  const pending = { a: null, b: null }; // this turn's submitted-but-hidden action
  const peeked = { a: -1, b: -1 };      // the turn each player used Peek on
  const log = [];
  let turn = 0;
  let reveal = null;

  const finished = () => turn >= offers.length;
  const lastTurn = () => turn === offers.length - 1;

  function commitTurn() {
    for (const p of ['a', 'b']) {
      const action = pending[p];
      pending[p] = null;
      const landed = applyAction(variant, table, players[p], offers[turn], action, turn, lastTurn());
      if (action.hold) log.push({ turn: turn + 1, player: p, held: true, dice: players[p].held.dice, auto: !!action.auto });
      for (const e of landed) log.push({ turn: turn + 1, player: p, zone: table.zones[e.zone].id, dice: e.dice, points: e.total, double: e.double, flipped: e.flipped != null, auto: e.auto });
    }
    turn++;
    if (finished()) reveal = buildReveal(variant, table, players.a, players.b);
  }

  function submit(player, action) {
    if (player !== 'a' && player !== 'b') return { ok: false, error: 'unknown-player' };
    if (finished()) return { ok: false, error: 'match-locked' };
    if (pending[player]) return { ok: false, error: 'already-placed' };
    const error = checkAction(variant, table, players[player], offers[turn], action, lastTurn());
    if (error) return { ok: false, error };
    pending[player] = { ...action, held: action.held ? { ...action.held } : null };
    const turnComplete = !!pending[other(player)];
    if (turnComplete) commitTurn();
    return { ok: true, turnComplete };
  }

  return {
    variant, table,
    isFinished: finished,

    // Submit this turn's action (see engine.checkAction for its shape).
    act: (player, action) => submit(player, action),

    // Peek: reveal next turn's rolls to this player only, for the rest of this turn.
    peek(player) {
      const me = players[player];
      if (!me || finished() || pending[player] || lastTurn() || !me.powers.peek) return { ok: false, error: 'bad-peek' };
      me.powers.peek = false;
      peeked[player] = turn;
      log.push({ turn: turn + 1, player, peeked: true });
      return { ok: true, next: offers[turn + 1] };
    },

    // Turn timer expired for `player`: take the first roll into their least valuable
    // open zone (lowest average payout), no power-ups, and flag it in the log.
    timeout(player) {
      if (finished() || pending[player]) return { ok: false, error: 'not-waiting' };
      const avg = zoneAverages(variant, table);
      const zone = openZones(players[player].board).reduce((best, z) => (avg[z] < avg[best] ? z : best));
      return { ...submit(player, { pick: 0, zone, auto: true }), zone };
    },

    // Everything `player` may see right now. The opponent's board, streak and
    // power-ups only reflect completed turns; their pending action shows up as
    // `oppLocked` and nothing more.
    view(player) {
      const me = players[player], opp = players[other(player)];
      const live = !finished();
      return {
        status: live ? 'placing' : 'finished',
        turn, turns: offers.length,
        offers: live ? offers[turn] : null,
        next: live && peeked[player] === turn ? offers[turn + 1] : null,
        board: me.board.slice(), score: me.score, streak: me.streak, powers: { ...me.powers }, held: me.held, sweeps: me.sweeps.slice(),
        oppBoard: opp.board.slice(), oppScore: opp.score, oppStreak: opp.streak, oppPowers: { ...opp.powers }, oppHeld: opp.held, oppSweeps: opp.sweeps.slice(),
        placed: pending[player],
        oppLocked: !!pending[other(player)],
      };
    },

    // What happened, turn by turn, flagged with `auto` for timer forfeits. Only completed turns.
    log: () => log.slice(),

    // The zone-by-zone reveal. Null until the last action is in.
    result: () => reveal,

    // Post-match only: lets anyone replay and audit the sequence.
    audit: () => (finished() ? { seed, tableSeed, offers: offers.map((t) => t.map((o) => ({ ...o, dice: o.dice.slice() }))) } : null),
  };
}
