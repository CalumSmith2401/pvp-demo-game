// Phaser 3 duel arena. It consumes the combat engine's typed event stream and
// animates two hooded casters trading spells, with a distinct effect per spell:
// fire orbs, frost shards, meteors through a sky portal, forked lightning, blade
// slashes, life-drain wisps, toxic lobs, rune seals, heal pillars, hex shields,
// haste spirals, and mirror panes. Screen shake, zoom punches, hit-stop, a
// shockwave post-FX shader, and a slow-motion killing blow layer on top.
//
// `Arena` is a thin wrapper that owns the Phaser.Game; all rendering lives in
// `DuelScene`. Playback is event-driven: the controller calls step() to play the
// next event; the arena reports back via the onSettled callback once that event
// has resolved, which lets manual stepping and auto-play share the same path.
// Choreography runs on the scene's own clock (this.time / this.tweens / particle
// emitters), so hit-stop and slow-mo scale everything together.

import * as Phaser from 'phaser';

const W = 720;
const H = 380;
const GROUND = 300;
const PAD = 24; // background overdraw so shake/zoom never reveals an edge

// Must stay in sync with the --c-* accents in css/styles.css (WebGL can't read CSS vars).
const SPELL_COLORS = {
  fireball: '#E8541E', meteor: '#ff3d00', frostbolt: '#5aaed8', lightning: '#f0c030',
  drain: '#7B2D8E', soulsiphon: '#9a3aaa', embergrasp: '#A8731E', plague: '#7a8a18',
  heal: '#3C9D4F', bolster: '#4db85f', shield: '#3A7FB5', wardstone: '#4a90d0',
  chainlightning: '#d4a020', execute: '#c03020', reflectward: '#60a8e0', manabarrier: '#5088c0',
  corrosion: '#6a8818', vampiric: '#8a2888', bloodpact: '#b030a0',
  silence: '#D4AF5C', haste: '#f0c040', mirror: '#e8d090',
};

// Visual archetype per spell; falls back on the event kind for unknown ids.
const STYLE = {
  fireball: 'fire', meteor: 'meteor', frostbolt: 'frost', lightning: 'bolt',
  chainlightning: 'chain', execute: 'slash',
  drain: 'drain', soulsiphon: 'drain', vampiric: 'drain', bloodpact: 'drain',
  embergrasp: 'lob', plague: 'lob', corrosion: 'lob', silence: 'rune',
  heal: 'heal', bolster: 'heal', haste: 'haste', mirror: 'mirror',
  shield: 'shield', wardstone: 'shield', reflectward: 'shield', manabarrier: 'shield',
};
const KIND_STYLE = { damage: 'fire', drain: 'drain', burn: 'lob', heal: 'heal', shield: 'shield', control: 'rune' };

const TEAM = {
  a: { accent: '#4ade80', robe: '#1f3a2b', cape: '#12241a', trim: '#6fe0a0' },
  b: { accent: '#ff6b6b', robe: '#3d1c1c', cape: '#251010', trim: '#ff9a8a' },
};

const GOLD = '#D4AF5C';
const WIND = 0.26; // cast wind-up, seconds of game time
// Particle sizes are radii in logical px; this is each texture's radius at scale 1×dpr.
const TEX_R = { glow: 32, dot: 16, spark: 32, shard: 12, smoke: 64 };
const DEPTH = { bg: 0, ambient: 1, ground: 2, caster: 3, fx: 4, text: 5 };
const ADD = Phaser.BlendModes.ADD;

// ---------- small helpers ----------
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const val = (v) => (Array.isArray(v) ? rand(v[0], v[1]) : v);
const hex = (c) => (typeof c === 'number' ? c : parseInt(c.slice(1), 16));
const keep = (_p, _k, _t, v) => v;
const hasWebGL = () => {
  try { return !!document.createElement('canvas').getContext('webgl'); } catch { return false; }
};
const ease = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  inQuad: (t) => t * t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
};
// Particle rotation follows velocity (streaky sparks). Rotation is emitted before
// velocity in Phaser, so it has to be set on update.
const alongVelocity = {
  onEmit: () => 0,
  onUpdate: (p) => Phaser.Math.RadToDeg(Math.atan2(p.velocityY, p.velocityX)),
};

// ---------- textures (painted once on 2D canvases at devicePixelRatio) ----------
function radial(ctx, x, y, r, stops) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}

function createTextures(scene, dpr) {
  const add = (key, w, h, draw) => {
    if (scene.textures.exists(key)) return;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    draw(ctx);
    scene.textures.addCanvas(key, c);
  };
  const white = (a = 1) => `rgba(255,255,255,${a})`;

  add('glow', 64, 64, (ctx) => {
    ctx.fillStyle = radial(ctx, 32, 32, 32, [[0, white()], [0.3, white(0.45)], [1, white(0)]]);
    ctx.fillRect(0, 0, 64, 64);
  });
  add('dot', 32, 32, (ctx) => {
    ctx.fillStyle = radial(ctx, 16, 16, 16, [[0, white()], [0.55, white(0.9)], [1, white(0)]]);
    ctx.fillRect(0, 0, 32, 32);
  });
  add('spark', 64, 16, (ctx) => {
    ctx.scale(1, 0.25);
    ctx.fillStyle = radial(ctx, 32, 32, 32, [[0, white()], [0.4, white(0.6)], [1, white(0)]]);
    ctx.fillRect(0, 0, 64, 64);
  });
  add('shard', 20, 32, (ctx) => {
    ctx.fillStyle = white(0.95);
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(19, 14); ctx.lineTo(10, 32); ctx.lineTo(1, 14);
    ctx.closePath();
    ctx.fill();
  });
  add('smoke', 128, 128, (ctx) => {
    for (let i = 0; i < 9; i++) {
      const x = rand(40, 88), y = rand(40, 88), r = rand(22, 40);
      ctx.fillStyle = radial(ctx, x, y, r, [[0, white(0.22)], [1, white(0)]]);
      ctx.fillRect(0, 0, 128, 128);
    }
  });
  add('ring', 106, 106, (ctx) => {
    ctx.strokeStyle = white();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(53, 53, 50, 0, Math.PI * 2); ctx.stroke();
  });
  // rune circle, radius 62
  add('rune', 132, 132, (ctx) => {
    ctx.translate(66, 66);
    ctx.strokeStyle = white(0.9);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 62, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = white(0.6);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 52, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = white(0.7);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r1 = i % 3 === 0 ? 61 : 58;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 53, Math.sin(a) * 53);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.strokeStyle = white(0.55);
    for (const off of [0, Math.PI]) {
      ctx.beginPath();
      for (let k = 0; k <= 3; k++) {
        const a = off + (k / 3) * Math.PI * 2 - Math.PI / 2;
        ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * 50, Math.sin(a) * 50);
      }
      ctx.stroke();
    }
  });
  // hex-cell shield bubble, rx 52 / ry 74
  add('bubble', 110, 154, (ctx) => {
    const rx = 52, ry = 74, r = 9, hw = Math.sqrt(3) * r;
    ctx.translate(55, 77);
    ctx.fillStyle = white(0.1);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = white(0.28);
    ctx.lineWidth = 1;
    for (let row = -10; row <= 10; row++) {
      for (let col = -5; col <= 5; col++) {
        const x = col * hw + (row & 1 ? hw / 2 : 0);
        const y = row * r * 1.5;
        const verts = [0, 1, 2, 3, 4, 5].map((k) => {
          const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
          return [x + Math.cos(a) * r, y + Math.sin(a) * r];
        });
        if (!verts.every(([vx, vy]) => (vx / rx) ** 2 + (vy / ry) ** 2 <= 0.92)) continue;
        ctx.beginPath();
        verts.forEach(([vx, vy], i) => ctx[i ? 'lineTo' : 'moveTo'](vx, vy));
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.strokeStyle = white(0.85);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  });
  // rune glyph (silence), radius 40
  add('glyph', 108, 108, (ctx) => {
    const r = 40;
    ctx.translate(54, 54);
    ctx.strokeStyle = white();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k <= 3; k++) {
      const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
      ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    }
    ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3);
      ctx.stroke();
    }
  });
  add('mirror', 48, 128, (ctx) => {
    ctx.translate(24, 64);
    ctx.fillStyle = white(0.12);
    ctx.strokeStyle = white(0.9);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 22, 62, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = white(0.4);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-8, -40); ctx.lineTo(6, 30); ctx.stroke();
  });
  add('vignette', W, H, (ctx) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(5,3,1,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });
  add('bg', W + PAD * 2, H + PAD * 2, (ctx) => paintBackground(ctx));
}

