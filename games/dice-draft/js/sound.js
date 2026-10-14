// Sound. The physical sounds (dice shaken, thrown and set down, casino chips for
// points) are short recordings from Kenney's Casino Audio (CC0), trimmed and
// converted to AAC in assets/sound/. The payoffs and warnings (chimes, the clock
// tick, the win and lose stings) are synthesised here, so they cost no download.
// The music is three looped tracks in assets/music/ (see "music" below).
//
// Web Audio only. Browsers keep audio locked until the first tap or key press, so
// the context is resumed then. Nothing here ever throws: a browser without Web
// Audio, a file that fails to load or a blocked context just means silence.
//
// The mix: game sounds → sfx ┐
//          music tracks → musicBus (ducks) → musicOut ┴→ master → limiter → speakers
// Settings sets three volumes (overall, music, game sounds); the sound and music
// switches mute on top of them. All of it is remembered per device.

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
const MUSIC_KEY = 'bad-to-the-bone:music-off';
const VOLUME_KEY = 'bad-to-the-bone:volume';
const MASTER = 0.8; // the master gain at full overall volume

let ctx = null;
let master = null;   // overall volume, and the sound switch
let sfx = null;      // game sounds volume
let musicOut = null; // music volume
let musicBus = null; // where the tracks meet; ducks under the result stings
let muted = false;
let musicOn = true;
const volume = { master: 1, music: 1, sfx: 1 }; // as the sliders show them, 0 to 1
const buffers = {}; // name → [AudioBuffer]
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
  musicOn = localStorage.getItem(MUSIC_KEY) !== '1';
  const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) || '{}');
  for (const k of Object.keys(volume)) if (typeof saved[k] === 'number' && saved[k] >= 0 && saved[k] <= 1) volume[k] = saved[k];
} catch { /* storage blocked: defaults */ }
// A slider's position to a gain. Squared, so the middle of the slider sounds like
// the middle (half way is about −12 dB) rather than nearly full.
const curve = (v) => v * v;

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    // On iOS, 'ambient' respects the silent switch and mixes with the player's music.
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    ctx = new AC();
    master = ctx.createGain();
    sfx = ctx.createGain();
    musicOut = ctx.createGain();
    musicBus = ctx.createGain();
    sfx.connect(master);
    musicBus.connect(musicOut).connect(master);
    // A gentle limiter on the way out, so music and effects together never clip.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10; limit.knee.value = 6; limit.ratio.value = 6;
    limit.attack.value = 0.003; limit.release.value = 0.2;
    master.connect(limit).connect(ctx.destination);
    applyLevels();
  } catch { ctx = null; }
  return ctx;
}

// Resume on the first gesture (and again after the page was backgrounded).
function unlock() {
  const c = context();
  if (!c || c.state === 'running') return;
  c.resume().then(syncMusic, () => {});
  try { // older iOS only unlocks once something has actually played inside a gesture
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, 22050);
    s.connect(c.destination);
    s.start(0);
  } catch { /* fine */ }
}
for (const type of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(type, unlock, { capture: true, passive: true });
// Nothing plays from a background tab: suspend, and pick up again on return.
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) { for (const name of Object.keys(playing)) silence(name, true); ctx.suspend().catch(() => {}); }
  else ctx.resume().then(syncMusic, () => {});
});

// Fetch and decode every sample and track. Called at boot, behind the menu; the
// music starts as soon as its track is in (and audio is unlocked).
export async function loadSounds(base = 'assets/') {
  const c = context();
  if (!c) return;
  const decode = (url) => fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then((data) => new Promise((ok, fail) => c.decodeAudioData(data, ok, fail)));
  const jobs = [];
  for (const [name, t] of Object.entries(TRACKS)) {
    jobs.push(decode(`${base}music/${t.file}.m4a`).then((buf) => { tracks[name] = buf; syncMusic(); }).catch(() => {}));
  }
  for (const [name, files] of Object.entries(SAMPLES)) {
    buffers[name] = [];
    for (const f of files) jobs.push(decode(`${base}sound/${f}.m4a`).then((buf) => buffers[name].push(buf)).catch(() => {}));
  }
  await Promise.all(jobs);
}

export const isMuted = () => muted;
export function setMuted(on) {
  muted = !!on;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* not remembered, still applies */ }
  applyLevels();
  syncMusic();
}

export const isMusicOn = () => musicOn;
export function setMusic(on) {
  musicOn = !!on;
  try { localStorage.setItem(MUSIC_KEY, musicOn ? '0' : '1'); } catch { /* not remembered, still applies */ }
  syncMusic();
}

// Volumes, 0 to 1, by kind: 'master' (overall), 'music' or 'sfx' (game sounds).
export const getVolume = (kind) => volume[kind];
export function setVolume(kind, value) {
  if (!(kind in volume)) return;
  volume[kind] = Math.min(1, Math.max(0, Number(value) || 0));
  try { localStorage.setItem(VOLUME_KEY, JSON.stringify(volume)); } catch { /* not remembered, still applies */ }
  applyLevels();
  syncMusic();
}

