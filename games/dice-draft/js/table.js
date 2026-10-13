// Phaser 3 table. Renders the whole play surface — the rival's board strip, the
// dice tray, your eight zones — and animates the roll, each placement and the
// zone-by-zone reveal. It knows nothing about the rules: the controller feeds it
// rolls, placements and the finished reveal log, and it reports taps via onPlace.
//
// `Table` is a thin wrapper that owns the Phaser.Game and the pointer listeners;
// everything visual lives in `TableScene`. All choreography runs on the scene
// clock (this.time / this.tweens), so skip() can fast-forward it by time scale.

import * as Phaser from 'phaser';

// Must stay in sync with the palette in css/styles.css (WebGL can't read CSS vars).
const C = {
  felt: '#0F4F43', feltDeep: '#0A3A32', feltWell: '#082E28',
  brass: '#C9A24A', brassBright: '#F2CF72',
  ivory: '#F3EAD3', cinnabar: '#D63A2F', cinnabarLight: '#FF7A66',
  ink: '#1E1A17',
};
const DISPLAY = '"Abril Fatface", Georgia, serif';
const TEXT = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';

const hex = (c) => parseInt(c.slice(1), 16);
const hasWebGL = () => {
  try { return !!document.createElement('canvas').getContext('webgl'); } catch { return false; }
};
const rnd = (a, b) => a + Math.random() * (b - a);

