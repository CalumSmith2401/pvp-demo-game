// Sound. The physical sounds (dice shaken, thrown and set down, casino chips for
// points) are short recordings from Kenney's Casino Audio (CC0), trimmed and
// converted to AAC in assets/sound/. The payoffs and warnings (chimes, the clock
// tick, the win and lose stings) are synthesised here, so they cost no download.
//
// Web Audio only. Browsers keep audio locked until the first tap or key press, so
// the context is resumed then. Nothing here ever throws: a browser without Web
// Audio, a file that fails to load or a blocked context just means silence.
// Muting is remembered per device.

const SAMPLES = {
  shake:   ['dice-shake-1'],
  throw:   ['dice-throw-1', 'dice-throw-2', 'dice-throw-3'],
  die:     ['die-throw-1', 'die-throw-2', 'die-throw-4'],
  grab:    ['dice-grab-1'],
  lay:     ['chip-lay-1', 'chip-lay-2', 'chip-lay-3'],
  stack:   ['chips-stack-1', 'chips-stack-2', 'chips-stack-4', 'chips-stack-5'],
  collide: ['chips-collide-1', 'chips-collide-2', 'chips-collide-4'],
  handle:  ['chips-handle-2', 'chips-handle-5'],
};
const MUTE_KEY = 'bad-to-the-bone:muted';

let ctx = null;
let master = null;
let muted = false;
const buffers = {}; // name → [AudioBuffer]
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage blocked: default to sound on */ }

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    // On iOS, 'ambient' respects the silent switch and mixes with the player's music.
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
  } catch { ctx = null; }
  return ctx;
}

