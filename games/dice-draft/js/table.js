// Phaser 3 table. Renders the whole play surface — the rival's board strip, the
// dice tray, your eight zones — and animates the rolls, each placement, the
// power-ups and the zone-by-zone reveal. It knows nothing about the rules: the
// controller feeds it rolls, scored placements and the finished reveal log, and it
// reports what the player touched (onSelect / onDie / onZone). Deciding what a
// touch means is the controller's job.
//
// `Table` is a thin wrapper that owns the Phaser.Game and the pointer listeners;
// everything visual lives in `TableScene`. All choreography runs on the scene
// clock (this.time / this.tweens), so skip() can fast-forward it by time scale.

import * as Phaser from 'phaser';

// Must stay in sync with the palette in css/styles.css (WebGL can't read CSS vars).
// felt = the table, line = printed linework, gold = you, rival = them.
const C = {
  felt: '#1F4BFF', feltHi: '#2F5BFF', feltDeep: '#173CD6', feltWell: '#0E2A99', depth: '#0A1F7A',
  line: '#B9C8FF', gold: '#FFD23F',
  white: '#FFFFFF', red: '#FF4D4D', rival: '#FFB3A6', hot: '#FF9A3C',
  ink: '#14204D',
};
const DISPLAY = '"Lilita One", "Arial Rounded MT Bold", sans-serif';
// Zone rules are long lines in narrow boxes, so the table keeps a condensed face
// for small text; the DOM uses Nunito.
const TEXT = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';

const hex = (c) => parseInt(c.slice(1), 16);
const hasWebGL = () => {
  try { return !!document.createElement('canvas').getContext('webgl'); } catch { return false; }
};
const rnd = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- layout ----------
// Two arrangements of the same parts: 4×2 zones on wide screens, 2×4 on phones.
export function layoutFor(portrait, zoneCount = 8, offers = 1) {
  const W = portrait ? 420 : 720;
  const H = portrait ? 750 : 640;
  const m = portrait ? 12 : 20;
  const rail = { x: m, y: portrait ? 8 : 12, w: W - 2 * m, h: portrait ? 46 : 54 };
  const sGap = portrait ? 4 : 6;
  const sW = (W - 2 * m - (zoneCount - 1) * sGap) / zoneCount;
  const sY = rail.y + rail.h + 6;
  const sH = portrait ? 58 : 72;
  const tray = { x: m, y: sY + sH + 8, w: W - 2 * m, h: portrait ? 140 : 160 };
  const cols = portrait ? 2 : 4;
  const rows = Math.ceil(zoneCount / cols);
  const gap = 8;
  const gY = tray.y + tray.h + 8;
  const zW = (W - 2 * m - (cols - 1) * gap) / cols;
  const zH = (H - gY - m - (rows - 1) * gap) / rows;
  return {
    W, H, m, portrait, rail, tray,
    die: offers > 1 ? (portrait ? 46 : 56) : (portrait ? 64 : 76), // two rolls share the tray
    strip: (i) => ({ x: m + i * (sW + sGap), y: sY, w: sW, h: sH }),
    zone: (i) => ({ x: m + (i % cols) * (zW + gap), y: gY + Math.floor(i / cols) * (zH + gap), w: zW, h: zH }),
  };
}

// ---------- textures (painted once on 2D canvases at devicePixelRatio) ----------
const PIPS = {
  1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function paintDie(ctx, s, face) {
  const r = s * 0.2;
  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(1, '#E3E9FF');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(1, 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(14,42,153,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.stroke();
  // Chinese dice: the 1 and the 4 are red, and the 1 is a single fat pip.
  ctx.fillStyle = face === 1 || face === 4 ? C.red : C.ink;
  const pr = face === 1 ? s * 0.17 : s * 0.095;
  for (const [px, py] of PIPS[face]) {
    ctx.beginPath();
    ctx.arc(s / 2 + px * s * 0.255, s / 2 + py * s * 0.255, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintFelt(ctx, L) {
  const { W, H, tray } = L;
  const g = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, Math.max(W, H) * 0.75);
  g.addColorStop(0, C.feltHi);
  g.addColorStop(0.6, C.felt);
  g.addColorStop(1, C.feltDeep);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // felt nap
  for (let i = 0; i < W * H / 26; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,60,0.05)';
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
  }
  // the dice well
  ctx.fillStyle = C.feltWell;
  ctx.beginPath();
  ctx.roundRect(tray.x, tray.y, tray.w, tray.h, 14);
  ctx.fill();
  const well = ctx.createLinearGradient(0, tray.y, 0, tray.y + tray.h);
  well.addColorStop(0, 'rgba(0,0,0,0.38)');
  well.addColorStop(0.25, 'rgba(0,0,0,0)');
  ctx.fillStyle = well;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function createTextures(scene, dpr, L) {
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
  // The hard, offset "sticker" shadow that sits under each big die.
  add('dieShadow', 96, 96, (ctx) => {
    ctx.fillStyle = '#06154F';
    ctx.beginPath();
    ctx.roundRect(1, 1, 94, 94, 19);
    ctx.fill();
  });
  add('dot', 32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  });
  add('chip', 10, 6, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 10, 6); });
  add('ring', 96, 96, (ctx) => {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(48, 48, 44, 0, Math.PI * 2);
    ctx.stroke();
  });
  add(`felt-${L.W}`, L.W, L.H, (ctx) => paintFelt(ctx, L));
}

// =====================================================================
// Table: the public API game.js uses
// =====================================================================
export class Table {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = null;
    // What the player touched: a roll (group index or 'held'), a die, a zone.
    this.onSelect = null;
    this.onDie = null;
    this.onZone = null;
    this.ready = this._boot().catch((err) => {
      console.error('Table failed to initialise', err);
      this.failed = true;
    });
    this._listen();
  }

  async _boot() {
    // Phaser text rasterises on a canvas, so the web fonts must be loaded first.
    if (document.fonts) {
      await Promise.all(['400 20px "Lilita One"', '600 13px "Barlow Semi Condensed"', '700 13px "Barlow Semi Condensed"']
        .map((f) => document.fonts.load(f))).catch(() => {});
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Layout of the pre-rendered dice sheets. Without it the table still works, with
    // painted dice that simply appear.
    this.diceMeta = await fetch('assets/dice-roll.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    await new Promise((resolve) => {
      this.game = new Phaser.Game({
        type: hasWebGL() ? Phaser.WEBGL : Phaser.CANVAS, // AUTO isn't allowed with a supplied canvas
        canvas: this.canvas,
        width: 720 * this.dpr,
        height: 640 * this.dpr,
        backgroundColor: C.feltDeep,
        banner: false,
        audio: { noAudio: true },
        // Pointer handling is done on the canvas element (see _listen): the canvas is
        // CSS-scaled, and mapping client coords ourselves is simpler than Phaser's.
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        scale: { mode: Phaser.Scale.NONE, zoom: 1 / this.dpr },
        render: { antialias: true },
        scene: [],
        callbacks: { postBoot: () => resolve() },
      });
    });
    this.game.scene.add('table', TableScene, false);
  }

  _listen() {
    const at = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const L = this.scene.L;
      return { x: ((e.clientX - r.left) / r.width) * L.W, y: ((e.clientY - r.top) / r.height) * L.H };
    };
    const on = (type, fn) => this.canvas.addEventListener(type, (e) => { if (this.scene) fn(e); });
    on('pointerdown', (e) => { this.canvas.setPointerCapture?.(e.pointerId); this.scene.pointerDown(at(e)); });
    on('pointermove', (e) => this.scene.pointerMove(at(e)));
    on('pointerup', (e) => this.scene.pointerUp(at(e)));
    on('pointercancel', () => this.scene.pointerLeave());
    on('pointerleave', () => this.scene.pointerLeave());
  }

  // (Re)start the table for a new match. opts = { variant, table, you, rival, portrait }
  start(opts) {
    this.scene = null;
    this.sceneReady = new Promise((r) => { this._sceneResolve = r; });
    const token = (this.startToken = {});
    this.ready.then(() => {
      if (this.failed || this.startToken !== token) return;
      const L = layoutFor(opts.portrait, opts.table.zones.length, opts.variant.offers);
      this.canvas.style.aspectRatio = `${L.W} / ${L.H}`;
      this.canvas.dataset.layout = opts.portrait ? 'portrait' : 'landscape';
      this.game.scale.resize(L.W * this.dpr, L.H * this.dpr);
      this.game.loop.wake();
      this.game.scene.start('table', { table: this, opts, L }); // restarts it if already running
    });
    return this.sceneReady;
  }

  _attach(scene) {
    this.scene = scene;
    this._sceneResolve();
  }

  stop() {
    this.startToken = null;
    this.scene = null;
    if (this.game) this.game.loop.sleep();
  }

  // Everything below forwards to the live scene; calls made while the scene is
  // (re)starting are simply dropped — the controller only acts after start() resolves.
  deal(offers, turn, done) { this.scene?.deal(offers, turn, done); }
  setSelection(sel) { this.scene?.setSelection(sel); }
  setFlipMode(on) { this.scene?.setFlipMode(on); }
  flip(group, die) { this.scene?.flip(group, die); }
  setHeld(roll) { this.scene?.setHeld(roll); }
  showNext(offers) { this.scene?.showNext(offers); }
  nudge(msg) { this.scene?.nudge(msg); }
  hold(group) { this.scene?.hold(group); }
  stageHeld(zone) { this.scene?.stageHeld(zone); }
  lockMine(group, landed, auto) { this.scene?.lockMine(group, landed, auto); }
  rivalLocked() { this.scene?.rivalLocked(); }
  revealRival(landed, holding) { this.scene?.revealRival(landed, holding); }
  setTimer(frac) { this.scene?.setTimer(frac); }
  reveal(result, done) { this.scene?.reveal(result, done); }
  skip() { this.scene?.setSpeed(8); }
}