// Eclipse sky, layered ridges, ruined columns, perspective floor.
function paintBackground(ctx) {
  const w = W + PAD * 2, h = H + PAD * 2;
  ctx.translate(PAD, PAD);
  const sky = ctx.createLinearGradient(0, -PAD, 0, GROUND);
  sky.addColorStop(0, '#0a0604');
  sky.addColorStop(0.55, '#1e1209');
  sky.addColorStop(1, '#3a200c');
  ctx.fillStyle = sky;
  ctx.fillRect(-PAD, -PAD, w, h);

  const mx = W / 2, my = 112;
  ctx.fillStyle = radial(ctx, mx, my, 150, [[0, 'rgba(212,175,92,0.32)'], [0.35, 'rgba(212,140,60,0.14)'], [1, 'rgba(0,0,0,0)']]);
  ctx.fillRect(mx - 150, my - 150, 300, 300);
  ctx.fillStyle = '#0d0805';
  ctx.beginPath(); ctx.arc(mx, my, 40, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(240,200,120,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(mx, my, 40.5, 0, Math.PI * 2); ctx.stroke();

  const ridge = (base, amp, color, f1, f2, ph) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-PAD, GROUND);
    for (let x = -PAD; x <= W + PAD; x += 6) {
      const y = base - amp * (0.5 + 0.3 * Math.sin(x * f1 + ph) + 0.2 * Math.sin(x * f2 + ph * 2.3)) - Math.abs(Math.sin(x * 0.11 + ph)) * 6;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + PAD, GROUND);
    ctx.closePath();
    ctx.fill();
  };
  ridge(GROUND - 40, 90, '#20130a', 0.012, 0.031, 1.2);
  ridge(GROUND - 20, 60, '#170e07', 0.018, 0.043, 4.1);

  const column = (x, top, wdt, side) => {
    ctx.fillStyle = '#120b06';
    ctx.fillRect(x - wdt / 2, top, wdt, GROUND - top);
    ctx.beginPath();
    ctx.moveTo(x - wdt / 2, top);
    ctx.lineTo(x - wdt / 4, top - 10);
    ctx.lineTo(x + wdt / 6, top - 4);
    ctx.lineTo(x + wdt / 2, top - 14);
    ctx.lineTo(x + wdt / 2, top);
    ctx.fill();
    ctx.fillRect(x - wdt / 2 - 5, GROUND - 14, wdt + 10, 14);
    ctx.strokeStyle = 'rgba(212,160,90,0.28)';
    ctx.lineWidth = 1.5;
    const rx = x + (wdt / 2) * side;
    ctx.beginPath(); ctx.moveTo(rx, top - 6); ctx.lineTo(rx, GROUND - 14); ctx.stroke();
  };
  column(22, 120, 30, 1);
  column(W - 22, 140, 30, -1);
  column(72, 196, 18, 1);
  column(W - 76, 184, 18, -1);

  const floor = ctx.createLinearGradient(0, GROUND, 0, H + PAD);
  floor.addColorStop(0, '#2c180a');
  floor.addColorStop(1, '#0c0703');
  ctx.fillStyle = floor;
  ctx.fillRect(-PAD, GROUND, w, H + PAD - GROUND);
  ctx.strokeStyle = 'rgba(212,175,92,0.09)';
  ctx.lineWidth = 1;
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 24, GROUND);
    ctx.lineTo(W / 2 + i * 110, H + PAD);
    ctx.stroke();
  }
  for (let i = 1; i < 7; i++) {
    const y = GROUND + (H + PAD - GROUND) * (i / 7) ** 1.6;
    ctx.beginPath(); ctx.moveTo(-PAD, y); ctx.lineTo(W + PAD, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(212,175,92,0.45)';
  ctx.beginPath(); ctx.moveTo(-PAD, GROUND); ctx.lineTo(W + PAD, GROUND); ctx.stroke();
}

// ---------- shockwave post-FX (WebGL only) ----------
const SHOCK_FRAG = `
#define SHADER_NAME SHOCKWAVE_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec2 uCenter;
uniform float uTime;
uniform float uAspect;
uniform float uAmp;
varying vec2 outTexCoord;
void main() {
  vec2 uv = outTexCoord;
  vec2 d = uv - uCenter;
  d.x *= uAspect;
  float dist = length(d);
  float radius = uTime * 1.25;
  float width = 0.1;
  float diff = dist - radius;
  vec4 col;
  if (dist > 0.0 && abs(diff) < width) {
    float p = 1.0 - pow(abs(diff) / width, 2.0);
    float fade = clamp(1.0 - uTime / 0.65, 0.0, 1.0);
    vec2 dir = normalize(d);
    dir.x /= uAspect;
    col = texture2D(uMainSampler, uv - dir * p * 0.03 * uAmp * fade);
    col.rgb *= 1.0 + 0.3 * p * fade;
  } else {
    col = texture2D(uMainSampler, uv);
  }
  gl_FragColor = col;
}`;

class ShockwavePipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  constructor(game) {
    super({ game, name: 'Shockwave', fragShader: SHOCK_FRAG });
    this.center = { x: 0.5, y: 0.5 };
    this.time = 0;
    this.amp = 1;
  }

  onPreRender() {
    this.set2f('uCenter', this.center.x, this.center.y);
    this.set1f('uTime', this.time);
    this.set1f('uAspect', W / H);
    this.set1f('uAmp', this.amp);
  }
}

// =====================================================================
// Arena: the public API game.js uses (start / step / stop / atEnd / isBusy)
// =====================================================================
export class Arena {
  constructor(canvas) {
    this.canvas = canvas;
    this.events = [];
    this.idx = 0;
    this.isBusy = false;
    this.onLog = null;
    this.speed = 1; // playback-speed multiplier for the whole scene clock
    this.scene = null;
    this.ready = this._boot().catch((err) => {
      console.error('Arena failed to initialise', err);
      this.failed = true;
    });
  }

  async _boot() {
    // Phaser text rasterises on a canvas, so Cinzel must be loaded first.
    if (document.fonts) {
      await Promise.all(['400 13px Cinzel', '700 20px Cinzel'].map((f) => document.fonts.load(f))).catch(() => {});
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    // The game renders at logical × dpr and the cameras zoom by dpr, so world units
    // stay 720×380. CSS sizes #arena (see CLAUDE.md "Canvas crispness").
    await new Promise((resolve) => {
      this.game = new Phaser.Game({
        type: hasWebGL() ? Phaser.WEBGL : Phaser.CANVAS, // AUTO isn't allowed with a supplied canvas
        canvas: this.canvas,
        width: W * this.dpr,
        height: H * this.dpr,
        backgroundColor: '#0d0803',
        banner: false,
        audio: { noAudio: true },
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        scale: { mode: Phaser.Scale.NONE, zoom: 1 / this.dpr },
        render: { antialias: true },
        scene: [],
        callbacks: { postBoot: () => resolve() },
      });
    });
    this.game.scene.add('duel', DuelScene, false);
  }

  start(events, opts) {
    this.events = events;
    this.idx = 0;
    this.isBusy = false;
    this.scene = null;
    this.sceneReady = new Promise((r) => { this._sceneResolve = r; });
    const token = (this.startToken = {});
    this.ready.then(() => {
      if (this.failed || this.startToken !== token) return;
      this.game.loop.wake();
      this.game.scene.start('duel', { arena: this, opts }); // restarts it if already running
    });
  }

  _attach(scene) {
    this.scene = scene;
    this._sceneResolve();
  }

  atEnd() { return this.idx >= this.events.length; }

  step(onSettled) {
    if (this.isBusy || this.atEnd() || this.failed) return false;
    if (!this.scene) {
      // Phaser is still booting / the scene is restarting: hold the step.
      this.isBusy = true;
      this.sceneReady.then(() => {
        this.isBusy = false;
        this.step(onSettled);
      });
      return true;
    }
    const ev = this.events[this.idx++];
    this.isBusy = true;
    if (this.onLog) this.onLog(ev);
    this.scene.play(ev, () => { this.isBusy = false; if (onSettled) onSettled(); });
    return true;
  }

  stop() {
    this.startToken = null;
    if (this.game) this.game.loop.sleep();
  }
}

// =====================================================================
// DuelScene: everything visual
// =====================================================================
class DuelScene extends Phaser.Scene {
  constructor() {
    super({ key: 'duel' });
  }

  create({ arena, opts }) {
    this.arena = arena;
    this.dpr = arena.dpr;
    createTextures(this, this.dpr);
    this.webgl = this.renderer.type === Phaser.WEBGL;
    if (this.webgl && !this.renderer.pipelines.postPipelineClasses.has('Shockwave')) {
      this.renderer.pipelines.addPostPipeline('Shockwave', ShockwavePipeline);
    }

    this.ts = 1;          // hit-stop / slow-mo clock scale
    this.hitstop = 0;     // real seconds of freeze remaining
    this.slowmo = 0;      // real seconds of slow-motion remaining
    this.trauma = 0;      // camera shake energy, 0..1
    this.zoomAmt = 0;     // extra camera zoom from impact punches
    this.focus = { x: W / 2, y: H / 2 };
    this.shock = null;
    this.emitters = new Set();
    this.floaters = [];
    this.clock = 0;

    // world layer → main camera (shake / zoom / shockwave); hud layer → fixed ui camera
    this.world = this.add.layer();
    this.hud = this.add.layer();
    const cam = this.cameras.main;
    cam.setZoom(this.dpr).centerOn(W / 2, H / 2);
    this.uiCam = this.cameras.add(0, 0, W * this.dpr, H * this.dpr).setZoom(this.dpr).centerOn(W / 2, H / 2);
    cam.ignore(this.hud);
    this.uiCam.ignore(this.world);

    this._buildBackground();
    this.c = {
      a: this._mkCaster('a', 170, 1, opts.a, opts.maxHp),
      b: this._mkCaster('b', W - 170, -1, opts.b, opts.maxHp),
    };
    this._buildHud();
    this._setTimeScale();
    this.arena._attach(this);
  }

  // ---------- object helpers ----------
  _w(obj, depth = DEPTH.fx) {
    obj.setDepth(depth);
    this.world.add(obj);
    return obj;
  }