// ---------- layout ----------
// Two arrangements of the same parts: 4×2 zones on wide screens, 2×4 on phones.
export function layoutFor(portrait, zoneCount = 8) {
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
    die: portrait ? 64 : 76,
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
  g.addColorStop(0, '#FFFAEC');
  g.addColorStop(1, '#E2D3AE');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(1, 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,70,30,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.stroke();
  // Chinese dice: the 1 and the 4 are red, and the 1 is a single fat pip.
  ctx.fillStyle = face === 1 || face === 4 ? '#C8281E' : C.ink;
  const pr = face === 1 ? s * 0.17 : s * 0.095;
  for (const [px, py] of PIPS[face]) {
    ctx.beginPath();
    ctx.arc(s / 2 + px * s * 0.255, s / 2 + py * s * 0.255, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintFelt(ctx, L) {
  const { W, H, m, tray } = L;
  const g = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, Math.max(W, H) * 0.75);
  g.addColorStop(0, '#14614F');
  g.addColorStop(0.6, C.felt);
  g.addColorStop(1, C.feltDeep);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // felt nap
  for (let i = 0; i < W * H / 26; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.05)';
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
  ctx.strokeStyle = 'rgba(201,162,74,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // brass inlay around the whole table
  ctx.strokeStyle = 'rgba(201,162,74,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(m / 2, m / 3, W - m, H - m / 1.5, 12);
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
  for (let f = 1; f <= 6; f++) {
    add(`die${f}`, 96, 96, (ctx) => paintDie(ctx, 96, f));
    add(`mini${f}`, 32, 32, (ctx) => paintDie(ctx, 32, f)); // separate small paint: crisper than a 4× downscale
  }
  add('dot', 32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  });
  add('chip', 10, 6, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 10, 6); });
  add('shadow', 96, 40, (ctx) => {
    ctx.scale(1, 40 / 96);
    const g = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);
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
    this.onPlace = null; // (zoneIndex) => void, fired when the player commits a roll
    this.ready = this._boot().catch((err) => {
      console.error('Table failed to initialise', err);
      this.failed = true;
    });
    this._listen();
  }

  async _boot() {
    // Phaser text rasterises on a canvas, so the web fonts must be loaded first.
    if (document.fonts) {
      await Promise.all(['400 20px "Abril Fatface"', '500 13px "Barlow Semi Condensed"', '600 13px "Barlow Semi Condensed"']
        .map((f) => document.fonts.load(f))).catch(() => {});
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
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

  // (Re)start the table for a new match. opts = { variant, you, rival, portrait }
  start(opts) {
    this.scene = null;
    this.sceneReady = new Promise((r) => { this._sceneResolve = r; });
    const token = (this.startToken = {});
    this.ready.then(() => {
      if (this.failed || this.startToken !== token) return;
      const L = layoutFor(opts.portrait, opts.variant.zones.length);
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
  deal(roll, turn, done) { this.scene?.deal(roll, turn, done); }
  tryPlace(zone) { this.scene?.tryPlace(zone); }
  lockMine(zone, points, auto) { this.scene?.lockMine(zone, points, auto); }
  rivalLocked() { this.scene?.setRivalStatus('Locked in'); }
  revealRival(zone, roll) { this.scene?.revealRival(zone, roll); }
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

  create({ table, opts, L }) {
    this.table = table;
    this.opts = opts;
    this.L = L;
    this.dpr = table.dpr;
    this.variant = opts.variant;
    this.calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    createTextures(this, this.dpr, L);
    this.cameras.main.setZoom(this.dpr).centerOn(L.W / 2, L.H / 2);

    this.roll = null;      // the roll waiting to be placed
    this.live = false;     // may the player place right now?
    this.hover = -1;
    this.drag = null;
    this.mine = this.variant.zones.map(() => null);
    this.myTotal = 0;
    this.timerFrac = 1;
    this.setSpeed(1);

    this.add.image(0, 0, `felt-${L.W}`).setOrigin(0).setScale(1 / this.dpr);
    this._buildRail();
    this.strip = this.variant.zones.map((z, i) => this._buildStripCell(z, i));
    this.cells = this.variant.zones.map((z, i) => this._buildZone(z, i));
    this._buildTray();
    this.flash = this.add.rectangle(L.W / 2, L.H / 2, L.W, L.H, 0xffffff).setAlpha(0).setDepth(50);
    this.table._attach(this);
  }

  // ---------- helpers ----------
  _text(x, y, str, size, color, { font = TEXT, weight = '500', origin = [0, 0], depth = 2 } = {}) {
    return this.add.text(x, y, str, { fontFamily: font, fontSize: `${size}px`, fontStyle: weight, color })
      .setResolution(this.dpr).setOrigin(origin[0], origin[1]).setDepth(depth);
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

  _countTo(text, from, to, ms = 350) {
    this.tweens.addCounter({
      from, to, duration: ms, ease: 'Cubic.easeOut',
      onUpdate: (tw) => text.setText(String(Math.round(tw.getValue()))),
      onComplete: () => text.setText(String(to)),
    });
    this.tweens.add({ targets: text, scale: 1.25, duration: 110, yoyo: true });
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

  // Escalating payoff: 1 = a decent hit, 2 = straight-sized, 3 = triple-sized.
  _celebrate(x, y, level, label) {
    if (level <= 0) return;
    this._burst(x, y, 10 + level * 14, [C.brassBright, C.ivory, C.brass], { speed: [80, 180 + level * 90] });
    if (level >= 2) {
      this._burst(x, y, 20 * level, [C.brassBright, C.cinnabarLight, C.ivory], { tex: 'chip', size: 1.4, life: 1100, speed: [140, 420] });
      if (!this.calm) this.cameras.main.shake(140 + level * 80, 0.002 * level);
      if (label) this._callout(label, level);
    }
    if (level >= 3) {
      this.flash.setFillStyle(hex(C.brassBright)).setAlpha(0.55);
      this.tweens.add({ targets: this.flash, alpha: 0, duration: 520 });
    }
  }

  _callout(str, level) {
    const { tray } = this.L;
    const t = this._text(tray.x + tray.w / 2, tray.y + tray.h / 2, str, level >= 3 ? 64 : 46, C.brassBright,
      { font: DISPLAY, weight: '400', origin: [0.5, 0.5], depth: 45 }).setStroke('#3a1208', 8);
    this._pop(t, 2.4, 300);
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

  // ---------- construction ----------
  _buildRail() {
    const { rail, W, portrait } = this.L;
    const big = portrait ? 30 : 36;
    const cy = rail.y + rail.h / 2;
    this.youName = this._text(rail.x + 4, cy, this.opts.you, 15, C.ivory, { weight: '600', origin: [0, 0.5] });
    this.youTotal = this._text(rail.x + 12 + this.youName.width, cy, '0', big, C.brassBright, { font: DISPLAY, weight: '400', origin: [0, 0.5] });
    this.rivalTotal = this._text(rail.x + rail.w - 4, cy, '', big, C.cinnabarLight, { font: DISPLAY, weight: '400', origin: [1, 0.5] });
    this.rivalName = this._text(rail.x + rail.w - 4, cy - (portrait ? 8 : 9), this.opts.rival, 15, C.ivory, { weight: '600', origin: [1, 0.5] });
    this.rivalStatus = this._text(rail.x + rail.w - 4, cy + (portrait ? 9 : 10), '', 13, C.brass, { origin: [1, 0.5] });
    this.counter = this._text(W / 2, cy - 9, '', 14, C.ivory, { weight: '600', origin: [0.5, 0.5] });
    this.pips = this.add.graphics().setDepth(2);
    this._drawPips(-1);
  }

  _drawPips(turn) {
    const { W, rail } = this.L;
    const n = this.variant.rolls, gap = 13, y = rail.y + rail.h / 2 + 10;
    this.pips.clear();
    for (let i = 0; i < n; i++) {
      const x = W / 2 + (i - (n - 1) / 2) * gap;
      this.pips.fillStyle(hex(i < turn ? C.brass : i === turn ? C.brassBright : '#000000'), i <= turn ? 1 : 0.35);
      this.pips.fillCircle(x, y, i === turn ? 4.5 : 3);
    }
  }

  setRivalStatus(str) { this.rivalStatus.setText(str); }

  _buildStripCell(zone, i) {
    const r = this.L.strip(i);
    const n = this.variant.dice;
    const g = this.add.graphics().setDepth(1);
    const ds = Math.min(18, (r.w - 8 - (n - 1) * 2) / n);
    const name = this._text(r.x + r.w / 2, r.y + 6, zone.name, this.L.portrait ? 11 : 13, C.ivory, { weight: '600', origin: [0.5, 0] }).setAlpha(0.8);
    const dice = Array.from({ length: n }, (_, k) =>
      this._die('mini1', r.x + r.w / 2 + (k - (n - 1) / 2) * (ds + 2), r.y + r.h - ds / 2 - (this.L.portrait ? 9 : 14), ds).setVisible(false));
    const cell = { r, g, name, dice, ds, roll: null, hot: false };
    this._drawStripCell(cell);
    return cell;
  }

  _drawStripCell(cell) {
    const { r, g } = cell;
    g.clear();
    g.fillStyle(0x000000, cell.roll ? 0.28 : 0.12);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, 5);
    g.lineStyle(cell.hot ? 2 : 1, hex(cell.hot ? C.cinnabarLight : C.brass), cell.hot ? 1 : 0.4);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, 5);
  }

  _buildZone(zone, i) {
    const r = this.L.zone(i);
    const n = this.variant.dice;
    const p = this.L.portrait;
    const g = this.add.graphics().setDepth(1);
    const pad = 12;
    const name = this._text(r.x + pad, r.y + (p ? 7 : 10), zone.name, p ? 21 : 22, C.ivory, { font: DISPLAY, weight: '400' });
    const num = this._text(r.x + r.w - pad, r.y + (p ? 10 : 13), String(i + 1), 13, C.brass, { weight: '600', origin: [1, 0] }).setAlpha(0.7);
    const rule = this._text(r.x + pad, r.y + (p ? 35 : 42), zone.rule, 14, C.ivory, {}).setAlpha(0.82);
    const hint = this._text(r.x + pad, r.y + (p ? 53 : 61), zone.hint, 14, C.brassBright, { weight: '600' });
    const ds = p ? 24 : 26;
    const baseY = r.y + r.h - pad - ds / 2 + 2;
    const dice = Array.from({ length: n }, (_, k) => this._die('mini1', r.x + pad + ds / 2 + k * (ds + 3), baseY, ds).setVisible(false));
    // One number in the corner: the live preview while open, the banked points once filled.
    const points = this._text(r.x + r.w - pad, baseY, '', p ? 30 : 34, C.ivory, { font: DISPLAY, weight: '400', origin: [1, 0.5] });
    const cell = { zone, r, g, name, num, rule, hint, dice, ds, points, hot: false };
    this._drawZone(cell, i);
    return cell;
  }

  _drawZone(cell, i) {
    const { r, g } = cell;
    const filled = !!this.mine[i];
    const open = !filled && this.live;
    const lit = cell.hot || (open && this.hover === i);
    g.clear();
    g.fillStyle(0x000000, filled ? 0.3 : lit ? 0.02 : 0.1);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, 8);
    if (lit) { g.fillStyle(hex(C.brassBright), 0.1); g.fillRoundedRect(r.x, r.y, r.w, r.h, 8); }
    g.lineStyle(lit ? 2.5 : 1.5, hex(lit ? C.brassBright : C.brass), filled && !cell.hot ? 0.35 : lit ? 1 : 0.8);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, 8);
    for (const t of [cell.name, cell.rule, cell.hint]) t.setAlpha(filled && !cell.hot ? 0.5 : t === cell.rule ? 0.82 : 1);
  }

  _redrawZones() { this.cells.forEach((c, i) => this._drawZone(c, i)); }

  // Open zones show what the roll on the table would score there.
  _showPreviews() {
    this.cells.forEach((cell, i) => {
      if (this.mine[i]) return;
      if (!this.roll || !this.live) { cell.points.setText(''); return; }
      const pts = cell.zone.score(this.roll);
      cell.points.setText(`+${pts}`).setColor(C.ivory).setAlpha(pts ? 0.95 : 0.3);
    });
  }

  _buildTray() {
    const { tray, die } = this.L;
    const n = this.variant.dice;
    const cy = tray.y + tray.h / 2 - 12;
    this.home = Array.from({ length: n }, (_, k) => ({ x: tray.x + tray.w / 2 + (k - (n - 1) / 2) * (die + 14), y: cy }));
    this.shadows = this.home.map((h) => this.add.image(h.x, h.y + die * 0.52, 'shadow').setDisplaySize(die * 1.15, die * 0.4).setDepth(9).setVisible(false));
    this.dice = this.home.map((h) => this._die('die1', h.x, h.y, die, 10).setVisible(false));
    this.status = this._text(tray.x + tray.w / 2, tray.y + tray.h - 22, '', 15, C.ivory, { origin: [0.5, 0.5] }).setAlpha(0.85);
    this.timer = this.add.graphics().setDepth(2);
  }

  setTimer(frac) {
    this.timerFrac = frac;
    const { tray } = this.L;
    const w = tray.w - 28, x = tray.x + 14, y = tray.y + tray.h - 8;
    this.timer.clear();
    if (frac == null) return;
    this.timer.fillStyle(0x000000, 0.35).fillRoundedRect(x, y, w, 3, 1.5);
    this.timer.fillStyle(hex(frac < 0.25 ? C.cinnabarLight : C.brass), 1).fillRoundedRect(x, y, Math.max(3, w * frac), 3, 1.5);
  }

  // ---------- a turn ----------
  // Tumble the dice into the tray, then open the table for placement.
  deal(roll, turn, done) {
    const { die, tray } = this.L;
    this.roll = roll;
    this.live = false;
    this.counter.setText(`Roll ${turn + 1} of ${this.variant.rolls}`);
    this._drawPips(turn);
    this.setRivalStatus('Thinking…');
    this.status.setText('');
    this.setTimer(null);
    this._showPreviews();
    const settle = this.calm ? 0 : 420;
    this.dice.forEach((d, k) => {
      const h = this.home[k];
      this.tweens.killTweensOf(d);
      d.setVisible(true).setDisplaySize(die, die).setAlpha(1).setDepth(10);
      this.shadows[k].setVisible(true).setAlpha(0);
      if (this.calm) { d.setTexture(`die${roll[k]}`).setPosition(h.x, h.y).setAngle(0); this.shadows[k].setAlpha(1); return; }
      const land = settle + k * 130;
      d.setPosition(h.x + rnd(-60, 60), tray.y - die).setAngle(rnd(-200, 200));
      const flick = this.time.addEvent({ delay: 55, loop: true, callback: () => d.setTexture(`die${1 + Math.floor(Math.random() * 6)}`) });
      this.tweens.add({ targets: d, x: h.x, y: h.y, angle: 0, duration: land, ease: 'Bounce.easeOut' });
      this.tweens.add({ targets: this.shadows[k], alpha: 1, duration: land });
      this._after(land, () => {
        flick.remove();
        d.setTexture(`die${roll[k]}`);
        const s = d.scaleX;
        this.tweens.add({ targets: d, scaleX: s * 1.14, scaleY: s * 1.14, duration: 70, yoyo: true });
      });
    });
    this._after(settle + (this.variant.dice - 1) * 130 + (this.calm ? 0 : 140), () => {
      this.live = true;
      this.status.setText(this.L.portrait ? 'Tap a zone to place this roll' : 'Tap a zone to place this roll, or press its number');
      this._showPreviews();
      this._redrawZones();
      if (done) done();
    });
  }

  zoneAt({ x, y }) {
    return this.cells.findIndex(({ r }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  _canPlace(i) { return this.live && i >= 0 && i < this.cells.length && !this.mine[i]; }

  tryPlace(i) {
    if (!this._canPlace(i)) return;
    this.live = false; // one placement per roll; the controller confirms via lockMine()
    this.table.onPlace?.(i);
  }

  // ---------- pointer (logical coordinates, fed by Table._listen) ----------
  pointerDown(p) {
    if (!this.live) return;
    const { die } = this.L;
    const onDice = this.home.some((h) => Math.abs(p.x - h.x) < die * 0.6 && Math.abs(p.y - h.y) < die * 0.6);
    this.drag = { start: p, onDice, moved: false, zone: this.zoneAt(p) };
  }

  pointerMove(p) {
    const d = this.drag;
    if (d && d.onDice && this.live) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 6) d.moved = true;
      if (d.moved) this.dice.forEach((die, k) => die.setPosition(this.home[k].x + p.x - d.start.x, this.home[k].y + p.y - d.start.y).setDepth(30));
    }
    const over = this._canPlace(this.zoneAt(p)) ? this.zoneAt(p) : -1;
    if (over !== this.hover) {
      this.hover = over;
      this.table.canvas.style.cursor = over >= 0 ? 'pointer' : '';
      this._redrawZones();
    }
  }

  pointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.live) return;
    const over = this.zoneAt(p);
    if (d.onDice && d.moved) {
      if (this._canPlace(over)) { this.tryPlace(over); return; }
      this.dice.forEach((die, k) => this.tweens.add({ targets: die, x: this.home[k].x, y: this.home[k].y, duration: 180, ease: 'Back.easeOut' }));
      return;
    }
    if (over >= 0 && over === d.zone) this.tryPlace(over); // a tap: down and up on the same zone
  }

  pointerLeave() {
    if (this.drag?.moved && this.live) this.dice.forEach((die, k) => die.setPosition(this.home[k].x, this.home[k].y));
    this.drag = null;
    if (this.hover !== -1) { this.hover = -1; this.table.canvas.style.cursor = ''; this._redrawZones(); }
  }

  // The match layer accepted my placement: fly the dice into the zone and bank the points.
  lockMine(i, points, auto) {
    const cell = this.cells[i];
    const roll = this.roll;
    this.live = false;
    this.hover = -1;
    this.mine[i] = roll;
    this.setTimer(null);
    this.status.setText(auto ? 'Out of time — the roll was placed for you' : `Locked in. Waiting for ${this.opts.rival}…`);
    this._showPreviews();
    this.cells.forEach((c, k) => { if (!this.mine[k]) c.points.setText(''); });
    this._redrawZones();
    this.shadows.forEach((s) => s.setVisible(false));
    const ms = this.calm ? 0 : 260;
    this.dice.forEach((d, k) => {
      const to = cell.dice[k];
      this.tweens.add({
        targets: d, x: to.x, y: to.y, displayWidth: cell.ds, displayHeight: cell.ds, duration: ms, delay: k * 35, ease: 'Cubic.easeIn',
        onComplete: () => { d.setVisible(false); to.setTexture(`mini${roll[k]}`).setVisible(true); },
      });
    });
    this._after(ms + 90, () => {
      cell.points.setText(String(points)).setColor(points ? C.brassBright : C.ivory).setAlpha(points ? 1 : 0.4);
      this._pop(cell.points, 1.9);
      this._countTo(this.youTotal, this.myTotal, this.myTotal + points);
      this.myTotal += points;
      const level = this._level(cell.zone, points);
      this._celebrate(cell.points.x - 20, cell.points.y, level, this._shout(cell.zone, points));
    });
  }

  // Both players are in for the turn: the rival's placement becomes visible.
  revealRival(i, roll) {
    const cell = this.strip[i];
    cell.roll = roll;
    this._drawStripCell(cell);
    this.setRivalStatus('');
    cell.dice.forEach((d, k) => {
      d.setTexture(`mini${roll[k]}`).setVisible(true);
      if (!this.calm) this._pop(d, 2.2, 200 + k * 40);
    });
  }

  // ---------- the reveal ----------
  // Zone by zone in table order: both rolls, both scores, running totals and a
  // tug-of-war bar that shows who is ahead. Calls done() after the final banner.
  reveal(result, done) {
    const { tray, portrait } = this.L;
    const cx = tray.x + tray.w / 2;
    this.live = false;
    this.setTimer(null);
    this.status.setText('');
    this.setRivalStatus('');
    this.rivalName.setY(this.L.rail.y + this.L.rail.h / 2).setX(this.L.rail.x + this.L.rail.w - 12 - (portrait ? 44 : 54));
    this.counter.setText('The reveal');
    this.pips.clear();
    this.dice.forEach((d) => d.setVisible(false));
    this.shadows.forEach((s) => s.setVisible(false));
    this.youTotal.setText('0');
    this.rivalTotal.setText('0');
    this.cells.forEach((c) => c.points.setAlpha(0.25));

    const n = this.variant.dice;
    const ds = portrait ? 34 : 40;
    const side = portrait ? 108 : 190; // distance of each player's column from centre
    const top = tray.y + 16;
    const title = this._text(cx, top, '', portrait ? 24 : 28, C.ivory, { font: DISPLAY, weight: '400', origin: [0.5, 0] });
    const col = (sign, color) => ({
      dice: Array.from({ length: n }, (_, k) => this._die('mini1', cx + sign * side + (k - (n - 1) / 2) * (ds + 4), top + 26, ds, 12).setVisible(false)),
      pts: this._text(cx + sign * side, top + 76, '', portrait ? 44 : 52, color, { font: DISPLAY, weight: '400', origin: [0.5, 0.5], depth: 12 }),
    });
    const a = col(-1, C.brassBright), b = col(1, C.cinnabarLight);
    const barW = Math.min(300, tray.w - 40), barY = tray.y + tray.h - 16;
    const lead = this._text(cx, barY - 16, '', 15, C.ivory, { weight: '600', origin: [0.5, 0.5] });
    const bar = this.add.graphics().setDepth(2);
    const tug = { v: 0 }; // -1 rival far ahead … +1 you far ahead
    const drawBar = () => {
      bar.clear();
      bar.fillStyle(0x000000, 0.4).fillRoundedRect(cx - barW / 2, barY, barW, 6, 3);
      const w = (barW / 2) * Math.abs(tug.v);
      bar.fillStyle(hex(tug.v >= 0 ? C.brassBright : C.cinnabarLight), 1);
      if (w > 0.5) bar.fillRect(tug.v >= 0 ? cx - w : cx, barY, w, 6); // grows towards the leader's side
      bar.fillStyle(hex(C.ivory), 1).fillRect(cx - 1, barY - 3, 2, 12);
    };
    drawBar();

    const beat = 430;
    const step = (i) => {
      if (i >= result.zones.length) { this._after(350, () => this._finale(result, done)); return; }
      const z = result.zones[i];
      const zone = this.variant.zones[i];
      const prev = i ? result.zones[i - 1] : { totalA: 0, totalB: 0 };
      this.cells.forEach((c, k) => { c.hot = k === i; this._drawZone(c, k); });
      this.strip.forEach((c, k) => { c.hot = k === i; this._drawStripCell(c); });
      this.cells[i].points.setAlpha(1);
      title.setText(zone.name);
      this._pop(title, 1.3, 180);
      for (const [colm, side_] of [[a, z.a], [b, z.b]]) {
        colm.pts.setText('');
        colm.dice.forEach((d, k) => {
          d.setVisible(!!side_.roll);
          if (side_.roll) { d.setTexture(`mini${side_.roll[k]}`); if (!this.calm) this._pop(d, 1.6, 160 + k * 40); }
        });
      }
      this._after(beat, () => {
        for (const [colm, side_, won] of [[a, z.a, z.winner === 'a'], [b, z.b, z.winner === 'b']]) {
          colm.pts.setText(String(side_.points)).setAlpha(1);
          this._pop(colm.pts, won ? 2.6 : 1.5, won ? 300 : 200);
          this._after(300, () => colm.pts.setAlpha(won || z.winner === 'draw' ? 1 : 0.45));
        }
        const top = Math.max(z.a.points, z.b.points);
        const hit = z.a.points >= z.b.points ? a : b;
        this._celebrate(hit.pts.x, hit.pts.y, this._level(zone, top), this._shout(zone, top));
      });
      this._after(beat * 2, () => {
        this._countTo(this.youTotal, prev.totalA, z.totalA);
        this._countTo(this.rivalTotal, prev.totalB, z.totalB);
        const diff = z.totalA - z.totalB;
        this.tweens.add({ targets: tug, v: Math.max(-1, Math.min(1, diff / 30)), duration: 300, ease: 'Cubic.easeOut', onUpdate: drawBar });
        lead.setText(diff > 0 ? `${this.opts.you} lead by ${diff}` : diff < 0 ? `${this.opts.rival} leads by ${-diff}` : 'Level');
        lead.setColor(diff > 0 ? C.brassBright : diff < 0 ? C.cinnabarLight : C.ivory);
      });
      this._after(beat * 3 + 250, () => step(i + 1));
    };
    this._after(500, () => step(0));
    this.revealParts = [title, lead, bar, a.pts, b.pts, ...a.dice, ...b.dice];
  }

  _finale(result, done) {
    const { tray, W, H } = this.L;
    const cx = tray.x + tray.w / 2, cy = tray.y + tray.h / 2;
    this.cells.forEach((c, k) => { c.hot = false; this._drawZone(c, k); });
    this.strip.forEach((c) => { c.hot = false; this._drawStripCell(c); });
    for (const p of this.revealParts) this.tweens.add({ targets: p, alpha: 0, duration: 200 });
    const won = result.result === 'a', lost = result.result === 'b';
    const banner = this._text(cx, cy - 8, won ? 'You win' : lost ? `${this.opts.rival} wins` : 'Draw', this.L.portrait ? 50 : 64,
      won ? C.brassBright : lost ? C.cinnabarLight : C.ivory, { font: DISPLAY, weight: '400', origin: [0.5, 0.5], depth: 45 }).setStroke('#0a2a24', 8);
    const sub = this._text(cx, cy + 40, result.tiebreak
      ? `Level on ${result.totalA} — decided on zones won, ${result.zonesWonA} to ${result.zonesWonB}`
      : `${result.totalA} to ${result.totalB}`, 17, C.ivory, { weight: '600', origin: [0.5, 0.5], depth: 45 });
    this._pop(banner, 2.6, 380);
    this._pop(sub, 1.2, 380);
    if (won) {
      for (let k = 0; k < 4; k++) {
        this._after(k * 160, () => this._burst(rnd(W * 0.15, W * 0.85), rnd(H * 0.1, H * 0.35), 46,
          [C.brassBright, C.ivory, C.cinnabarLight, '#5FD3A6'], { tex: 'chip', size: 1.5, life: 1700, speed: [120, 460], gravity: 420 }));
      }
      this._celebrate(cx, cy, 3);
    }
    this._after(1900, () => { if (done) done(); });
  }
}