// Resume on the first gesture (and again after the page was backgrounded).
function unlock() {
  const c = context();
  if (!c || c.state === 'running') return;
  c.resume().catch(() => {});
  try { // older iOS only unlocks once something has actually played inside a gesture
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, 22050);
    s.connect(c.destination);
    s.start(0);
  } catch { /* fine */ }
}
for (const type of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(type, unlock, { capture: true, passive: true });

// Fetch and decode every sample. Called at boot, behind the menu.
export async function loadSounds(base = 'assets/sound/') {
  const c = context();
  if (!c) return;
  const jobs = [];
  for (const [name, files] of Object.entries(SAMPLES)) {
    buffers[name] = [];
    for (const f of files) {
      jobs.push(fetch(base + f + '.m4a')
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
        .then((data) => new Promise((ok, fail) => c.decodeAudioData(data, ok, fail)))
        .then((buf) => buffers[name].push(buf))
        .catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

export const isMuted = () => muted;
export function setMuted(on) {
  muted = !!on;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* not remembered, still applies */ }
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.02);
}

const ready = () => ctx && ctx.state === 'running' && !muted;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// One recorded sample: a random take, slightly detuned so repeats don't sound canned.
// `from` skips into it (seconds); `dur` cuts it short with a quick fade.
function sample(name, { vol = 1, rate = 1, delay = 0, from = 0, dur = 0 } = {}) {
  const list = buffers[name];
  if (!list || !list.length) return;
  const src = ctx.createBufferSource();
  src.buffer = pick(list);
  src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
  const g = ctx.createGain();
  const t = ctx.currentTime + delay;
  g.gain.value = vol;
  if (dur) { g.gain.setValueAtTime(vol, t + dur * 0.7); g.gain.linearRampToValueAtTime(0, t + dur); }
  src.connect(g).connect(master);
  src.start(t, from);
  if (dur) src.stop(t + dur + 0.02);
}

// One synthesised note: an oscillator through a short envelope.
function note(freq, { at = 0, len = 0.14, vol = 0.18, type = 'triangle', to = null, attack = 0.005, filter = 0 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  let out = osc.connect(g);
  if (filter) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter; out = out.connect(f); }
  out.connect(master);
  osc.start(t);
  osc.stop(t + len + 0.05);
}

const hz = (semis) => 440 * 2 ** ((semis - 9) / 12); // semitones from middle C
const C5 = 12;

// Everything the game can ask for, by name.
const CUES = {
  shake:  (o) => sample('shake', { vol: 0.8, from: 0.2, dur: o.dur || 0.38 }), // it builds for its first 0.2 s
  throw:  () => sample('throw', { vol: 0.65 }),
  place:  () => sample('die', { vol: 0.7, rate: 1.1 }),
  flip:   () => sample('die', { vol: 0.45, rate: 1.3, dur: 0.25 }),
  grab:   () => sample('grab', { vol: 0.55, from: 0.24, dur: 0.3 }), // straight to the clack
  lay:    (o) => sample('lay', { vol: o.vol ?? 0.45 }),
  // points landing in a total: a few chips, more for more points
  chips:  (o) => {
    const n = Math.min(3, 1 + Math.floor((o.points || 0) / 10));
    for (let i = 0; i < n; i++) sample('stack', { vol: 0.5, delay: i * 0.055 });
  },
  sweep:  () => { sample('collide', { vol: 0.7 }); sample('handle', { vol: 0.5, delay: 0.12 }); },
  // a score worth noticing: 1 = good, 2 = big, 3 = huge
  chime:  (o) => {
    const steps = [[0, 4, 7], [0, 4, 7, 12], [0, 4, 7, 12, 16, 19]][Math.min(3, o.level || 1) - 1];
    steps.forEach((s, i) => note(hz(C5 + s), { at: i * 0.06, len: 0.22, vol: 0.13 }));
    if (o.level >= 3) note(hz(C5 + 24), { at: steps.length * 0.06, len: 0.5, vol: 0.08, type: 'sine' });
  },
  blank:  () => { note(hz(C5 - 5), { len: 0.12, vol: 0.12, type: 'square', filter: 900 }); note(hz(C5 - 8), { at: 0.11, len: 0.22, vol: 0.12, type: 'square', filter: 700 }); },
  buzz:   () => note(110, { len: 0.16, vol: 0.12, type: 'sawtooth', filter: 600 }),
  power:  () => { note(hz(C5 + 7), { len: 0.09, vol: 0.12 }); note(hz(C5 + 14), { at: 0.07, len: 0.16, vol: 0.12 }); },
  unpower: () => { note(hz(C5 + 14), { len: 0.09, vol: 0.1 }); note(hz(C5 + 7), { at: 0.07, len: 0.14, vol: 0.1 }); },
  peek:   () => [0, 7, 14].forEach((s, i) => note(hz(C5 + 12 + s), { at: i * 0.05, len: 0.25, vol: 0.07, type: 'sine' })),
  locked: () => note(hz(C5 - 12 + 7), { len: 0.08, vol: 0.1, type: 'sine' }),
  // the clock in its last seconds: a dry tick, higher and louder for the final five
  tick:   (o) => note(o.final ? 1800 : 1250, { len: 0.035, vol: o.final ? 0.12 : 0.07, type: 'square', filter: 3000 }),
  lead:   (o) => (o.mine
    ? [0, 4, 7].forEach((s, i) => note(hz(C5 + 7 + s), { at: i * 0.05, len: 0.16, vol: 0.11 }))
    : [7, 4, 0].forEach((s, i) => note(hz(C5 - 5 + s), { at: i * 0.07, len: 0.18, vol: 0.1, type: 'square', filter: 900 }))),
  win:    () => {
    [0, 4, 7, 12].forEach((s, i) => note(hz(C5 + s), { at: i * 0.11, len: 0.2, vol: 0.14 }));
    [0, 4, 7, 12].forEach((s) => note(hz(C5 + 12 + s), { at: 0.46, len: 0.9, vol: 0.06, type: 'sawtooth', filter: 2400, attack: 0.02 }));
    sample('handle', { vol: 0.6, delay: 0.5 });
  },
  lose:   () => [0, -1, -2].forEach((s, i) => note(hz(C5 - 5 + s), { at: i * 0.3, len: i === 2 ? 0.7 : 0.28, vol: 0.13, type: 'sawtooth', filter: 800, to: i === 2 ? hz(C5 - 9) : null })),
  draw:   () => { note(hz(C5), { len: 0.25, vol: 0.12 }); note(hz(C5 + 7), { at: 0.2, len: 0.4, vol: 0.1 }); },
};

export function play(name, opts = {}) {
  if (!ready() || !CUES[name]) return;
  try { CUES[name](opts); } catch { /* never let a sound break the game */ }
}