  _img(key, x, y, { tint, alpha = 1, add = true, depth = DEPTH.fx, scale = 1 } = {}) {
    const im = this.add.image(x, y, key).setScale(scale / this.dpr).setAlpha(alpha);
    if (tint != null) im.setTint(hex(tint));
    if (add) im.setBlendMode(ADD);
    return this._w(im, depth);
  }

  _text(x, y, str, size, color, weight = 'bold', layer = this.world) {
    const t = this.add.text(x, y, str, {
      fontFamily: 'Cinzel, serif', fontSize: `${size}px`, fontStyle: weight, color,
      stroke: '#000000', strokeThickness: size >= 18 ? 4 : 3,
    }).setResolution(this.dpr).setDepth(DEPTH.text);
    layer.add(t);
    return t;
  }

  // Scale op mapping a radius in px (number or [min,max]) to texture scale, shrinking over life.
  _sizeOp(tex, size, size1) {
    const k = 1 / (TEX_R[tex] * this.dpr);
    return {
      onEmit: (p) => {
        p._s0 = val(size);
        p._s1 = size1 == null ? p._s0 * 0.2 : val(size1);
        return p._s0 * k;
      },
      onUpdate: (p, _key, t) => lerp(p._s0, p._s1, t) * k,
    };
  }

  _emitter(tex, cfg, depth = DEPTH.fx) {
    const em = this.add.particles(0, 0, tex, { blendMode: 'ADD', emitting: false, ...cfg });
    em.timeScale = this.ts * (this.arena.speed || 1);
    this.emitters.add(em);
    em.once('destroy', () => this.emitters.delete(em));
    return this._w(em, depth);
  }

  // One-shot radial burst at a point.
  _burst(x, y, colors, n, { tex = 'spark', speed = [80, 260], size = [2, 4], size1, g = 120, life = [0.35, 0.8], blend = 'ADD', alpha = 1, depth } = {}) {
    const em = this._emitter(tex, {
      speed: { min: speed[0], max: speed[1] },
      angle: { min: 0, max: 360 },
      lifespan: { min: life[0] * 1000, max: life[1] * 1000 },
      gravityY: g,
      blendMode: blend,
      scale: this._sizeOp(tex, size, size1),
      alpha: { start: alpha, end: 0 },
      tint: colors.map(hex),
      rotate: tex === 'spark' ? alongVelocity : tex === 'shard' ? { min: 0, max: 360 } : 0,
    }, depth);
    em.explode(n, x, y);
    this._after(life[1] + 0.1, () => em.destroy());
    return em;
  }

  // One-shot spawn across a zone (zone coords are world coords), with velocity config.
  _spray(zone, n, cfg, { tex = 'glow', size = [2, 4], size1, life = [0.4, 0.8], colors = ['#ffffff'], alpha = 1, depth } = {}) {
    const em = this._emitter(tex, {
      emitZone: zone,
      lifespan: { min: life[0] * 1000, max: life[1] * 1000 },
      scale: this._sizeOp(tex, size, size1),
      alpha: { start: alpha, end: 0 },
      tint: colors.map(hex),
      ...cfg,
    }, depth);
    em.explode(n, 0, 0);
    this._after(life[1] + 0.1, () => em.destroy());
    return em;
  }

  // An emitter driven per frame with emitParticleAt (projectile trails).
  _trail(tex, cfg, { size, size1, life, colors, alpha = 1, blend = 'ADD' }) {
    const em = this._emitter(tex, {
      lifespan: { min: life[0] * 1000, max: life[1] * 1000 },
      scale: this._sizeOp(tex, size, size1),
      alpha: { start: alpha, end: 0 },
      tint: colors.map(hex),
      blendMode: blend,
      ...cfg,
    });
    return { at: (x, y, n = 1) => em.emitParticleAt(x, y, n), end: () => this._after(life[1] + 0.1, () => em.destroy()) };
  }

  _rect(x, y, w, h) { return { type: 'random', source: new Phaser.Geom.Rectangle(x, y, w, h) }; }
  _circleEdge(x, y, r, n) { return { type: 'edge', source: new Phaser.Geom.Circle(x, y, r), quantity: n }; }

  // Clock helpers in seconds (scene clock, so they honour hit-stop / slow-mo).
  _after(sec, fn) { return this.time.delayedCall(sec * 1000, fn); }

  _tween(sec, update, done) {
    if (update) update(0, 0); // set the first frame's state before it renders
    let last = 0;
    return this.tweens.addCounter({
      from: 0, to: 1, duration: Math.max(1, sec * 1000),
      onUpdate: (tw) => {
        const p = tw.getValue();
        if (update) update(p, Math.max(0, p - last) * sec);
        last = p;
      },
      onComplete: () => { if (update) update(1, 0); if (done) done(); },
    });
  }

  _setTimeScale() {
    const s = this.ts * (this.arena.speed || 1);
    this.time.timeScale = s;
    this.tweens.timeScale = s;
    for (const em of this.emitters) em.timeScale = s;
  }

  // ---------- scene construction ----------
  _buildBackground() {
    this._w(this.add.image(-PAD, -PAD, 'bg').setOrigin(0).setScale(1 / this.dpr), DEPTH.bg);
    this.moonGlow = this._img('glow', W / 2, 112, { tint: '#f0c070', alpha: 0.25, scale: 4.2, depth: DEPTH.ambient });
    this.fog = [0, 1, 2].map((i) => {
      const f = this._img('smoke', i * 300, GROUND - 26 + i * 6, { tint: '#5a3818', alpha: 0.28, add: false, depth: DEPTH.ambient });
      f.setScale(4.5 / this.dpr, 1.4 / this.dpr);
      f.speed = 7 + i * 4;
      return f;
    });
    this.braziers = [42, W - 42].map((x) => {
      const bowl = [{ x: x - 13, y: GROUND - 22 }, { x: x + 13, y: GROUND - 22 }, { x: x + 8, y: GROUND - 12 }, { x: x - 8, y: GROUND - 12 }];
      const g = this._w(this.add.graphics(), DEPTH.ambient);
      g.fillStyle(0x3a2610).fillPoints(bowl, true).lineStyle(1, 0x8b6f3d).strokePoints(bowl, true);
      g.fillStyle(0x2a1a0a).fillRect(x - 2, GROUND - 12, 4, 12);
      const light = this._img('glow', x, GROUND - 30, { tint: '#ff9a3c', alpha: 0.4, scale: 2.6, depth: DEPTH.ambient });
      this._emitter('glow', {
        emitZone: this._rect(x - 7, GROUND - 25, 14, 3),
        frequency: 33,
        speedX: { min: -8, max: 8 },
        speedY: { min: -70, max: -40 },
        lifespan: { min: 350, max: 700 },
        scale: this._sizeOp('glow', [4, 7], 1),
        alpha: { start: 1, end: 0 },
        tint: ['#ff8a2a', '#ffb347', '#ff5a1a'].map(hex),
        emitting: true,
      }, DEPTH.ambient);
      return { x, light };
    });
    // rising embers across the whole arena
    this._emitter('glow', {
      emitZone: this._rect(0, H + 4, W, 1),
      frequency: 140,
      speedX: { min: -10, max: 10 },
      speedY: { min: -45, max: -20 },
      lifespan: { min: 4000, max: 8000 },
      scale: this._sizeOp('glow', [1, 2.4], [1, 2.4]),
      alpha: { onEmit: () => 0, onUpdate: (_p, _k, t) => 0.7 * Math.min(1, t * 6, (1 - t) * 3) },
      tint: ['#d4af5c', '#e8862a', '#f0c070'].map(hex),
      emitting: true,
      advance: 6000,
    }, DEPTH.ambient);
  }

  _mkCaster(key, x, facing, name, maxHp) {
    const team = TEAM[key];
    const k = 1 / this.dpr;
    const root = this._w(this.add.container(x, GROUND), DEPTH.caster);

    const shadow = this.add.graphics().fillStyle(0x000000, 0.45).fillEllipse(0, 6, 88, 18);
    // rune circle: rotate inside a vertically squashed container for perspective
    const runeOuter = this.add.container(0, 4).setScale(1, 0.26);
    const rune = this.add.image(0, 0, 'rune').setScale(k).setTint(hex(team.accent)).setAlpha(0.35).setBlendMode(ADD);
    runeOuter.add(rune);

    const body = this.add.container(0, 0).setScale(facing, 1); // drawn facing right, mirrored for b
    const robe = this.add.graphics();
    const flashG = this.add.graphics().setAlpha(0);
    const eyes = [[5, -106], [11, -106]].map(([ex, ey]) =>
      this.add.image(ex, ey, 'glow').setScale(0.14 * k).setTint(hex(team.accent)).setBlendMode(ADD));
    const orb = this.add.image(30, -134, 'glow').setScale(0.5 * k).setTint(hex(team.accent)).setBlendMode(ADD);
    body.add([robe, flashG, ...eyes, orb]);

    const bubble = this.add.image(0, -66, 'bubble').setScale(k).setTint(hex(SPELL_COLORS.shield)).setBlendMode(ADD).setAlpha(0);
    const glyph = this.add.image(-30 * facing, -128, 'glyph').setScale((10 / 40) * k).setTint(hex(SPELL_COLORS.silence)).setBlendMode(ADD).setAlpha(0);
    root.add([shadow, runeOuter, body, bubble, glyph]);

    const c = {
      key, x, facing, name, maxHp, team, root, body, robe, flashG, eyes, orb, rune, bubble, glyph,
      hp: maxHp, dispHp: maxHp, chip: maxHp, shield: 0, dispShield: 0, sinceHit: 9,
      offset: 0, lean: 0, castGlow: 0, hit: 0, phase: Math.random() * 6.28,
      burnHeat: 0, burnColor: SPELL_COLORS.embergrasp, silenced: false, hasted: false,
      bubblePop: 0, ripple: 0, dead: false, barShake: 0, stack: 0, stackT: 0,
    };
    // persistent status emitters, toggled from update()
    c.burnEm = this._emitter('glow', {
      emitZone: this._rect(x - 26, GROUND - 10, 52, 10),
      frequency: 30,
      speedX: { min: -10, max: 10 },
      speedY: { min: -90, max: -40 },
      lifespan: { min: 300, max: 600 },
      scale: this._sizeOp('glow', [4, 8], 1),
      alpha: { start: 1, end: 0 },
      tint: { onEmit: () => hex(pick([c.burnColor, '#ffb347', c.burnColor])), onUpdate: keep },
    });
    c.hasteEm = this._emitter('glow', {
      emitZone: this._rect(x - 38, GROUND - 120, 76, 110),
      frequency: 55,
      speedX: { min: -40, max: 40 },
      speedY: { min: -50, max: -20 },
      lifespan: 600,
      scale: this._sizeOp('glow', [1.5, 3]),
      alpha: { start: 1, end: 0 },
      tint: [hex('#f0c040'), hex('#fff0a0')],
    });
    return c;
  }