function applyLevels() {
  if (!ctx) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(muted ? 0 : MASTER * curve(volume.master), t, 0.02);
  sfx.gain.setTargetAtTime(curve(volume.sfx), t, 0.02);
  musicOut.gain.setTargetAtTime(curve(volume.music), t, 0.02);
}

const ready = () => ctx && ctx.state === 'running' && !muted && volume.sfx > 0;
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
  src.connect(g).connect(sfx);
  src.start(t, from);
  if (dur) src.stop(t + dur + 0.02);
}

// One synthesised note: an oscillator through a short envelope.
function note(freq, { at = 0, when = null, len = 0.14, vol = 0.18, type = 'triangle', to = null, attack = 0.005, filter = 0 } = {}) {
  const t = when ?? ctx.currentTime + at;
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
  out.connect(sfx);
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
    duck(3);
    [0, 4, 7, 12].forEach((s, i) => note(hz(C5 + s), { at: i * 0.11, len: 0.2, vol: 0.14 }));
    [0, 4, 7, 12].forEach((s) => note(hz(C5 + 12 + s), { at: 0.46, len: 0.9, vol: 0.06, type: 'sawtooth', filter: 2400, attack: 0.02 }));
    sample('handle', { vol: 0.6, delay: 0.5 });
  },
  lose:   () => duck(2.5) || [0, -1, -2].forEach((s, i) => note(hz(C5 - 5 + s), { at: i * 0.3, len: i === 2 ? 0.7 : 0.28, vol: 0.13, type: 'sawtooth', filter: 800, to: i === 2 ? hz(C5 - 9) : null })),
  draw:   () => { duck(1.5); note(hz(C5), { len: 0.25, vol: 0.12 }); note(hz(C5 + 7), { at: 0.2, len: 0.4, vol: 0.1 }); },
};

export function play(name, opts = {}) {
  if (!ready() || !CUES[name]) return;
  try { CUES[name](opts); } catch { /* never let a sound break the game */ }
}

// ---------- music ----------
// Three looped tracks, each exactly 32 beats so it repeats with no seam: the main
// theme (the menu and most of a match), a faster one while the player is on a
// streak, and a calmer one for the tutorial and How to play. The game names the
// scene with setMusicScene(); one track is heard at a time and a change crossfades.
// The main theme keeps running silently under the others, so when it comes back
// it carries on where it left off; the others start from the top each time.
// At full volume the main theme and the streak track sit near −31 dB RMS, just
// under the effects (the user found −40 too quiet on a phone; Settings can raise
// it). The tutorial track is sparse, so its average sits lower while its loud
// passages match the main theme.
const beats = (n, bpm) => (n * 60) / bpm;
const TRACKS = {
  main:     { file: 'main-menu', secs: beats(32, 108), level: 0.17, fadeIn: 0.5 },
  streak:   { file: 'streak',    secs: beats(32, 132), level: 0.14, fadeIn: 0.12 },
  tutorial: { file: 'tutorial',  secs: beats(32, 92),  level: 0.24, fadeIn: 0.3 },
};
const tracks = {};  // name → AudioBuffer, once loaded
const playing = {}; // name → { src, gain } while it runs
let scene = 'main';

export function setMusicScene(name) {
  if (!TRACKS[name] || name === scene) return;
  scene = name;
  syncMusic();
}

// The track's player, started (silent) if it isn't running.
function voice(name) {
  if (playing[name]) return playing[name];
  const t = TRACKS[name], buf = tracks[name];
  if (!buf) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  // Browsers drop the AAC encoder's 2112-frame lead-in when decoding (Chrome does,
  // measured). One that kept it would loop a gap, so loop past it.
  const lead = buf.duration > t.secs + 0.01 ? 2112 / 22050 : 0;
  src.loopStart = lead;
  src.loopEnd = lead + t.secs;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(musicBus);
  src.start(ctx.currentTime + 0.02, lead);
  return (playing[name] = { src, gain });
}

function fadeTo(p, level, tc) {
  const g = p.gain.gain, t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.setTargetAtTime(level, t, tc);
}

// Fade a track out and stop it (`now`: stop it dead).
function silence(name, now = false) {
  const p = playing[name];
  if (!p) return;
  delete playing[name];
  if (now) { p.src.stop(); return; }
  fadeTo(p, 0, 0.25);
  p.src.stop(ctx.currentTime + 1.5);
}

// Music plays when it is switched on and turned up, sound isn't muted, audio is
// unlocked and the tab is in front.
function syncMusic() {
  try {
    const on = ctx && ctx.state === 'running' && musicOn && !muted && !document.hidden && volume.music > 0 && volume.master > 0;
    for (const name of Object.keys(TRACKS)) {
      const p = on && (name === scene || name === 'main') ? voice(name) : null;
      if (p) fadeTo(p, name === scene ? TRACKS[name].level : 0, name === scene ? TRACKS[name].fadeIn : 0.25);
      else silence(name);
    }
  } catch { /* silence */ }
}

// Drop the music under a result sting, then bring it back.
function duck(seconds) {
  if (!musicBus) return;
  const g = musicBus.gain, t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(0.25, t, 0.08);
  g.setTargetAtTime(1, t + seconds, 0.6);
}