// =====================================================================
// TableScene: everything visual
// =====================================================================
class TableScene extends Phaser.Scene {
  constructor() {
    super({ key: 'table' });
  }

  preload() {
    const meta = this.sys.settings.data.table.diceMeta;
    if (!meta || this.textures.exists('roll')) return;
    const sheet = (key, file, cell) => this.load.spritesheet(key, `assets/${file}`, { frameWidth: cell, frameHeight: cell });
    sheet('roll', meta.roll.file, meta.roll.cell);
    this.load.image('faces', `assets/${meta.faces.file}`);
    if (meta.flip) sheet('flip', meta.flip.file, meta.flip.cell);
    if (meta.gold) { // the golden die: the same sheets, rendered in gold
      sheet('roll-gold', meta.gold.roll, meta.roll.cell);
      this.load.image('faces-gold', `assets/${meta.gold.faces}`);
      if (meta.flip) sheet('flip-gold', meta.gold.flip, meta.flip.cell);
    }
  }

  create({ table, opts, L }) {
    this.table = table;
    this.meta = this.textures.exists('roll') && this.textures.exists('faces') ? table.diceMeta : null;
    this.opts = opts;
    this.L = L;
    this.dpr = table.dpr;
    this.variant = opts.variant;
    this.table_ = opts.table;      // the match's table: zones, hot zone, sets
    this.zones = opts.table.zones;
    this.calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    createTextures(this, this.dpr, L);
    this.cameras.main.setZoom(this.dpr).centerOn(L.W / 2, L.H / 2);

    this.live = false;     // may the player act right now?
    this.sel = null;       // the roll in hand: a group index, 'held', or null
    this.flipMode = false;
    this.hover = -1;
    this.drag = null;
    this.mine = this.zones.map(() => null); // what sits in each of my zones
    this.myTotal = 0;
    this.timerFrac = null;
    this.settleUntil = 0;
    this.setSpeed(1);

    this.add.image(0, 0, `felt-${L.W}`).setOrigin(0).setScale(1 / this.dpr);
    this._buildRail();
    this.strip = this.zones.map((z, i) => this._buildStripCell(z, i));
    this.cells = this.zones.map((z, i) => this._buildZone(z, i));
    this._buildTray();
    this.flash = this.add.rectangle(L.W / 2, L.H / 2, L.W, L.H, 0xffffff).setAlpha(0).setDepth(50);
    this._intro();
    this.table._attach(this);
  }

  // ---------- helpers ----------
  _text(x, y, str, size, color, { font = TEXT, weight = '600', origin = [0, 0], depth = 2 } = {}) {
    return this.add.text(x, y, str, { fontFamily: font, fontSize: `${size}px`, fontStyle: weight, color })
      .setResolution(this.dpr).setOrigin(origin[0], origin[1]).setDepth(depth);
  }

  _big(x, y, str, size, color, opts = {}) {
    return this._text(x, y, str, size, color, { font: DISPLAY, weight: '400', ...opts });
  }

  // The sheet to use for a die: its gold twin if the die is golden and one was rendered.
  _sheet(key, gold) { return gold && this.textures.exists(`${key}-gold`) ? `${key}-gold` : key; }