  // Robe, cape, hood, sleeve and staff — redrawn each frame for cloth sway.
  _drawCaster(g, c, sway, flat) {
    const t = c.team;
    const col = (x) => (flat ? 0xffffff : hex(x));
    const poly = (pts, color, alpha = 1) => {
      const p = [];
      for (let i = 0; i < pts.length; i += 2) p.push({ x: pts[i], y: pts[i + 1] });
      g.fillStyle(color, alpha).fillPoints(p, true);
    };
    g.clear();
    poly([-8, -92, 6, -92, 10 - sway * 0.4, -2, -38 + sway * 1.8, 0], col(t.cape));
    poly([-12, -90, 12, -90, 17, -50, 28 + sway, -2, -30 + sway * 1.2, -2, -18, -50], col(t.robe));
    if (!flat) {
      poly([-30 + sway * 1.2, -2, 28 + sway, -2, 27 + sway, -9, -28 + sway * 1.2, -9], hex(t.trim), 0.55);
      g.lineStyle(1.5, hex(t.trim), 0.6).lineBetween(3, -86, 1 + sway * 0.5, -9);
      g.fillStyle(hex(GOLD)).fillRect(-16, -57, 33, 5);
    }
    poly([4, -88, 14, -86, 31, -66, 24, -58], col(t.robe)); // sleeve
    g.fillStyle(col('#b8916a')).fillCircle(28, -62, 4);     // hand
    g.fillStyle(col('#5a3b1e')).fillRect(28, -124, 4, 122); // staff
    if (!flat) g.fillStyle(hex(GOLD)).fillRect(28, -100, 4, 3).fillRect(28, -30, 4, 3);
    poly([30, -142, 36, -132, 30, -122, 24, -132], col(t.accent)); // crystal
    poly([-13, -92, -16, -108, -9, -122, 3, -126, 13, -114, 16, -96], col(t.cape)); // hood
    if (!flat) g.fillStyle(0x070403).fillEllipse(7, -104, 15, 20); // shadowed face
  }

  _buildHud() {
    this.hud.add(this.add.image(0, 0, 'vignette').setOrigin(0).setScale(1 / this.dpr));
    this.flashRect = this.add.rectangle(0, 0, W, H, 0xffffff).setOrigin(0).setAlpha(0);
    this.hud.add(this.flashRect);
    this.flash = 0;
    for (const c of Object.values(this.c)) {
      const left = c.key === 'a';
      const bw = 270;
      const x = left ? 22 : W - 22 - bw;
      const bars = this.add.graphics();
      this.hud.add(bars);
      this._text(left ? x : x + bw, 26, c.name, 13, '#c8b890', '600', this.hud).setOrigin(left ? 0 : 1, 1);
      const hpT = this._text(left ? x + bw : x, 28, '', 18, '#E8DFC8', 'bold', this.hud).setOrigin(left ? 1 : 0, 1);
      const shT = this._text(left ? x : x + bw, 52, '', 12, '#7cc4f4', '600', this.hud).setOrigin(left ? 0 : 1, 0);
      c.hud = { bars, hpT, shT, bw, left, x, lastHp: null, lastSh: null };
    }
    const pts = [{ x: W / 2, y: 16 }, { x: W / 2 + 26, y: 38 }, { x: W / 2, y: 60 }, { x: W / 2 - 26, y: 38 }];
    const crest = this.add.graphics().fillStyle(0x1a1008, 0.9).fillPoints(pts, true).lineStyle(1, 0x8b6f3d).strokePoints(pts, true);
    this.hud.add(crest);
    this._text(W / 2, 38, 'VS', 20, GOLD, 'bold', this.hud).setOrigin(0.5);
  }

  _drawHud(c) {
    const h = c.hud;
    const { bw, left } = h;
    const g = h.bars;
    const bh = 16;
    const ox = h.x + (c.barShake > 0 ? rand(-5, 5) * c.barShake : 0);
    const oy = 30 + (c.barShake > 0 ? rand(-3, 3) * c.barShake : 0);
    const frac = (v) => Math.max(0, Math.min(1, v / c.maxHp));
    const seg = (from, to, y, hh, color, alpha = 1) => {
      const a = frac(from), b = frac(to);
      if (b <= a) return;
      const x0 = left ? 1 + (bw - 2) * a : bw - 1 - (bw - 2) * b;
      g.fillStyle(hex(color), alpha).fillRect(ox + x0, oy + y, (bw - 2) * (b - a), hh);
    };
    g.clear();
    // socketed frame: outer bronze line + dark inset
    g.fillStyle(0x0b0703).fillRect(ox - 1, oy - 1, bw + 2, bh + 2);
    g.lineStyle(1, 0x8b6f3d).strokeRect(ox - 1, oy - 1, bw + 2, bh + 2);
    g.lineStyle(1, 0x000000, 0.8).strokeRect(ox + 0.5, oy + 0.5, bw - 1, bh - 1);
    seg(c.dispHp, c.chip, 1, bh - 2, '#f3e2b0', 0.85);                             // damage chip
    if (c.hp > c.dispHp + 0.5) seg(c.dispHp, c.hp, 1, bh - 2, '#4ade80', 0.55); // incoming heal
    const low = c.dispHp < c.maxHp * 0.25 ? 0.5 + 0.5 * Math.sin(this.clock * 10) : 0;
    seg(0, c.dispHp, 1, bh - 2, c.hit > 0.4 ? '#C73E3E' : '#8E1F1F');
    seg(0, c.dispHp, 1, (bh - 2) * 0.4, '#d65050', 0.35 + low * 0.4);           // top sheen
    if (c.dispShield > 0.4) seg(0, Math.min(c.maxHp, c.dispShield), bh - 5, 4, '#5fb4ff', 0.95);
    g.lineStyle(1, hex(GOLD), 0.25 + c.hit * 0.6).strokeRect(ox - 1, oy - 1, bw + 2, bh + 2);

    const hp = Math.round(c.dispHp);
    if (hp !== h.lastHp) { h.hpT.setText(String(hp)); h.lastHp = hp; }
    const sh = Math.round(c.dispShield);
    if (sh !== h.lastSh) { h.shT.setText(sh > 0 ? `⬡ ${sh}` : ''); h.lastSh = sh; }
  }

  // ---------- per-frame update ----------
  update(_time, delta) {
    const realDt = Math.min(0.05, delta / 1000);
    let ts;
    if (this.hitstop > 0) { this.hitstop -= realDt; ts = 0; }
    else if (this.slowmo > 0) { this.slowmo -= realDt; ts = lerp(1, 0.22, clamp01(this.slowmo / 0.4)); }
    else ts = 1;
    const speed = this.arena.speed || 1;
    if (ts !== this.ts || speed !== this._lastSpeed) {
      this.ts = ts;
      this._lastSpeed = speed;
      this._setTimeScale();
    }
    const dt = realDt * ts * speed;
    this.clock += dt;

    this.moonGlow.setAlpha(0.22 + 0.06 * Math.sin(this.clock * 0.7));
    for (const f of this.fog) {
      f.x += f.speed * dt;
      if (f.x > W + 260) f.x = -260;
    }
    for (const b of this.braziers) b.light.setAlpha(0.32 + 0.08 * Math.sin(this.clock * 13 + b.x) + rand(-0.04, 0.04));
    for (const c of Object.values(this.c)) { this._updateCaster(c, dt); this._drawHud(c); }
    this._updateFloaters(dt);
    this._updateCamera(realDt, dt);
  }

  _updateCaster(c, dt) {
    const t = this.clock;
    const k = 1 / this.dpr;
    c.dispHp += (c.hp - c.dispHp) * Math.min(1, dt * (c.hp < c.dispHp ? 12 : 4));
    c.sinceHit += dt;
    if (c.chip < c.dispHp) c.chip = c.dispHp;
    else if (c.sinceHit > 0.45) c.chip += (c.dispHp - c.chip) * Math.min(1, dt * 3.5);
    c.dispShield += (c.shield - c.dispShield) * Math.min(1, dt * 9);
    c.offset += (0 - c.offset) * Math.min(1, dt * 10);
    c.lean += (0 - c.lean) * Math.min(1, dt * 7);
    c.castGlow = Math.max(0, c.castGlow - dt * 1.8);
    c.hit = Math.max(0, c.hit - dt * 3.2);
    c.barShake = Math.max(0, c.barShake - dt * 3);
    c.burnHeat = Math.max(0, c.burnHeat - dt * 0.12);
    c.bubblePop = Math.max(0, c.bubblePop - dt * 2.5);
    c.ripple = Math.max(0, c.ripple - dt * 3);
    c.stackT -= dt;
    if (c.stackT <= 0) c.stack = 0;

    const sway = Math.sin(t * 1.9 + c.phase) * 3 + c.offset * 0.25 * c.facing;
    const breathe = Math.sin(t * 2.2 + c.phase);
    if (!c.dead) {
      c.body.x = c.offset;
      c.body.y = breathe * 1.2;
      c.body.scaleY = 1 + breathe * 0.012;
      c.body.rotation = c.lean * c.facing;
    }
    this._drawCaster(c.robe, c, sway, false);
    if (c.hit > 0) { this._drawCaster(c.flashG, c, sway, true); c.flashG.setAlpha(c.hit * 0.85); }
    else c.flashG.setAlpha(0);

    if (c.castGlow < 0.05) c.orb.setTint(hex(c.team.accent));
    c.orb.setScale((0.45 + c.castGlow * 0.7 + 0.05 * Math.sin(t * 5 + c.phase)) * k);
    c.orb.setAlpha(c.dead ? 0 : 0.6 + c.castGlow * 0.4);
    for (const e of c.eyes) e.setAlpha(c.dead ? 0 : 0.75 + 0.25 * Math.sin(t * 3 + c.phase));
    c.rune.rotation += dt * (0.25 + c.castGlow * 3) * c.facing;
    c.rune.setAlpha(c.dead ? Math.max(0, c.rune.alpha - dt) : 0.3 + c.castGlow * 0.6);

    // shield bubble
    const target = c.dispShield > 0.4 ? 0.5 + 0.12 * Math.sin(t * 4 + c.phase) + c.ripple * 0.5 : 0;
    c.bubble.setAlpha(c.bubble.alpha + (target - c.bubble.alpha) * Math.min(1, dt * 10));
    const bs = (1 + c.ripple * 0.06 - c.bubblePop * 0.35) * k;
    c.bubble.setScale(bs * (1 + 0.012 * Math.sin(t * 3)), bs);
    c.bubble.x = c.offset;

    // status indicators
    c.glyph.setAlpha(c.glyph.alpha + ((c.silenced && !c.dead ? 0.7 + 0.3 * Math.sin(t * 6) : 0) - c.glyph.alpha) * Math.min(1, dt * 8));
    c.glyph.rotation += dt * 1.5;
    c.glyph.y = -128 + Math.sin(t * 2.5) * 3;
    c.hasteEm.emitting = c.hasted && !c.dead;
    const burning = c.burnHeat > 0.02 && !c.dead;
    c.burnEm.emitting = burning;
    if (burning) c.burnEm.frequency = Math.max(16, 1000 / (45 * c.burnHeat));
  }

  _updateCamera(realDt, dt) {
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    this.zoomAmt += (0 - this.zoomAmt) * Math.min(1, dt * 3.5);
    this.flash = Math.max(0, this.flash - realDt * 2.2);
    this.flashRect.setAlpha(this.flash * 0.4);
    const s = this.trauma * this.trauma * 14;
    const n = performance.now() / 16;
    const sx = (Math.sin(n * 0.79) + Math.sin(n * 1.31 + 1.7)) * 0.5 * s;
    const sy = (Math.sin(n * 0.97 + 0.5) + Math.sin(n * 1.53 + 2.9)) * 0.5 * s;
    // Zoom about the focus point (it stays put on screen) rather than panning to it.
    const z = 1 + this.zoomAmt;
    const cam = this.cameras.main;
    cam.setZoom(this.dpr * z);
    cam.centerOn(this.focus.x + (W / 2 - this.focus.x) / z + sx, this.focus.y + (H / 2 - this.focus.y) / z + sy);
    if (this.shock) {
      this.shock.time += dt;
      if (this.shock.time > 0.7) {
        cam.removePostPipeline('Shockwave');
        this.shock = null;
      }
    }
  }

  _floater(c, text, color, { size = 22 } = {}) {
    // Floaters within one beat stack upward; a new beat hurries the old ones out.
    if (c.stack === 0) {
      for (const f of this.floaters) if (f.owner === c) f.life = Math.min(f.life, 0.25);
    }
    const off = c.stack * 28;
    c.stack++;
    c.stackT = 0.45;
    const tx = this._text(c.x + rand(-10, 10), GROUND - 150 - off, text, size, color).setOrigin(0.5).setScale(0);
    this.floaters.push({ tx, owner: c, y: tx.y, vy: 34, life: 1.3, max: 1.3 });
  }

  _updateFloaters(dt) {
    this.floaters = this.floaters.filter((f) => {
      f.life -= dt;
      if (f.life <= 0) { f.tx.destroy(); return false; }
      const age = f.max - f.life;
      f.y -= f.vy * dt;
      f.vy *= 1 - Math.min(1, dt * 1.5);
      f.tx.y = f.y;
      f.tx.setScale(age < 0.2 ? 0.3 + ease.outBack(age / 0.2) : 1.3 - Math.min(0.3, (age - 0.2) * 1.5));
      f.tx.setAlpha(Math.min(1, f.life / Math.min(0.5, f.max * 0.4)));
      return true;
    });
  }

  _callout(c, text, color) {
    const tx = this._text(c.x, GROUND - 218, text, 14, color, '600').setOrigin(0.5).setAlpha(0);
    this._tween(1.1, (p) => {
      tx.setAlpha(p < 0.15 ? p / 0.15 : p > 0.7 ? (1 - p) / 0.3 : 1);
      tx.y = GROUND - 218 - p * 10;
      tx.setScale(0.9 + 0.1 * ease.outCubic(Math.min(1, p * 4)));
    }, () => tx.destroy());
  }

  // ---------- camera punches ----------
  _shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }
  _punch(amount, x, y) { this.zoomAmt = Math.max(this.zoomAmt, amount); this.focus = { x, y }; }
  _flash(alpha, color = '#ffffff') {
    this.flash = Math.max(this.flash, alpha);
    this.flashRect.setFillStyle(hex(color));
  }

  _shockwave(x, y, amp = 18) {
    if (!this.webgl) return;
    const cam = this.cameras.main;
    if (!this.shock) {
      cam.setPostPipeline('Shockwave');
      let pipe = cam.getPostPipeline('Shockwave');
      if (Array.isArray(pipe)) pipe = pipe[0];
      if (!pipe) return;
      this.shock = pipe;
    }
    const v = cam.worldView;
    this.shock.center = { x: (x - v.x) / v.width, y: 1 - (y - v.y) / v.height };
    this.shock.amp = amp / 18;
    this.shock.time = 0;
  }

  // ---------- geometry ----------
  _tip(c) { return { x: c.x + c.offset + 30 * c.facing, y: GROUND - 134 }; }
  _chest(c) { return { x: c.x + c.offset + 6 * c.facing, y: GROUND - 74 }; }
  _color(ev) { return SPELL_COLORS[ev.spellId] || GOLD; }

  _applyState(ev, keys = ['a', 'b']) {
    const s = ev.state;
    for (const k of keys) {
      const c = this.c[k];
      const prevShield = c.shield;
      c.hp = k === 'a' ? s.hpA : s.hpB;
      c.shield = k === 'a' ? s.shieldA : s.shieldB;
      if (prevShield > 0 && c.shield <= 0) this._shatter(c);
      if (c.hp <= 0 && !c.dead) this._die(c);
    }
  }

  // ---------- event choreography ----------
  play(ev, done) {
    if (ev.move === 'tick') return this._playTick(ev, done);
    const caster = this.c[ev.actor];
    const color = this._color(ev);
    const style = STYLE[ev.spellId] || KIND_STYLE[ev.kind] || 'fire';
    // A new cast consumes pending Silence / Haste on this caster.
    caster.silenced = false;
    caster.hasted = false;
    if (ev.name) this._callout(caster, (ev.mirrored ? 'Mirror → ' : '') + ev.name, color);
    const go = () => this[`_fx_${style}`](ev, caster, this.c[ev.target], color, done);
    if (ev.mirrored) { this._mirrorPane(caster, false); this._after(0.32, go); }
    else go();
  }

  _windup(c, color, dur = WIND, { sky = false } = {}) {
    c.lean = -0.1;
    c.rune.setTint(hex(color));
    c.orb.setTint(hex(color));
    const tip = this._tip(c);
    this._spray(this._circleEdge(tip.x, tip.y, 40, 14), 14, { moveToX: tip.x, moveToY: tip.y },
      { size: [2, 3.5], size1: 1.5, life: [dur, dur], colors: [color] });
    this._tween(dur, (p) => {
      c.castGlow = Math.max(c.castGlow, p);
      if (sky) c.lean = -0.1 - 0.06 * p;
    });
  }