  // The texture for die face `value` at exactly `size` logical px. One is made per
  // size on first use, at device resolution, so a resting die is sampled 1:1 and
  // stays sharp. Faces come from the pre-rendered sheets (assets/dice-faces*.webp),
  // so a die at rest matches the last frame of its roll clip; paintDie() is the
  // fallback if the sheets didn't load (a golden die is then just tinted).
  _face(value, size, gold = false) {
    const px = Math.max(1, Math.round(size * this.dpr));
    const key = `face${value}${gold ? 'g' : ''}@${px}`;
    if (this.textures.exists(key)) return key;
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    if (this.meta) {
      const { cell, faceWidth } = this.meta.faces;
      const inset = (cell - faceWidth) / 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.textures.get(this._sheet('faces', gold)).getSourceImage(), (value - 1) * cell + inset, inset, faceWidth, faceWidth, 0, 0, px, px);
    } else {
      paintDie(ctx, px, value);
      if (gold) { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = C.gold; ctx.fillRect(0, 0, px, px); ctx.globalCompositeOperation = 'destination-in'; paintDie(ctx, px, value); }
    }
    this.textures.addCanvas(key, c);
    return key;
  }

  _die(key, x, y, size, depth = 3) {
    return this.add.image(x, y, key).setDisplaySize(size, size).setDepth(depth);
  }

  _after(ms, fn) { return this.time.delayedCall(ms, fn); }

  setSpeed(s) {
    this.speed = s;
    this.time.timeScale = s;
    this.tweens.timeScale = s;
  }

  _pop(obj, from = 1.8, ms = 260) {
    const sx = obj.scaleX, sy = obj.scaleY;
    obj.setScale(sx * from, sy * from).setAlpha(0);
    this.tweens.add({ targets: obj, scaleX: sx, scaleY: sy, alpha: 1, duration: ms, ease: 'Back.easeOut' });
  }

  // A quick scale punch that returns to rest: "this just changed".
  _punch(obj, amount = 1.25, ms = 110) {
    if (this.calm) return;
    this.tweens.killTweensOf(obj);
    obj.setScale(1);
    this.tweens.add({ targets: obj, scale: amount, duration: ms, yoyo: true, ease: 'Sine.easeOut' });
  }

  _countTo(text, from, to, ms = 350) {
    this._punch(text);
    this.tweens.addCounter({
      from, to, duration: ms, ease: 'Cubic.easeOut',
      onUpdate: (tw) => text.setText(String(Math.round(tw.getValue()))),
      onComplete: () => text.setText(String(to)),
    });
  }

  // Move `obj` to `to` along an arc, optionally spinning and resizing on the way.
  _arc(obj, to, { ms = 320, lift = 70, spin = 0, size = null, scale = null, delay = 0, ease = 'Cubic.easeIn', done } = {}) {
    let from = null; // read at launch, not at call time, so a delayed flight starts where the object is
    const start = () => { from = { x: obj.x, y: obj.y, a: obj.angle, s: obj.displayWidth, k: obj.scaleX }; };
    this.tweens.addCounter({
      from: 0, to: 1, duration: this.calm ? 1 : ms, delay: this.calm ? 0 : delay, ease,
      onStart: start,
      onUpdate: (tw) => {
        if (!from) start();
        const t = tw.getValue(), u = 1 - t;
        const mx = (from.x + to.x) / 2, my = Math.min(from.y, to.y) - lift;
        obj.setPosition(u * u * from.x + 2 * u * t * mx + t * t * to.x, u * u * from.y + 2 * u * t * my + t * t * to.y);
        obj.setAngle(from.a + spin * t);
        if (size != null) obj.setDisplaySize(lerp(from.s, size, t), lerp(from.s, size, t));
        if (scale != null) obj.setScale(lerp(from.k, scale, t));
      },
      onComplete: () => { if (done) done(); },
    });
  }

  _burst(x, y, n, colors, { speed = [90, 300], life = 700, gravity = 320, tex = 'dot', size = 0.5 } = {}) {
    if (this.calm) return;
    const em = this.add.particles(x, y, tex, {
      speed: { min: speed[0], max: speed[1] }, angle: { min: 0, max: 360 },
      lifespan: { min: life * 0.5, max: life }, gravityY: gravity,
      scale: { start: size / this.dpr, end: 0 }, rotate: { min: 0, max: 360 },
      tint: colors.map(hex), blendMode: tex === 'dot' ? 'ADD' : 'NORMAL', emitting: false,
    }).setDepth(40);
    em.explode(n);
    this._after(life + 200, () => em.destroy());
  }

  _ring(x, y, color, { from = 0.25, to = 1.3, ms = 380, alpha = 0.7 } = {}) {
    if (this.calm) return;
    const im = this.add.image(x, y, 'ring').setTint(hex(color)).setDepth(8).setAlpha(alpha).setScale(from / this.dpr);
    this.tweens.add({ targets: im, scale: to / this.dpr, alpha: 0, duration: ms, ease: 'Cubic.easeOut', onComplete: () => im.destroy() });
  }

  _shake(ms, amount) { if (!this.calm) this.cameras.main.shake(ms, amount); }

  // Escalating payoff: 1 = a decent hit, 2 = straight-sized, 3 = triple-sized.
  _celebrate(x, y, level, label) {
    if (level <= 0) return;
    this._burst(x, y, 10 + level * 14, [C.gold, C.white, C.line], { speed: [80, 180 + level * 90] });
    this._ring(x, y, C.gold, { to: 1 + level * 0.5 });
    if (level >= 2) {
      this._burst(x, y, 20 * level, [C.gold, C.rival, C.white], { tex: 'chip', size: 1.4, life: 1100, speed: [140, 420] });
      this._shake(140 + level * 80, 0.002 * level);
      if (label) this._callout(label, level);
    }
    if (level >= 3) {
      this.flash.setFillStyle(hex(C.gold)).setAlpha(0.55);
      this.tweens.add({ targets: this.flash, alpha: 0, duration: 520 });
    }
  }

  _callout(str, level) {
    const { tray } = this.L;
    const t = this._big(tray.x + tray.w / 2, tray.y + tray.h / 2, str, level >= 3 ? 64 : 46, C.gold, { origin: [0.5, 0.5], depth: 45 })
      .setStroke(C.feltWell, 8).setAngle(-6);
    this._pop(t, 2.4, 300);
    this.tweens.add({ targets: t, angle: 4, duration: 900, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: t, alpha: 0, y: t.y - 26, delay: 800, duration: 350, onComplete: () => t.destroy() });
  }

  // How loud a score should be: the rare zones (Straight, Triple) by their own
  // celebrate rank, everything else by the size of the number.
  _level(zone, points) {
    if (points <= 0) return 0;
    if (zone.celebrate >= 2) return zone.celebrate;
    return points >= 16 ? 2 : points >= 12 ? 1 : 0;
  }

  _shout(zone, points) { return zone.celebrate >= 2 ? `${zone.name}!` : `${points}!`; }

  // "+N" lifts off a score and flies into a running total, which then ticks up.
  _award(x, y, points, total, color, land) {
    if (points <= 0 || this.calm) { land(); return; }
    const chip = this._big(x, y, `+${points}`, 26, color, { origin: [0.5, 0.5], depth: 42 }).setStroke(C.feltWell, 6);
    this._pop(chip, 0.4, 200);
    const to = { x: total.x + (0.5 - total.originX) * total.width, y: total.y };
    this._arc(chip, to, {
      ms: 380, delay: 260, lift: 30, scale: 0.6,
      done: () => {
        chip.destroy();
        this._burst(to.x, to.y, 8, [color, C.white], { speed: [60, 180], life: 400, gravity: 0, size: 0.4 });
        land();
      },
    });
  }

  // ---------- construction ----------
  _buildRail() {
    const { rail, W, portrait } = this.L;
    const big = portrait ? 30 : 36;
    const cy = rail.y + rail.h / 2;
    this.youName = this._text(rail.x + 4, cy, this.opts.you, 15, C.white, { weight: '700', origin: [0, 0.5] });
    this.youTotal = this._big(rail.x + 12 + this.youName.width, cy, '0', big, C.gold, { origin: [0, 0.5] });
    this.rivalTotal = this._big(rail.x + rail.w - 4, cy, '', big, C.rival, { origin: [1, 0.5] });
    this.rivalName = this._text(rail.x + rail.w - 4, cy - (portrait ? 8 : 9), this.opts.rival, 15, C.white, { weight: '700', origin: [1, 0.5] });
    this.rivalStatus = this._text(rail.x + rail.w - 4, cy + (portrait ? 9 : 10), '', 13, C.line, { origin: [1, 0.5] });
    this.counter = this._text(W / 2, cy - 9, '', 14, C.white, { weight: '700', origin: [0.5, 0.5] });
    this.pips = this.add.graphics().setDepth(2);
    this._drawPips(-1);
  }

  _drawPips(turn) {
    const { W, rail } = this.L;
    const n = this.variant.rolls, gap = 13, y = rail.y + rail.h / 2 + 10;
    this.pips.clear();
    for (let i = 0; i < n; i++) {
      const x = W / 2 + (i - (n - 1) / 2) * gap;
      this.pips.fillStyle(hex(i < turn ? C.line : i === turn ? C.gold : '#000000'), i <= turn ? 1 : 0.35);
      this.pips.fillCircle(x, y, i === turn ? 4.5 : 3);
    }
  }

  rivalLocked() {
    this.rivalStatus.setText('Locked in').setColor(C.rival);
    this._punch(this.rivalStatus, 1.3, 120);
  }

  // n small dice in a row centred on (cx, cy), hidden until given a roll.
  _minis(cx, cy, size, gap, depth = 3) {
    const n = this.variant.dice;
    return Array.from({ length: n }, (_, k) => this._die(this._face(1, size), cx + (k - (n - 1) / 2) * (size + gap), cy, size, depth).setVisible(false));
  }

  _showMinis(dice, roll, size) {
    dice.forEach((d, k) => d.setTexture(this._face(roll.dice[k], size, roll.gold === k)).setVisible(true));
  }

  _buildStripCell(zone, i) {
    const r = this.L.strip(i);
    const n = this.variant.dice;
    const hot = this.table_.hot === i;
    const g = this.add.graphics().setDepth(1);
    const ds = Math.min(18, (r.w - 8 - (n - 1) * 2) / n);
    const name = this._text(r.x + r.w / 2, r.y + 6, zone.name, this.L.portrait ? 11 : 13, hot ? C.hot : C.white, { weight: '700', origin: [0.5, 0] }).setAlpha(hot ? 1 : 0.8);
    const dy = r.y + r.h - ds / 2 - (this.L.portrait ? 9 : 14);
    const dice = this._minis(r.x + r.w / 2, dy, ds, 2);
    // a Double or the hot zone shows as ×2 / ×3 over the rival's dice
    const mult = this._big(r.x + r.w - 3, r.y + r.h - 2, '', this.L.portrait ? 11 : 13, C.gold, { origin: [1, 1], depth: 4 }).setStroke(C.feltWell, 4);
    const cell = { r, g, name, dice, ds, mult, roll: null, hot: false };
    this._drawStripCell(cell);
    return cell;
  }

  _drawStripCell(cell) {
    const { r, g } = cell;
    g.clear();
    g.fillStyle(hex(C.feltWell), cell.roll ? 0.75 : 0.3);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, 6);
    g.lineStyle(cell.hot ? 2.5 : 1, hex(cell.hot ? C.rival : C.line), cell.hot ? 1 : 0.45);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, 6);
  }

  // A zone is a container centred on its box, so the whole thing can hop, press
  // and punch as one piece. Children are positioned relative to that centre.
  _buildZone(zone, i) {
    const r = this.L.zone(i);
    const p = this.L.portrait;
    const pad = 12;
    const x0 = -r.w / 2, y0 = -r.h / 2;
    const isHot = this.table_.hot === i;
    const g = this.add.graphics();
    const name = this._big(x0 + pad, y0 + (p ? 7 : 10), zone.name, p ? 21 : 22, C.white);
    const num = this._text(-x0 - pad, y0 + (p ? 10 : 13), String(i + 1), 13, C.line, { weight: '700', origin: [1, 0] }).setAlpha(0.7);
    // the hot zone wears its multiplier right after its name
    const badge = this._big(name.x + name.width + 7, name.y + (p ? 4 : 5), isHot ? '×2' : '', 17, C.hot);
    const rule = this._text(x0 + pad, y0 + (p ? 35 : 42), zone.rule, 14, C.white).setAlpha(0.82);
    const hint = this._text(x0 + pad, y0 + (p ? 53 : 61), zone.hint, 14, C.gold, { weight: '700' });
    const ds = p ? 24 : 26;
    const baseY = -y0 - pad - ds / 2 + 2;
    const dice = this._minis(x0 + pad + ds * 1.5 + 3, baseY, ds, 3);
    // In the corner: the points banked there, and above them what boosted them.
    const points = this._big(-x0 - pad, baseY, '', p ? 30 : 34, C.white, { origin: [1, 0.5] });
    const tags = this._text(-x0 - pad, baseY - (p ? 22 : 25), '', 12, C.line, { weight: '700', origin: [1, 1] });
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const c = this.add.container(cx, cy, [g, name, num, badge, rule, hint, ...dice, points, tags]).setDepth(1);
    const cell = { zone, r, c, cx, cy, g, name, num, badge, rule, hint, dice, ds, points, tags, isHot, hot: false };
    this._drawZone(cell, i);
    return cell;
  }

  // Open zones stand proud on a hard shadow; a filled zone sits pressed in. The hot
  // zone is ringed in orange; a zone lit for selection or the reveal in yellow.
  _drawZone(cell, i) {
    const { r, g } = cell;
    const filled = !!this.mine[i];
    const open = !filled && this.live;
    const lit = cell.hot || (open && this.hover === i);
    const x = -r.w / 2, y = -r.h / 2;
    const sink = filled && !cell.hot ? 3 : 0;
    g.clear();
    g.fillStyle(hex(C.depth), 0.9);
    g.fillRoundedRect(x, y + 5, r.w, r.h, 10);
    g.fillStyle(hex(lit ? C.feltHi : filled ? C.feltWell : C.feltDeep), lit ? 1 : filled ? 0.92 : 0.85);
    g.fillRoundedRect(x, y + sink, r.w, r.h, 10);
    const edge = lit ? C.gold : cell.isHot ? C.hot : C.line;
    g.lineStyle(lit ? 3 : cell.isHot ? 2.5 : 2, hex(edge), filled && !lit ? (cell.isHot ? 0.55 : 0.3) : lit ? 1 : 0.85);
    g.strokeRoundedRect(x, y + sink, r.w, r.h, 10);
    for (const t of [cell.name, cell.rule, cell.hint]) t.setAlpha(filled && !cell.hot ? 0.5 : t === cell.rule ? 0.82 : 1);
    if (!this.tweens.isTweening(cell.c)) cell.c.y = cell.cy - (open && this.hover === i ? 3 : 0);
  }

  _redrawZones() { this.cells.forEach((c, i) => this._drawZone(c, i)); }

  // The tray holds one group of big dice per roll on offer, plus two small slots:
  // the roll set aside with Hold (top left) and the rolls shown by Peek (top right).
  _buildTray() {
    const { tray, die, portrait } = this.L;
    const n = this.variant.dice;
    const offers = this.variant.offers;
    const snap = (v) => Math.round(v * this.dpr) / this.dpr; // a die parked on a half pixel is blurred
    const cy = snap(tray.y + tray.h / 2 - (offers > 1 ? -3 : 12)); // two rolls sit lower, clear of the corner slots
    const step = die + (offers > 1 ? 8 : 14);
    this.groups = Array.from({ length: offers }, (_, gi) => {
      const cx = tray.x + tray.w * (offers > 1 ? (gi === 0 ? 0.27 : 0.73) : 0.5);
      const home = Array.from({ length: n }, (_, k) => ({ x: snap(cx + (k - (n - 1) / 2) * step), y: cy }));
      const w = step * n + 6, h = die + 22;
      return {
        home, cx, box: { x: cx - w / 2, y: cy - h / 2 + 2, w, h },
        frame: this.add.graphics().setDepth(8),
        shadows: home.map((p) => this.add.image(p.x, p.y, 'dieShadow').setDepth(9).setVisible(false)),
        dice: home.map((p) => this._die(this._face(1, die), p.x, p.y, die, 10).setVisible(false)),
        // While a die is in the air it is one of these, playing a pre-rendered clip
        // (the roll, or a Flip); the resting sprite takes over on the clip's last frame.
        rollers: this.meta ? home.map(() => this.add.sprite(0, 0, 'roll').setDepth(11).setVisible(false)) : null,
        flying: home.map(() => false),
        offer: null, values: [], gone: true,
      };
    });
    if (offers > 1) this.or = this._text(tray.x + tray.w / 2, cy, 'or', 15, C.line, { weight: '700', origin: [0.5, 0.5] }).setAlpha(0);

    const ms = portrait ? 18 : 20; // small dice in the two corner slots
    const slotW = n * (ms + 2) + 10;
    const hx = tray.x + 12 + slotW / 2, sy = tray.y + 19 + ms / 2;
    this.heldSlot = {
      box: { x: tray.x + 6, y: tray.y + 3, w: slotW + 12, h: ms + 22 },
      label: this._text(hx, tray.y + 4, 'Held', 12, C.gold, { weight: '700', origin: [0.5, 0] }).setVisible(false),
      dice: this._minis(hx, sy, ms, 2, 12), size: ms, roll: null, frame: this.add.graphics().setDepth(8),
    };
    const nx = tray.x + tray.w - 12 - (offers * slotW + (offers - 1) * 6) / 2;
    this.nextSlot = {
      label: this._text(nx, tray.y + 4, 'Next', 12, C.line, { weight: '700', origin: [0.5, 0] }).setVisible(false),
      rows: Array.from({ length: offers }, (_, gi) => this._minis(nx + (gi - (offers - 1) / 2) * (slotW + 6), sy, ms, 2, 12)), size: ms,
    };
    this.status = this._text(tray.x + tray.w / 2, tray.y + tray.h - 22, '', 15, C.white, { origin: [0.5, 0.5] }).setAlpha(0.9);
    this.timer = this.add.graphics().setDepth(2);
    this.alarm = this.add.graphics().setDepth(2);
  }

  // The table assembles itself: zones drop in one by one, the rival strip fades up.
  _intro() {
    if (this.calm) return;
    this.cells.forEach((cell, i) => {
      cell.c.setAlpha(0).setScale(0.86);
      cell.c.y = cell.cy + 34;
      this.tweens.add({ targets: cell.c, y: cell.cy, alpha: 1, scale: 1, delay: 60 + i * 45, duration: 300, ease: 'Back.easeOut' });
    });
    this.strip.forEach((cell, i) => {
      for (const o of [cell.g, cell.name]) {
        const a = o.alpha;
        o.setAlpha(0);
        this.tweens.add({ targets: o, alpha: a, delay: i * 35, duration: 220 });
      }
    });
  }

  setTimer(frac) {
    this.timerFrac = frac;
    const { tray } = this.L;
    const w = tray.w - 28, x = tray.x + 14, y = tray.y + tray.h - 8;
    this.timer.clear();
    if (frac == null) { this.alarm.clear(); return; }
    this.timer.fillStyle(0x000000, 0.35).fillRoundedRect(x, y, w, 4, 2);
    this.timer.fillStyle(hex(frac < 0.25 ? C.red : C.gold), 1).fillRoundedRect(x, y, Math.max(4, w * frac), 4, 2);
  }

  // Per-frame life: shadows track their dice, and the last quarter of the timer
  // makes the tray pulse red and the dice rattle.
  update() {
    const { die, tray } = this.L;
    const now = this.time.now;
    const urgent = this.live && this.timerFrac != null && this.timerFrac < 0.25;
    const still = this.live && !this.calm && now > this.settleUntil;
    this.groups.forEach((grp, gi) => {
      grp.dice.forEach((d, k) => {
        if (grp.flying[k]) return; // a clip is driving this die and its shadow
        if (still && this.drag?.moved !== gi && !grp.gone) {
          // Waiting dice sit still, square and on whole pixels. (An idle bob was tried
          // and dropped.) They only move when time is nearly up.
          const h = grp.home[k];
          d.setPosition(h.x + (urgent ? Math.sin(now / 28 + k * 2 + gi) * 1.6 : 0), h.y).setAngle(urgent ? Math.sin(now / 36 + k + gi) * 4 : 0);
        }
        const lifted = d.depth > 10; // dragged or flying to a zone
        const s = d.displayWidth;
        grp.shadows[k].setVisible(d.visible && s > die * 0.5)
          .setPosition(d.x + (lifted ? 4 : 0), d.y + (lifted ? 14 : 6) * (s / die))
          .setAngle(d.angle).setDisplaySize(s, d.displayHeight).setAlpha((lifted ? 0.55 : 1) * d.alpha);
      });
    });
    this.alarm.clear();
    if (urgent && !this.calm) {
      const a = 0.35 + 0.35 * Math.sin(now / 90);
      this.alarm.lineStyle(3, hex(C.red), a).strokeRoundedRect(tray.x + 1.5, tray.y + 1.5, tray.w - 3, tray.h - 3, 13);
    }
  }

  // ---------- a turn ----------
  // Throw this turn's rolls into the tray, then open the table.
  deal(offers, turn, done) {
    const { die } = this.L;
    this.live = false;
    this.sel = null;
    this.flipMode = false;
    this.counter.setText(`Roll ${turn + 1} of ${this.variant.rolls}`);
    this._punch(this.counter, 1.3, 130);
    this._drawPips(turn);
    this.rivalStatus.setText('Thinking…').setColor(C.line);
    this.status.setText('');
    this.setTimer(null);
    this.showNext(null);
    const n = this.variant.dice;
    const thrown = !this.calm && !!this.meta;
    const flight = thrown ? 880 : 0;
    this.groups.forEach((grp, gi) => {
      grp.offer = offers[gi];
      grp.values = offers[gi].dice.slice();
      grp.gone = false;
      grp.frame.clear();
      grp.dice.forEach((d, k) => {
        const h = grp.home[k];
        this.tweens.killTweensOf(d);
        d.setDisplaySize(die, die).setAlpha(1).setDepth(10).setAngle(0).setPosition(h.x, h.y)
          .setTexture(this._face(grp.values[k], die, grp.offer.gold === k));
        if (!thrown) { d.setVisible(true); return; }
        this._throw(grp, k, flight, (gi * n + k) * 90);
      });
    });
    if (this.or) this.or.setAlpha(0);
    const settled = flight + (thrown ? (offers.length * n - 1) * 90 + 220 : 0);
    this._after(settled, () => {
      this.live = true;
      this.settleUntil = 0;
      if (this.or) this.tweens.add({ targets: this.or, alpha: 0.8, duration: 200 });
      this._prompt();
      this._redrawZones();
      if (done) done();
    });
  }

  // What the tray asks of the player right now.
  _prompt() {
    if (!this.live) return;
    const pick = this.variant.offers > 1;
    this.status.setText(this.flipMode ? 'Tap the die you want to flip'
      : this.sel == null && pick ? 'Pick a roll, then tap a zone'
        : this.sel === 'held' ? 'Tap a zone for the roll you held'
          : this.L.portrait || pick ? 'Tap a zone to place this roll' : 'Tap a zone to place this roll, or press its number');
  }

  // One die, thrown in from the right. The tumble itself is a pre-rendered clip
  // (one clip per final value, rotation only, ending flat on that value); this
  // moves it across the tray, bounces it and casts its shadow.
  _throw(grp, k, ms, delay) {
    const { die, tray } = this.L;
    const { framesPerClip, cell, faceWidth } = this.meta.roll;
    const h = grp.home[k], d = grp.dice[k], roller = grp.rollers[k], shadow = grp.shadows[k];
    const value = grp.values[k];
    const size = die * (cell / faceWidth); // the cell is bigger than the die face it holds
    // each die leaves the hand a beat after the last, on its own line
    const from = { x: tray.x + tray.w + die, y: h.y + (k - (grp.dice.length - 1) / 2) * 30 + rnd(-10, 10) };
    const apex = die * rnd(0.7, 0.95);
    const touchdowns = [0.42, 0.72, 0.9];
    let hits = 0;
    // height of the throw: a fall, then two smaller hops
    const air = (t) => {
      if (t < 0.42) return 1 - (t / 0.42) ** 2;
      if (t < 0.72) { const p = (t - 0.42) / 0.3; return 0.34 * 4 * p * (1 - p); }
      if (t < 0.9) { const p = (t - 0.72) / 0.18; return 0.1 * 4 * p * (1 - p); }
      return 0;
    };
    d.setVisible(false);
    shadow.setVisible(false);
    grp.flying[k] = true;
    roller.setTexture(this._sheet('roll', grp.offer.gold === k));
    this.tweens.addCounter({
      from: 0, to: 1, duration: ms, delay,
      onUpdate: (tw) => {
        const t = tw.getValue();
        const m = Math.min(1, t / 0.9);
        const along = 1 - (1 - m) ** 2;
        const x = lerp(from.x, h.x, along), y = lerp(from.y, h.y, along);
        const z = air(t) * apex;
        const grow = 1 + z / 520;
        roller.setVisible(true).setFrame((value - 1) * framesPerClip + Math.min(framesPerClip - 1, Math.floor(m * framesPerClip)))
          .setPosition(x, y - z * 0.3).setDisplaySize(size * grow, size * grow);
        const spread = 1 + z / 500;
        shadow.setVisible(true).setPosition(x + z * 0.1, y + 6 + z * 0.08).setDisplaySize(die * spread, die * spread)
          .setAngle(0).setAlpha(Math.max(0.25, 1 - z / 150));
        while (hits < touchdowns.length && t >= touchdowns[hits]) {
          const power = [1, 0.5, 0.2][hits++];
          this._burst(x, y + die * 0.4, Math.round(6 * power) + 2, [C.line, C.white], { speed: [40, 60 + 110 * power], life: 320, gravity: 0, size: 0.34 });
          if (power === 1) this._ring(x, y + die * 0.3, C.line, { to: 1.1, ms: 320, alpha: 0.5 });
        }
      },
      onComplete: () => {
        roller.setVisible(false);
        grp.flying[k] = false;
        d.setVisible(true);
      },
    });
  }

  // ---------- what the controller tells the table ----------
  // Which roll the player has in hand: a group index, 'held', or null.
  setSelection(sel) {
    this.sel = sel;
    this.groups.forEach((grp, gi) => {
      const { box } = grp;
      const on = sel === gi;
      grp.frame.clear();
      if (grp.gone) return;
      if (on) grp.frame.lineStyle(3, hex(C.gold), 1).strokeRoundedRect(box.x, box.y, box.w, box.h, 14);
      grp.dice.forEach((d) => d.setAlpha(sel == null || on || sel === 'held' ? 1 : 0.45));
    });
    this._drawHeld();
    this._prompt();
  }

  // Flip mode: the next die tapped gets turned over.
  setFlipMode(on) {
    this.flipMode = on;
    if (on && !this.calm) {
      this.groups.forEach((grp) => { if (!grp.gone) grp.dice.forEach((d, k) => this.tweens.add({ targets: d, angle: 8, duration: 70, yoyo: true, repeat: 1, delay: k * 40 })); });
      this.settleUntil = this.time.now + 400;
    }
    this._prompt();
  }

  // Turn one die over (or back): plays the pre-rendered flip, which starts on the
  // current face and lands on its opposite.
  flip(gi, k) {
    const grp = this.groups[gi];
    const { die } = this.L;
    const d = grp.dice[k];
    const from = grp.values[k];
    const gold = grp.offer.gold === k;
    grp.values[k] = 7 - from;
    d.setTexture(this._face(7 - from, die, gold));
    const clip = this.meta?.flip;
    if (!clip || this.calm) { this._punch(d, 1.2, 90); return; }
    const roller = grp.rollers[k];
    const size = die * (clip.cell / clip.faceWidth);
    grp.flying[k] = true;
    d.setVisible(false);
    roller.setTexture(this._sheet('flip', gold)).setPosition(grp.home[k].x, grp.home[k].y).setDisplaySize(size, size).setVisible(true);
    this.tweens.addCounter({
      from: 0, to: clip.framesPerClip - 1, duration: clip.durationMs,
      onUpdate: (tw) => roller.setFrame((from - 1) * clip.framesPerClip + Math.round(tw.getValue())),
      onComplete: () => {
        roller.setVisible(false);
        grp.flying[k] = false;
        d.setVisible(true);
        this._ring(grp.home[k].x, grp.home[k].y, C.gold, { to: 1.2, ms: 300 });
      },
    });
  }

  // The roll set aside with Hold, shown small in the tray's top-left corner.
  setHeld(roll) {
    this.heldSlot.roll = roll;
    this.heldSlot.label.setVisible(!!roll);
    if (roll) this._showMinis(this.heldSlot.dice, roll, this.heldSlot.size);
    else this.heldSlot.dice.forEach((d) => d.setVisible(false));
    this._drawHeld();
  }

  _drawHeld() {
    const { box, frame, roll } = this.heldSlot;
    frame.clear();
    if (!roll) return;
    frame.fillStyle(hex(C.depth), 0.55).fillRoundedRect(box.x, box.y, box.w, box.h, 8);
    frame.lineStyle(this.sel === 'held' ? 3 : 1.5, hex(C.gold), this.sel === 'held' ? 1 : 0.6).strokeRoundedRect(box.x, box.y, box.w, box.h, 8);
  }

  // The rolls Peek revealed, shown small in the tray's top-right corner.
  showNext(offers) {
    const s = this.nextSlot;
    s.label.setVisible(!!offers);
    s.rows.forEach((dice, gi) => {
      if (!offers) { dice.forEach((d) => d.setVisible(false)); return; }
      this._showMinis(dice, offers[gi], s.size);
      if (!this.calm) dice.forEach((d, k) => this._pop(d, 1.8, 180 + k * 40));
    });
  }

  nudge(msg) {
    this.status.setText(msg);
    this._punch(this.status, 1.2, 100);
    if (!this.calm) this.groups.forEach((grp) => { if (!grp.gone) this.tweens.add({ targets: grp.frame, alpha: 0.4, duration: 80, yoyo: true }); });
  }

  // Hold: the chosen roll shrinks into the held slot; the other one leaves.
  hold(gi) {
    this.live = false;
    this.setTimer(null);
    this.status.setText(`Held for later. Waiting for ${this.opts.rival}…`);
    const grp = this.groups[gi];
    const roll = { dice: grp.values.slice(), gold: grp.offer.gold };
    grp.frame.clear();
    grp.gone = true;
    grp.dice.forEach((d, k) => {
      const to = this.heldSlot.dice[k];
      this.tweens.killTweensOf(d);
      d.setDepth(31);
      this._arc(d, { x: to.x, y: to.y }, {
        ms: 280, delay: k * 40, lift: 30, size: this.heldSlot.size,
        done: () => { d.setVisible(false).setDepth(10); if (k === grp.dice.length - 1) this.setHeld(roll); },
      });
    });
    this._dismissOthers(gi);
  }

  // The rolls not taken slide out of the tray.
  _dismissOthers(taken) {
    if (this.or) this.or.setAlpha(0);
    this.groups.forEach((grp, gi) => {
      if (gi === taken || grp.gone) return;
      grp.gone = true;
      grp.frame.clear();
      grp.dice.forEach((d) => {
        this.tweens.killTweensOf(d);
        this.tweens.add({ targets: d, alpha: 0, y: d.y + 18, duration: this.calm ? 1 : 220, onComplete: () => d.setVisible(false) });
      });
    });
  }

  // The held roll goes into a zone now; its points show when the turn locks.
  stageHeld(i) {
    const cell = this.cells[i];
    const slot = this.heldSlot;
    const roll = slot.roll;
    this.mine[i] = roll;
    slot.dice.forEach((d, k) => {
      const to = cell.dice[k];
      const ghost = this._die(d.texture.key, d.x, d.y, slot.size, 31);
      d.setVisible(false);
      this._arc(ghost, { x: cell.cx + to.x, y: cell.cy + to.y }, {
        ms: 280, delay: k * 40, lift: 40, size: cell.ds,
        done: () => { ghost.destroy(); to.setTexture(this._face(roll.dice[k], cell.ds, roll.gold === k)).setVisible(true); if (!this.calm) this._pop(to, 1.5, 140); },
      });
    });
    this.setHeld(null);
    this._redrawZones();
  }

  // The match layer accepted my turn. `landed` is what went where, in order (a held
  // roll first). The roll in hand flies into its zone; then each placement shows
  // its points and what boosted them, and pays into my total.
  lockMine(gi, landed, auto) {
    this.live = false;
    this.hover = -1;
    this.setTimer(null);
    this.status.setText(auto ? 'Out of time — the roll was placed for you' : `Locked in. Waiting for ${this.opts.rival}…`);
    const grp = this.groups[gi];
    const n = this.variant.dice;
    grp.frame.clear();
    grp.gone = true;
    this._dismissOthers(gi);
    const current = landed[landed.length - 1].heldFrom == null ? landed[landed.length - 1] : landed.find((e) => e.heldFrom == null);
    for (const e of landed) {
      if (e !== current && !this.mine[e.zone]) this.stageHeld(e.zone); // a held roll dropped in on the last turn
      this.mine[e.zone] = e;
    }
    this._redrawZones();
    const cell = this.cells[current.zone];
    grp.dice.forEach((d, k) => {
      const to = cell.dice[k];
      this.tweens.killTweensOf(d);
      d.setDepth(31).setAlpha(1);
      this._arc(d, { x: cell.cx + to.x, y: cell.cy + to.y }, {
        ms: 300, delay: k * 50, lift: 60, spin: 360 * (k % 2 ? -1 : 1) - d.angle, size: cell.ds,
        done: () => {
          d.setVisible(false).setDepth(10);
          to.setTexture(this._face(current.dice[k], cell.ds, current.gold === k)).setVisible(true);
          if (!this.calm) this._pop(to, 1.5, 140);
          if (k === n - 1) landed.forEach((e, idx) => this._after(idx * 520, () => this._landed(this.cells[e.zone], e)));
        },
      });
    });
  }

  // What boosted a placement, as a short line: "+4 gold  ×2  +3 streak".
  _tagsFor(e) {
    const tags = [];
    if (e.goldPts) tags.push(`+${e.goldPts} gold`);
    if (e.mult > 1) tags.push(`×${e.mult}`);
    if (e.streakBonus) tags.push(`+${e.streakBonus} streak`);
    return tags.join('  ');
  }

  _landed(cell, e) {
    const from = this.myTotal;
    const points = e.total;
    this.myTotal += points + e.sweep;
    const px = cell.cx + cell.points.x - 18, py = cell.cy + cell.points.y;
    cell.points.setText(String(points)).setScale(1).setColor(points ? C.gold : C.white).setAlpha(points ? 1 : 0.4);
    cell.tags.setText(this._tagsFor(e));
    if (points) this._pop(cell.points, 1.9); // a blank stays dim: no fanfare for a zero
    if (!this.calm) {
      // the zone takes the weight: press down and spring back; a blank gets a head-shake
      this.tweens.add({ targets: cell.c, scale: 0.94, duration: 70, yoyo: true, ease: 'Sine.easeOut' });
      if (!points) this.tweens.add({ targets: cell.c, x: cell.cx + 5, duration: 45, yoyo: true, repeat: 2, onComplete: () => { cell.c.x = cell.cx; } });
    }
    // a Double or a hot hit is louder than the zone alone would be
    const level = Math.max(this._level(cell.zone, e.base), e.base > 0 && e.mult > 1 ? e.mult - 1 : 0);
    this._celebrate(px, py, level, e.mult > 1 && cell.zone.celebrate < 2 ? `×${e.mult}!` : this._shout(cell.zone, points));
    this._award(px, py - 6, points, this.youTotal, C.gold, () => this._countTo(this.youTotal, from, from + points));
    if (e.sweep) {
      this._after(420, () => {
        this._callout(`Sweep +${e.sweep}`, 2);
        this._shake(160, 0.003);
        this.table_.sets[cell.zone.set].forEach((z, k) => this.tweens.add({ targets: this.cells[z].c, y: this.cells[z].cy - 10, delay: k * 60, duration: 120, yoyo: true }));
        this._award(px, py - 6, e.sweep, this.youTotal, C.gold, () => this._countTo(this.youTotal, from + points, from + points + e.sweep));
      });
    }
  }

  // Both players are in for the turn: the rival's dice fly from the tray to their
  // strip, where everyone can see what they chose. `holding` if they set a roll aside.
  revealRival(landed, holding) {
    const { die } = this.L;
    const mid = this.L.tray.x + this.L.tray.w / 2, y0 = this.L.tray.y + this.L.tray.h / 2;
    this.rivalStatus.setText(holding ? 'Holding a roll' : '').setColor(C.rival);
    landed.forEach((e, idx) => {
      const cell = this.strip[e.zone];
      this._after(idx * 200, () => {
        cell.roll = e;
        cell.hot = true;
        this._drawStripCell(cell);
        cell.mult.setText(e.mult > 1 ? `×${e.mult}` : '');
        cell.dice.forEach((d, k) => {
          const key = this._face(e.dice[k], cell.ds, e.gold === k);
          d.setTexture(key);
          if (this.calm) { d.setVisible(true); return; }
          const ghost = this._die(key, mid + (k - 1) * die * 0.6, y0, die * 0.5, 30).setAlpha(0.9);
          this._arc(ghost, { x: d.x, y: d.y }, {
            ms: 260, delay: k * 45, lift: 24, spin: 180, size: cell.ds,
            done: () => { ghost.destroy(); d.setVisible(true); this._pop(d, 1.7, 150); },
          });
        });
        this._after(650, () => { cell.hot = false; this._drawStripCell(cell); });
      });
    });
  }

  // ---------- pointer (logical coordinates, fed by Table._listen) ----------
  zoneAt({ x, y }) {
    return this.cells.findIndex(({ r }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  _canPlace(i) { return this.live && i >= 0 && i < this.cells.length && !this.mine[i]; }

  // What is under the pointer in the tray: a roll group (and which die), or the held slot.
  _trayAt(p) {
    const inBox = (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    if (this.heldSlot.roll && inBox(this.heldSlot.box)) return { held: true };
    for (let gi = 0; gi < this.groups.length; gi++) {
      const grp = this.groups[gi];
      if (grp.gone || !inBox(grp.box)) continue;
      let die = 0;
      grp.home.forEach((h, k) => { if (Math.abs(p.x - h.x) < Math.abs(p.x - grp.home[die].x)) die = k; });
      return { group: gi, die };
    }
    return null;
  }

  pointerDown(p) {
    if (!this.live) return;
    this.drag = { start: p, at: this._trayAt(p), moved: null, zone: this.zoneAt(p) };
  }

  pointerMove(p) {
    const d = this.drag;
    if (d?.at && d.at.group != null && this.live && !this.flipMode) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 6) d.moved = d.at.group;
      if (d.moved != null) {
        const grp = this.groups[d.moved];
        grp.frame.clear();
        grp.dice.forEach((die, k) => die.setPosition(grp.home[k].x + p.x - d.start.x, grp.home[k].y + p.y - d.start.y).setAngle((k - 1) * 5).setDepth(30).setAlpha(1));
      }
    }
    const over = this._canPlace(this.zoneAt(p)) ? this.zoneAt(p) : -1;
    const hand = over >= 0 || (this.live && !!this._trayAt(p));
    if (over !== this.hover) { this.hover = over; this._redrawZones(); }
    this.table.canvas.style.cursor = hand ? 'pointer' : '';
  }

  _snapHome(gi) {
    const grp = this.groups[gi];
    this.settleUntil = this.time.now + 240;
    grp.dice.forEach((die, k) => {
      die.setDepth(10);
      this.tweens.add({ targets: die, x: grp.home[k].x, y: grp.home[k].y, angle: 0, duration: 200, ease: 'Back.easeOut' });
    });
    this._after(210, () => this.setSelection(this.sel));
  }

  pointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.live) return;
    const over = this.zoneAt(p);
    const t = this.table;
    if (d.moved != null) { // a roll dragged out of the tray: dropping it on an open zone picks and places it
      if (this._canPlace(over)) { t.onSelect?.(d.moved); if (this.live) t.onZone?.(over); }
      if (this.live) this._snapHome(d.moved);
      return;
    }
    if (d.at?.held) { t.onSelect?.('held'); return; }
    if (d.at) { t.onDie?.(d.at.group, d.at.die); return; }
    if (over >= 0 && over === d.zone && this._canPlace(over)) t.onZone?.(over); // a tap: down and up on the same zone
  }

  pointerLeave() {
    if (this.drag?.moved != null && this.live) this._snapHome(this.drag.moved);
    this.drag = null;
    if (this.hover !== -1) { this.hover = -1; this.table.canvas.style.cursor = ''; this._redrawZones(); }
  }

  // ---------- the reveal ----------
  // Step by step in table order: both rolls slide in, the scores spin up, the points
  // (and any bounty) fly to the totals and a tug-of-war bar shows who is ahead.
  // After each set's last zone comes its sweep. The last zone takes its time.
  // Calls done() after the final banner.
  reveal(result, done) {
    const { tray, portrait, rail } = this.L;
    const cx = tray.x + tray.w / 2;
    this.live = false;
    this.setTimer(null);
    this.setHeld(null);
    this.showNext(null);
    this.status.setText('');
    this.rivalStatus.setText('');
    if (this.or) this.or.setAlpha(0);
    this.rivalName.setY(rail.y + rail.h / 2).setX(rail.x + rail.w - 12 - (portrait ? 58 : 72));
    this.counter.setText('The reveal');
    this._punch(this.counter, 1.4, 160);
    this.pips.clear();
    this.groups.forEach((grp) => { grp.frame.clear(); grp.dice.forEach((d) => d.setVisible(false)); });
    this.youTotal.setText('0');
    this.rivalTotal.setText('0');
    this.cells.forEach((c) => { c.points.setAlpha(0.25); c.tags.setAlpha(0.25); });

    const ds = portrait ? 34 : 40;
    const side = portrait ? 108 : 190; // distance of each player's column from centre
    const top = tray.y + 16;
    const title = this._big(cx, top, '', portrait ? 24 : 28, C.white, { origin: [0.5, 0] });
    const col = (sign, color, total) => ({
      sign, color, total,
      dice: this._minis(cx + sign * side, top + 26, ds, 4, 12),
      pts: this._big(cx + sign * side, top + 76, '', portrait ? 44 : 52, color, { origin: [0.5, 0.5], depth: 12 }),
      note: this._text(cx + sign * side, top + 76 + (portrait ? 30 : 34), '', 12, C.line, { weight: '700', origin: [0.5, 0.5], depth: 12 }),
    });
    const a = col(-1, C.gold, this.youTotal), b = col(1, C.rival, this.rivalTotal);
    const barW = Math.min(300, tray.w - 40), barY = tray.y + tray.h - 12;
    const lead = this._text(cx, top + (portrait ? 50 : 58), '', 14, C.white, { weight: '700', origin: [0.5, 0.5] });
    const bar = this.add.graphics().setDepth(2);
    const tug = { v: 0 }; // -1 rival far ahead … +1 you far ahead
    const drawBar = () => {
      bar.clear();
      bar.fillStyle(0x000000, 0.4).fillRoundedRect(cx - barW / 2, barY, barW, 8, 4);
      const w = (barW / 2) * Math.min(1, Math.abs(tug.v));
      bar.fillStyle(hex(tug.v >= 0 ? C.gold : C.rival), 1);
      if (w > 0.5) bar.fillRect(tug.v >= 0 ? cx - w : cx, barY, w, 8); // grows towards the leader's side
      bar.fillStyle(hex(C.white), 1).fillRect(cx - 1.5, barY - 3, 3, 14);
    };
    drawBar();
    this.revealParts = [title, lead, bar, a.pts, b.pts, a.note, b.note, ...a.dice, ...b.dice];
    const swing = Math.max(30, (result.totalA + result.totalB) / 8); // a lead this big fills the bar

    const steps = result.steps;
    const lastZone = steps.reduce((k, s, i) => (s.type === 'zone' ? i : k), 0);
    const step = (i) => {
      if (i >= steps.length) { this._after(350, () => this._finale(result, done)); return; }
      const s = steps[i];
      const prev = i ? steps[i - 1] : { totalA: 0, totalB: 0 };
      const isZone = s.type === 'zone';
      const beat = i === lastZone ? 700 : 400; // hold the last one
      const sides = isZone
        ? [[a, s.a.entry, s.a.points, s.a.bounty, s.winner === 'a'], [b, s.b.entry, s.b.points, s.b.bounty, s.winner === 'b']]
        : [[a, null, s.a, 0, s.a > s.b], [b, null, s.b, 0, s.b > s.a]];
      const drawn = isZone ? s.winner === 'draw' : s.a === s.b;
      const lit = isZone ? [s.index] : this.table_.sets[s.set];
      this.cells.forEach((c, k) => { c.hot = lit.includes(k); this._drawZone(c, k); });
      this.strip.forEach((c, k) => { c.hot = lit.includes(k); this._drawStripCell(c); });
      for (const k of lit) {
        this.cells[k].points.setAlpha(1);
        this.cells[k].tags.setAlpha(1);
        if (!this.calm) this.tweens.add({ targets: this.cells[k].c, scale: 1.05, duration: 120, yoyo: true, ease: 'Sine.easeOut' });
      }
      title.setText(isZone ? s.name : `Sweep, zones ${lit[0] + 1}–${lit[lit.length - 1] + 1}`).setColor(isZone && s.hot ? C.hot : C.white);
      this._pop(title, 1.4, 180);

      // both rolls slide in from their own side
      for (const [colm, entry] of sides) {
        this.tweens.killTweensOf(colm.pts);
        colm.pts.setText('').setScale(1).setAlpha(1);
        colm.note.setText('');
        colm.dice.forEach((d, k) => {
          this.tweens.killTweensOf(d);
          d.setVisible(!!entry).setAlpha(1).setAngle(0);
          if (!entry) return;
          const x = cx + colm.sign * side + (k - (colm.dice.length - 1) / 2) * (ds + 4);
          d.setTexture(this._face(entry.dice[k], ds, entry.gold === k)).setX(x);
          if (this.calm) return;
          d.setX(x + colm.sign * 70).setAlpha(0).setAngle(colm.sign * 40);
          this.tweens.add({ targets: d, x, alpha: 1, angle: 0, delay: k * 50, duration: 240, ease: 'Back.easeOut' });
        });
      }

      // the scores spin up like a slot reel, then the winner lands harder
      this._after(beat, () => {
        for (const [colm, entry, points, bounty, won] of sides) {
          this.tweens.addCounter({
            from: 0, to: points, duration: this.calm || !points ? 1 : 260, ease: 'Cubic.easeOut',
            onUpdate: (tw) => colm.pts.setText(String(Math.round(tw.getValue()))),
            onComplete: () => {
              colm.pts.setText(isZone || points ? String(points) : '–');
              colm.note.setText([entry ? this._tagsFor(entry) : '', bounty ? `+${bounty} bounty` : ''].filter(Boolean).join('  '));
              const lost = !won && !drawn;
              if (this.calm) { colm.pts.setAlpha(lost ? 0.45 : 1); return; }
              this.tweens.add({ targets: colm.pts, scale: won ? 1.5 : 1.15, duration: 110, yoyo: !won, ease: 'Sine.easeOut' });
              if (won) {
                this.tweens.add({ targets: colm.pts, scale: 1.2, delay: 110, duration: 200, ease: 'Back.easeOut' });
                this._ring(colm.pts.x, colm.pts.y, colm.color, { to: 1.5 });
              }
              if (lost) this.tweens.add({ targets: colm.pts, alpha: 0.45, scale: 0.85, delay: 230, duration: 160 });
            },
          });
        }
        const hit = sides[0][2] >= sides[1][2] ? sides[0] : sides[1];
        const level = !isZone ? 2 : Math.max(this._level(this.zones[s.index], hit[1]?.base || 0), hit[1]?.base > 0 && hit[1].mult > 1 ? hit[1].mult - 1 : 0);
        const shout = !isZone ? `Sweep +${hit[2]}` : hit[1] && hit[1].mult > 1 && this.zones[s.index].celebrate < 2 ? `×${hit[1].mult}!` : this._shout(this.zones[s.index], hit[2]);
        this._after(270, () => this._celebrate(hit[0].pts.x, hit[0].pts.y, level, shout));
      });

      // the points fly to the totals; the bar and the lead line follow
      this._after(beat + 430, () => {
        this._award(a.pts.x, a.pts.y - 30, s.totalA - prev.totalA, a.total, a.color, () => this._countTo(a.total, prev.totalA, s.totalA));
        this._award(b.pts.x, b.pts.y - 30, s.totalB - prev.totalB, b.total, b.color, () => this._countTo(b.total, prev.totalB, s.totalB));
        const diff = s.totalA - s.totalB;
        const before = prev.totalA - prev.totalB;
        this.tweens.add({ targets: tug, v: Math.max(-1, Math.min(1, diff / swing)), delay: 300, duration: 380, ease: 'Back.easeOut', onUpdate: drawBar });
        this._after(300, () => {
          lead.setText(diff > 0 ? `${this.opts.you} lead by ${diff}` : diff < 0 ? `${this.opts.rival} leads by ${-diff}` : 'Level');
          lead.setColor(diff > 0 ? C.gold : diff < 0 ? C.rival : C.white);
          // the lead changing hands is the moment worth shouting about
          if (before * diff < 0) { this._punch(lead, 1.7, 160); this._shake(120, 0.003); }
        });
      });
      this._after(beat + 430 + 820, () => step(i + 1));
    };
    this._after(450, () => step(0));
  }

  _finale(result, done) {
    const { tray, W, H } = this.L;
    const cx = tray.x + tray.w / 2, cy = tray.y + tray.h / 2;
    this.cells.forEach((c, k) => { c.hot = false; this._drawZone(c, k); });
    this.strip.forEach((c) => { c.hot = false; this._drawStripCell(c); });
    for (const p of this.revealParts) { this.tweens.killTweensOf(p); this.tweens.add({ targets: p, alpha: 0, duration: 200 }); }
    const won = result.result === 'a', lost = result.result === 'b';
    const banner = this._big(cx, cy - 8, won ? 'You win' : lost ? `${this.opts.rival} wins` : 'Draw', this.L.portrait ? 50 : 64,
      won ? C.gold : lost ? C.rival : C.white, { origin: [0.5, 0.5], depth: 45 }).setStroke(C.feltWell, 8);
    const sub = this._text(cx, cy + 40, result.tiebreak
      ? `Level on ${result.totalA} — decided on zones won, ${result.zonesWonA} to ${result.zonesWonB}`
      : `${result.totalA} to ${result.totalB}`, 17, C.white, { weight: '700', origin: [0.5, 0.5], depth: 45 });
    this._pop(banner, 2.6, 380);
    this._pop(sub, 1.2, 380);
    if (won || lost) this._punch(won ? this.youTotal : this.rivalTotal, 1.5, 200);
    if (won) {
      for (let k = 0; k < 4; k++) {
        this._after(k * 160, () => this._burst(rnd(W * 0.15, W * 0.85), rnd(H * 0.1, H * 0.35), 46,
          [C.gold, C.white, C.rival, C.line], { tex: 'chip', size: 1.5, life: 1700, speed: [120, 460], gravity: 420 }));
      }
      this._celebrate(cx, cy, 3);
      // a victory wave runs through the zones
      if (!this.calm) {
        this.cells.forEach((c, k) => this.tweens.add({ targets: c.c, y: c.cy - 12, delay: 200 + k * 60, duration: 140, yoyo: true, ease: 'Sine.easeOut' }));
      }
    } else if (lost) {
      this._shake(260, 0.004);
    }
    this._after(2000, () => { if (done) done(); });
  }
}