  _release(c, color) {
    c.lean = 0.14;
    c.castGlow = 1;
    const tip = this._tip(c);
    this._flare(tip.x, tip.y, color, 26, 40, 0.25);
    this._burst(tip.x, tip.y, [color], 8, { speed: [80, 180], size: [3, 3], life: [0.3, 0.35], g: 0 });
  }

  // A single expanding, fading glow.
  _flare(x, y, color, r0, r1, dur, alpha = 0.9) {
    const im = this._img('glow', x, y, { tint: color, alpha });
    this._tween(dur, (p) => im.setScale(lerp(r0, r1, p) / 32 / this.dpr).setAlpha(alpha * (1 - p)), () => im.destroy());
  }

  // Common impact bookkeeping: state, floaters, knockback, camera, lethal check.
  _impact(ev, t, x, y, color, { power = 1, applyKeys = [ev.target], quiet = false } = {}) {
    this._applyState(ev, applyKeys);
    const dmg = ev.dmg || 0;
    const lethal = ev.state.hpA <= 0 || ev.state.hpB <= 0;
    if (ev.dmg != null && (dmg > 0 || !ev.absorbed)) {
      this._floater(t, '-' + dmg, lethal ? '#FFD700' : dmg >= 16 ? '#ff7a3c' : '#ff5b5b', { size: Math.min(34, 20 + dmg * 0.6) });
    }
    if (ev.absorbed) {
      t.ripple = 1;
      this._floater(t, ev.absorbed + ' blocked', '#7cc4f4', { size: 15 });
      this._burst(t.x + 44 * t.facing, y, ['#9fdcff'], 10, { speed: [60, 160], size: [3, 3], life: [0.35, 0.45], g: 0 });
    }
    if (dmg > 0) {
      t.hit = 1;
      t.sinceHit = 0;
      t.barShake = 1;
      t.offset = -Math.min(22, 8 + dmg * 0.6) * t.facing;
    }
    if (!quiet) {
      this._shake(Math.min(0.75, 0.18 + dmg * 0.025) * power);
      this._punch(Math.min(0.06, 0.012 + dmg * 0.002) * power, x, y);
      if (dmg >= 14) this.hitstop = Math.max(this.hitstop, 0.05 + dmg * 0.002);
    }
    if (lethal) this._lethal(x, y);
    else if (!quiet) this._flash(dmg >= 16 ? 0.45 : 0.18);
    return lethal;
  }

  _lethal(x, y) {
    this._flash(0.9, '#FFD700'); // gold flash is reserved for the killing blow
    this.hitstop = 0.16;
    this.slowmo = 1.1;
    this._shake(0.9);
    this._punch(0.14, x, y);
    this._shockwave(x, y, 26);
    this._burst(x, y, ['#FFD700', '#fff2b0', '#ffb347'], 60, { speed: [120, 420], size: [2, 4], life: [0.6, 1.3], g: 60 });
  }

  _die(c) {
    c.dead = true;
    c.hasted = false;
    c.silenced = false;
    c.burnHeat = 0;
    const start = c.body.rotation;
    const x0 = c.body.x;
    this._tween(1.0, (p) => {
      const e = ease.outCubic(p);
      c.body.rotation = start + (-1.35 * c.facing - start) * e;
      c.body.setAlpha(1 - 0.6 * e);
      c.body.x = x0 - 18 * c.facing * e;
      c.body.y = -10 * e;
    });
    // the body crumbles: ash (normal blend) plus a few embers (additive)
    const zone = () => this._rect(c.x - 30, GROUND - 90, 60, 90);
    const common = {
      frequency: 25, speedX: { min: -15, max: 15 }, speedY: { min: -80, max: -30 },
      lifespan: { min: 800, max: 1600 }, scale: this._sizeOp('glow', [2, 4]), alpha: { start: 1, end: 0 }, emitting: true,
    };
    const ash = this._emitter('glow', { ...common, emitZone: zone(), tint: [hex('#3a3028'), hex('#5a4a3a')], blendMode: 'NORMAL' });
    const embers = this._emitter('glow', { ...common, emitZone: zone(), frequency: 60, tint: hex('#ff8a2a') });
    this._after(1.4, () => { ash.stop(); embers.stop(); });
    this._after(3.2, () => { ash.destroy(); embers.destroy(); });
  }

  _shatter(c) {
    this._spray(this._circleEdge(c.x, GROUND - 66, 52, 26), 26,
      { speed: { min: 80, max: 200 }, angle: { min: 0, max: 360 }, gravityY: 380, rotate: { min: 0, max: 360 } },
      { tex: 'shard', size: [4, 7], size1: 2, life: [0.5, 0.9], colors: [c.bubble.tintTopLeft] });
  }

  _ring(x, y, color, { r0 = 10, r1 = 90, dur = 0.45, squash = 0.35, depth = DEPTH.fx } = {}) {
    const g = this._img('ring', x, y, { tint: color, depth });
    this._tween(dur, (p) => {
      const r = lerp(r0, r1, ease.outCubic(p)) / 50 / this.dpr;
      g.setScale(r, r * squash).setAlpha(1 - p);
    }, () => g.destroy());
  }

  // Fly a glowing head from `from` to `to`, calling trail(x, y) each frame.
  _fly({ from, to, dur, arc = 0, color, size = 12, easeFn = (p) => p, trail, onImpact }) {
    const halo = this._img('glow', from.x, from.y, { tint: color, alpha: 0.95, scale: size / 14 });
    const core = this._img('glow', from.x, from.y, { tint: '#ffffff', scale: size / 40 });
    this._tween(dur, (p) => {
      const e = easeFn(p);
      const x = lerp(from.x, to.x, e);
      const y = lerp(from.y, to.y, e) - Math.sin(Math.PI * e) * arc;
      halo.setPosition(x, y).setScale(((size / 14) * (1 + 0.15 * Math.sin(this.clock * 40))) / this.dpr);
      core.setPosition(x, y);
      if (trail && p > 0) trail(x, y);
    }, () => {
      halo.destroy();
      core.destroy();
      onImpact(to.x, to.y);
    });
  }

  _fx_fire(ev, c, t, color, done) {
    this._windup(c, color);
    this._after(WIND, () => {
      this._release(c, color);
      const size = 10 + (ev.value || 10) * 0.35;
      const flame = this._trail('glow', { speed: { min: 10, max: 40 }, angle: { min: 0, max: 360 }, gravityY: -60 },
        { size: [size * 0.5, size * 0.9], size1: 1, life: [0.25, 0.45], colors: [color, '#ffb347', '#ff7a1a'] });
      const smoke = this._trail('smoke', { speedX: { min: -10, max: 10 }, speedY: { min: -30, max: -10 } },
        { size: size * 0.8, size1: size * 1.6, life: [0.7, 0.7], colors: ['#2a1a10'], alpha: 0.5, blend: 'NORMAL' });
      this._fly({
        from: this._tip(c), to: this._chest(t), dur: 0.4, arc: 46, color, size, easeFn: ease.inQuad,
        trail: (x, y) => {
          flame.at(x, y, 3);
          if (Math.random() < 0.4) smoke.at(x, y);
        },
        onImpact: (x, y) => {
          flame.end(); smoke.end();
          this._impact(ev, t, x, y, color);
          this._flare(x, y, color, 40, 70, 0.3);
          this._burst(x, y, [color, '#ffb347', '#fff0c0'], 26 + (ev.dmg || 0));
          this._ring(x, y, color, { r1: 70, squash: 1 });
          this._after(0.36, done);
        },
      });
    });
  }

  _fx_frost(ev, c, t, color, done) {
    this._windup(c, color);
    this._after(WIND, () => {
      this._release(c, color);
      const ice = this._trail('shard', { speed: { min: 10, max: 40 }, angle: { min: 0, max: 360 }, rotate: { min: 0, max: 360 } },
        { size: [3, 6], size1: 1, life: [0.5, 0.5], colors: ['#bfe8ff', color, '#ffffff'] });
      this._fly({
        from: this._tip(c), to: this._chest(t), dur: 0.32, arc: 14, color, size: 11,
        trail: (x, y) => ice.at(x, y),
        onImpact: (x, y) => {
          ice.end();
          this._impact(ev, t, x, y, color);
          this._burst(x, y, ['#bfe8ff', color, '#ffffff'], 22, { tex: 'shard', size: [4, 8], g: 260 });
          this._ring(x, y, '#bfe8ff', { r1: 64, squash: 1 });
          this._spray(this._rect(x - 20, y - 20, 40, 40), 6, { speedX: { min: -15, max: 15 }, speedY: { min: -10, max: 10 } },
            { tex: 'smoke', size: 20, size1: 40, life: [0.9, 0.9], colors: ['#5aaed8'], alpha: 0.35 });
          this._after(0.34, done);
        },
      });
    });
  }

  _fx_meteor(ev, c, t, color, done) {
    this._windup(c, color, 0.36, { sky: true });
    const to = { x: t.x, y: GROUND - 40 };
    const from = { x: t.x + (c.x - t.x) * 0.3, y: 92 }; // drops out of a portal on the caster's side
    const portal = this._img('rune', from.x, from.y, { tint: color, scale: 0 });
    this._tween(0.9, (p) => {
      const open = p < 0.3 ? ease.outBack(p / 0.3) : 1 - Math.max(0, (p - 0.7) / 0.3);
      portal.setScale((0.75 * open) / this.dpr);
      portal.rotation += 0.05;
    }, () => portal.destroy());
    this._after(0.36, () => {
      this._release(c, color);
      const fire = this._trail('glow', { speed: { min: 10, max: 50 }, angle: { min: 0, max: 360 } },
        { size: [10, 18], size1: 2, life: [0.3, 0.55], colors: [color, '#ffb347', '#ff7a1a', '#fff0c0'] });
      const smoke = this._trail('smoke', { speedX: { min: -15, max: 15 }, speedY: { min: -15, max: 5 } },
        { size: 18, size1: 36, life: [1, 1], colors: ['#1e130b'], alpha: 0.6, blend: 'NORMAL' });
      this._fly({
        from, to, dur: 0.46, color, size: 22, easeFn: ease.inQuad,
        trail: (x, y) => { fire.at(x, y, 4); smoke.at(x, y); },
        onImpact: (x, y) => {
          fire.end(); smoke.end();
          this._impact(ev, t, x, y, color, { power: 1.4 });
          this._shockwave(x, y, 22);
          this.hitstop = Math.max(this.hitstop, 0.09);
          this._flare(x, y, '#ffb347', 70, 120, 0.4);
          this._burst(x, y, [color, '#ffb347', '#fff0c0'], 50, { speed: [120, 420], g: 300 });
          this._burst(x, GROUND, ['#2a1a0e', '#4a3220'], 18, { tex: 'dot', size: [3, 6], speed: [100, 300], g: 700, life: [0.6, 1], blend: 'NORMAL' });
          this._ring(x, GROUND + 2, color, { r1: 150, squash: 0.25, depth: DEPTH.ground });
          this._after(0.5, done);
        },
      });
    });
  }

  _boltGraphic(x0, y0, x1, y1, color, dur, { branches = 2, width = 1 } = {}) {
    const g = this._w(this.add.graphics().setBlendMode(ADD));
    const col = hex(color);
    const path = (ax, ay, bx, by, disp, depth) => {
      let pts = [[ax, ay], [bx, by]];
      for (let d = 0; d < depth; d++) {
        const next = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const [px, py] = pts[i - 1], [qx, qy] = pts[i];
          const len = Math.hypot(qx - px, qy - py) || 1;
          const off = rand(-disp, disp);
          next.push([(px + qx) / 2 + (-(qy - py) / len) * off, (py + qy) / 2 + ((qx - px) / len) * off], pts[i]);
        }
        pts = next;
        disp *= 0.55;
      }
      return pts;
    };
    const stroke = (pts, w, c, a) => {
      g.lineStyle(w, c, a).beginPath().moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
    };
    const redraw = (alpha) => {
      g.clear();
      const main = path(x0, y0, x1, y1, 46, 6);
      stroke(main, 9 * width, col, 0.25 * alpha);
      stroke(main, 4 * width, col, 0.8 * alpha);
      stroke(main, 1.6 * width, 0xffffff, alpha);
      for (let b = 0; b < branches; b++) {
        const [sx, sy] = main[(2 + Math.random() * (main.length - 4)) | 0];
        const br = path(sx, sy, sx + rand(-60, 60) + (x1 - x0) * 0.2, sy + rand(10, 70), 18, 4);
        stroke(br, 2.5 * width, col, 0.55 * alpha);
        stroke(br, 1 * width, 0xffffff, 0.8 * alpha);
      }
    };
    redraw(1);
    let acc = 0;
    this._tween(dur, (p, dt) => {
      acc += dt;
      if (acc < 0.035) return;
      acc = 0;
      redraw(1 - p * 0.6);
    }, () => g.destroy());
  }

  _fx_bolt(ev, c, t, color, done) {
    this._windup(c, color, 0.3);
    this._after(0.3, () => {
      this._release(c, color);
      const from = this._tip(c), to = this._chest(t);
      this._boltGraphic(from.x, from.y, to.x, to.y, color, 0.28);
      this._flash(0.35);
      this._after(0.05, () => {
        this._impact(ev, t, to.x, to.y, color, { power: 1.1 });
        this._burst(to.x, to.y, [color, '#ffffff', '#fff0a0'], 30, { speed: [150, 380], g: 200 });
        this._flare(to.x, to.y, '#fff0a0', 46, 80, 0.25);
        this._after(0.42, done);
      });
    });
  }

  _fx_chain(ev, c, t, color, done) {
    this._windup(c, color, 0.3);
    this._after(0.3, () => {
      this._release(c, color);
      const from = this._tip(c), to = this._chest(t);
      this._boltGraphic(from.x, from.y, to.x, to.y, color, 0.3, { branches: 1 });
      // arcs leap off the target to the ground and back up into the sky
      this._after(0.08, () => {
        this._boltGraphic(to.x, to.y, to.x - 70 * t.facing, GROUND, color, 0.22, { branches: 0, width: 0.7 });
        this._boltGraphic(to.x, to.y, to.x + 40 * t.facing, GROUND - 190, color, 0.22, { branches: 0, width: 0.7 });
      });
      this._flash(0.3);
      this._after(0.06, () => {
        this._impact(ev, t, to.x, to.y, color);
        this._burst(to.x, to.y, [color, '#ffffff'], 24, { speed: [120, 320] });
        this._after(0.44, done);
      });
    });
  }

  _fx_slash(ev, c, t, color, done) {
    this._windup(c, color, 0.22);
    const at = this._chest(t);
    const col = hex(color);
    const slash = (a0, delay) => this._after(delay, () => {
      const g = this._w(this.add.graphics().setBlendMode(ADD));
      this._tween(0.22, (p) => {
        g.clear();
        const e = ease.outCubic(Math.min(1, p * 1.6));
        if (e <= 0) return;
        for (const [w, cc, a] of [[10, col, 0.35], [4, col, 0.9], [1.5, 0xffffff, 1]]) {
          g.lineStyle(w, cc, a * (1 - p * 0.8)).beginPath().arc(at.x, at.y, 52, a0, a0 + 2.2 * e).strokePath();
        }
      }, () => g.destroy());
    });
    this._after(0.22, () => {
      this._release(c, color);
      c.offset = 16 * c.facing;
      slash(-2.4, 0);
      slash(-0.8, 0.09);
      this._after(0.17, () => {
        this._impact(ev, t, at.x, at.y, color, { power: 1.2 });
        this._burst(at.x, at.y, [color, '#ff6040', '#ffffff'], 30, { speed: [100, 340] });
        this._after(0.4, done);
      });
    });
  }

  _fx_drain(ev, c, t, color, done) {
    this._windup(c, color);
    this._after(WIND, () => {
      this._release(c, color);
      const motes = this._trail('glow', {}, { size: 4, size1: 1, life: [0.4, 0.4], colors: [color, '#d070e0', '#2a0a30'] });
      let spin = 0;
      this._fly({
        from: this._tip(c), to: this._chest(t), dur: 0.42, arc: 26, color, size: 12,
        trail: (x, y) => {
          spin += 0.6;
          motes.at(x + Math.cos(spin) * 12, y + Math.sin(spin) * 12);
          motes.at(x - Math.cos(spin) * 12, y - Math.sin(spin) * 12);
        },
        onImpact: (x, y) => {
          motes.end();
          // target takes the hit now; caster heals as the stolen life arrives
          this._impact(ev, t, x, y, color);
          this._burst(x, y, [color, '#d070e0', '#ff3050'], 18, { speed: [60, 200] });
          const home = this._chest(c);
          const wispTrail = this._trail('glow', {}, { size: 3, size1: 0.5, life: [0.3, 0.3], colors: ['#ff3050', color, '#e080ff'] });
          for (let i = 0; i < 12; i++) {
            const sx = x + rand(-14, 14), sy = y + rand(-20, 20);
            const cy = Math.min(sy, home.y) - rand(50, 110);
            const mx = lerp(sx, home.x, 0.5);
            this._after(i * 0.03, () => {
              const w = this._img('glow', sx, sy, { tint: pick(['#ff3050', color, '#e080ff']), scale: 0.22 });
              this._tween(0.45, (p) => {
                const e = ease.inOutSine(p);
                w.x = (1 - e) ** 2 * sx + 2 * (1 - e) * e * mx + e * e * home.x;
                w.y = (1 - e) ** 2 * sy + 2 * (1 - e) * e * cy + e * e * home.y;
                if (Math.random() < 0.5) wispTrail.at(w.x, w.y);
              }, () => w.destroy());
            });
          }
          this._after(0.5, () => {
            wispTrail.end();
            this._applyState(ev, [ev.actor]);
            if (ev.heal) {
              this._floater(c, '+' + ev.heal, '#4ade80', { size: 20 });
              this._burst(home.x, home.y, ['#4ade80', '#d070e0'], 14, { speed: [40, 120], g: -60 });
            }
            this._after(0.22, done);
          });
        },
      });
    });
  }

  _fx_lob(ev, c, t, color, done) {
    this._windup(c, color);
    const toxic = ev.spellId === 'plague' || ev.spellId === 'corrosion';
    const pal = toxic ? [color, '#b0d040', '#4a5a10'] : [color, '#ff8a2a', '#ffcf6a'];
    this._after(WIND, () => {
      this._release(c, color);
      const drips = this._trail('dot', { speedX: { min: -20, max: 20 }, speedY: { min: 0, max: 40 }, gravityY: 300 },
        { size: [2.5, 4.5], size1: 2, life: [0.45, 0.45], colors: pal });
      this._fly({
        from: this._tip(c), to: { x: t.x, y: GROUND - 60 }, dur: 0.5, arc: 110, color, size: 13,
        trail: (x, y) => drips.at(x, y),
        onImpact: (x, y) => {
          drips.end();
          t.burnHeat = 1;
          t.burnColor = color;
          this._impact(ev, t, x, y, color, { quiet: true });
          this._shake(0.22);
          this._burst(x, y, pal, 30, { tex: 'dot', g: 420, speed: [80, 240], size: [2.5, 5] });
          this._ring(t.x, GROUND + 2, color, { r1: 70, squash: 0.25, depth: DEPTH.ground });
          this._spray(this._rect(t.x - 30, GROUND - 20, 60, 20), 24, { speedX: { min: -15, max: 15 }, speedY: { min: -160, max: -80 } },
            { size: [6, 12], size1: 1, life: [0.4, 0.8], colors: pal });
          this._floater(t, toxic ? '☠' : '\u{1f525}', color, { size: 22 });
          this._after(0.4, done);
        },
      });
    });
  }

  _fx_rune(ev, c, t, color, done) {
    this._windup(c, color);
    this._after(WIND, () => {
      this._release(c, color);
      const from = this._tip(c), to = this._chest(t);
      const glyph = this._img('glyph', from.x, from.y, { tint: color, scale: 14 / 40 });
      const motes = this._trail('glow', {}, { size: 4, size1: 1, life: [0.4, 0.4], colors: [color] });
      this._tween(0.45, (p) => {
        const e = ease.inOutSine(p);
        glyph.setPosition(lerp(from.x, to.x, e), lerp(from.y, to.y, e) - Math.sin(Math.PI * e) * 30);
        glyph.rotation = p * 10;
        if (p > 0 && Math.random() < 0.7) motes.at(glyph.x, glyph.y);
      }, () => {
        glyph.destroy();
        motes.end();
        // the seal stamps onto the target, then the overhead marker takes over
        const seal = this._img('glyph', to.x, to.y, { tint: color });
        this._tween(0.5, (p) => {
          seal.setScale(lerp(1.8, 1, ease.outCubic(Math.min(1, p * 2))) / this.dpr);
          seal.setAlpha(p < 0.5 ? 1 : (1 - p) * 2);
          seal.rotation = -p;
        }, () => seal.destroy());
        this._impact(ev, t, to.x, to.y, color, { quiet: true });
        this._shake(0.15);
        t.silenced = true;
        if (ev.note) this._floater(t, ev.note, color, { size: 17 });
        this._after(0.45, done);
      });
    });
  }

  _fx_heal(ev, c, _t, color, done) {
    this._windup(c, color, 0.2);
    this._after(0.2, () => {
      c.castGlow = 1;
      const pillar = this._img('glow', c.x, GROUND - 90, { tint: color, alpha: 0 });
      this._tween(0.7, (p) => {
        pillar.setScale((1.3 * (1 - p * 0.4)) / this.dpr, 5.5 / this.dpr).setAlpha(Math.sin(Math.PI * p) * 0.8);
      }, () => pillar.destroy());
      this._ring(c.x, GROUND + 2, color, { r1: 80, squash: 0.28, depth: DEPTH.ground });
      this._spray(this._rect(c.x - 34, GROUND - 40, 68, 40), 30, { speedX: { min: -8, max: 8 }, speedY: { min: -140, max: -60 } },
        { size: [2, 4], life: [0.6, 1.1], colors: [color, '#b0ffc0', '#ffffff'] });
      this._after(0.18, () => {
        this._applyState(ev, [ev.actor]);
        if (ev.heal != null) this._floater(c, '+' + ev.heal, '#4ade80', { size: 22 });
        this._after(0.4, done);
      });
    });
  }

  _fx_shield(ev, c, _t, color, done) {
    this._windup(c, color, 0.2);
    this._after(0.2, () => {
      c.castGlow = 1;
      c.bubble.setTint(hex(color));
      c.bubblePop = 1;
      c.ripple = 1;
      this._ring(c.x, GROUND - 66, color, { r0: 90, r1: 50, squash: 1.4, dur: 0.3 });
      this._ring(c.x, GROUND + 2, color, { r1: 70, squash: 0.28, depth: DEPTH.ground });
      const mid = { x: c.x, y: GROUND - 66 };
      this._spray(this._circleEdge(mid.x, mid.y, 90, 20), 20, { moveToX: mid.x, moveToY: mid.y, rotate: { min: 0, max: 360 } },
        { tex: 'shard', size: [3, 5], size1: 3, life: [0.32, 0.32], colors: [color] });
      this._applyState(ev, [ev.actor]);
      if (ev.shieldGain != null) this._floater(c, `+${ev.shieldGain} ⬡`, '#7cc4f4', { size: 20 });
      if (ev.spellId === 'manabarrier') this._burst(c.x, GROUND - 10, ['#ffb347', '#5088c0'], 14, { g: -100, speed: [40, 120] });
      this._after(0.5, done);
    });
  }

  _fx_haste(ev, c, _t, color, done) {
    this._windup(c, color, 0.2);
    this._after(0.2, () => {
      c.castGlow = 1;
      for (let r = 0; r < 3; r++) {
        this._after(r * 0.1, () => {
          const g = this._img('ring', c.x, GROUND, { tint: color });
          this._tween(0.55, (p) => {
            const s = ((44 / 50) * (1 - p * 0.4)) / this.dpr;
            g.setPosition(c.x, GROUND - p * 150).setScale(s, s * 0.27).setAlpha(1 - p);
          }, () => g.destroy());
        });
      }
      this._spray(this._rect(c.x - 120 * c.facing, GROUND - 140, 1, 120), 16, { speedX: 600 * c.facing, speedY: 0, rotate: alongVelocity },
        { tex: 'spark', size: 3, size1: 3, life: [0.3, 0.3], colors: [color] });
      c.hasted = true;
      this._after(0.5, done);
    });
  }

  _mirrorPane(c, crack) {
    const x = c.x + 56 * c.facing, y = GROUND - 76;
    const g = this._img('mirror', x, y, { tint: SPELL_COLORS.mirror });
    this._tween(0.55, (p) => {
      const open = Math.min(1, p * 5) * (1 - (crack ? 0 : Math.max(0, p - 0.6) * 2.5));
      g.setScale(Math.max(0, open) / this.dpr, 1 / this.dpr).setAlpha(p < 0.7 ? 1 : (1 - p) / 0.3);
    }, () => {
      g.destroy();
      if (crack) this._burst(x, y, ['#bdb6a8', '#e8d090', '#8a8478'], 18, { tex: 'shard', g: 500, speed: [40, 160], size: [4, 7], blend: 'NORMAL' });
    });
  }

  _fx_mirror(ev, c, _t, _color, done) {
    // Only reached when Mirror fizzles (a successful Mirror plays the copied spell).
    this._mirrorPane(c, true);
    this._after(0.55, () => {
      if (ev.note) this._floater(c, ev.note, '#bdb6a8', { size: 17 });
      this._after(0.3, done);
    });
  }

  // --- ticks: burn, reflected damage, blood-pact recoil ---
  _playTick(ev, done) {
    const c = this.c[ev.actor];
    const chest = this._chest(c);
    const tickEv = { ...ev, dmg: ev.amount, target: ev.actor };
    if (ev.kind === 'burn') {
      c.burnHeat = 1;
      this._spray(this._rect(c.x - 30, GROUND - 30, 60, 30), 26, { speedX: { min: -20, max: 20 }, speedY: { min: -200, max: -90 } },
        { size: [6, 12], size1: 1, life: [0.35, 0.7], colors: [c.burnColor, '#ffb347', '#ff5a1a'] });
      this._after(0.16, () => {
        this._impact(tickEv, c, chest.x, chest.y, c.burnColor, { power: 0.6 });
        this._after(0.32, done);
      });
      return;
    }
    if (ev.kind === 'reflect') {
      const fromX = c.x + 130 * c.facing;
      this._spray(this._rect(fromX, chest.y - 30, 1, 60), 10,
        { speedX: (chest.x - fromX) / 0.2, speedY: { min: -30, max: 30 }, rotate: c.facing > 0 ? -90 : 90 },
        { tex: 'shard', size: [4, 6], size1: 4, life: [0.2, 0.2], colors: ['#9fdcff'] });
      this._after(0.2, () => {
        this._impact(tickEv, c, chest.x, chest.y, '#7fe0ff', { power: 0.7 });
        this._burst(chest.x, chest.y, ['#9fdcff', '#ffffff'], 16, { tex: 'shard', g: 300 });
        this._after(0.3, done);
      });
      return;
    }
    // recoil: blood motes implode into the caster, then burst
    this._spray(this._circleEdge(chest.x, chest.y, 55, 16), 16, { moveToX: chest.x, moveToY: chest.y },
      { size: 4, size1: 2, life: [0.22, 0.22], colors: ['#b030a0', '#ff3050'] });
    this._after(0.22, () => {
      this._impact(tickEv, c, chest.x, chest.y, '#ff5d5d', { power: 0.6 });
      this._burst(chest.x, chest.y, ['#ff3050', '#7a0a20'], 18, { tex: 'dot', g: 400, size: [2, 4], blend: 'NORMAL' });
      this._after(0.3, done);
    });
  }
}
