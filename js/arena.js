// Canvas 2D duel arena. It consumes the combat engine's typed event stream and
// animates two casters trading spells: projectiles, bolts, impacts, particles,
// screen shake, floating damage numbers, and on-canvas HP/shield bars.
//
// Playback is event-driven: the controller calls step() to play the next event;
// the arena reports back via the onSettled callback once that event has resolved,
// which lets manual stepping and auto-play share the same path.

const W = 720;
const H = 380;
const GROUND = 292;
const BAR_Y = 150;

const SPELL_COLORS = {
  fireball: '#ff8a2f', meteor: '#ff5326', frostbolt: '#5fd0ff', lightning: '#ffe066',
  drain: '#c779ff', soulsiphon: '#b15bff', embergrasp: '#ff5c3c', plague: '#9fd84a',
  heal: '#4ade80', bolster: '#86f7b0', shield: '#5fd0ff', wardstone: '#74b4ff',
  chainlightning: '#a98cff', execute: '#ff3b5c', reflectward: '#7fe0ff', manabarrier: '#9d7bff',
  corrosion: '#a6e052', vampiric: '#e15c9a', bloodpact: '#ff4d6d',
  silence: '#b9a9d6', haste: '#ffd479', mirror: '#cfe8ff',
};

export class Arena {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._size();
    this.events = [];
    this.idx = 0;
    this.isBusy = false;
    this.onLog = null;
    this.timers = [];
    this.raf = null;
    this.loop = this.loop.bind(this);
  }

  _size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start(events, opts) {
    this._clearTimers();
    this.events = events;
    this.idx = 0;
    this.isBusy = false;
    this.projectiles = [];
    this.particles = [];
    this.floaters = [];
    this.runes = Array.from({ length: 28 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.6 + 0.4, s: Math.random() * 8 + 3, p: Math.random() * 6.28,
    }));
    this.shake = 0;
    this.flash = 0;
    this.casters = {
      a: this._mkCaster(150, opts.a, '#4ade80', 1, opts.maxHp),
      b: this._mkCaster(W - 150, opts.b, '#ff6b6b', -1, opts.maxHp),
    };
    this.last = performance.now();
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  _mkCaster(x, name, color, facing, maxHp) {
    return {
      x, name, color, facing, maxHp,
      hp: maxHp, dispHp: maxHp, shield: 0, dispShield: 0,
      offset: 0, castGlow: 0, burnAura: 0, hit: 0, phase: Math.random() * 6.28,
    };
  }

  atEnd() { return this.idx >= this.events.length; }

  step(onSettled) {
    if (this.isBusy || this.atEnd()) return false;
    const ev = this.events[this.idx++];
    this.isBusy = true;
    if (this.onLog) this.onLog(ev);
    this._play(ev, () => { this.isBusy = false; if (onSettled) onSettled(); });
    return true;
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this._clearTimers();
  }

  _timer(fn, ms) { const id = setTimeout(fn, ms); this.timers.push(id); return id; }
  _clearTimers() { (this.timers || []).forEach(clearTimeout); this.timers = []; }

  _color(ev) {
    if (ev.move === 'tick') return '#ff5c3c';
    return SPELL_COLORS[ev.spellId] || '#c9b6ff';
  }

  // ---- event choreography ----
  _play(ev, done) {
    const c = this.casters;
    if (ev.move === 'self') {
      const self = c[ev.actor];
      const col = this._color(ev);
      self.castGlow = 1;
      this._timer(() => {
        this._applyState(ev);
        const isShield = ev.shieldGain != null;
        if (ev.heal) this._floater(self, '+' + ev.heal, '#4ade80');
        if (isShield) this._floater(self, '+' + ev.shieldGain + ' ✦', '#5fd0ff');
        if (ev.note) this._floater(self, ev.note, col);
        this._burst(self.x, GROUND - 44, isShield ? '#5fd0ff' : col, 16, true);
      }, 170);
      this._timer(done, 540);
      return;
    }

    if (ev.move === 'tick') {
      // burn ticks, reflected damage, and recoil all land as instant self-damage
      const self = c[ev.actor];
      const col = ev.kind === 'reflect' ? '#7fe0ff' : ev.kind === 'recoil' ? '#ff5d5d' : '#ff5c3c';
      if (ev.kind === 'burn') self.burnAura = 1;
      this._timer(() => {
        this._applyState(ev);
        this._floater(self, '-' + ev.amount, col);
        this._burst(self.x, GROUND - 46, col, 18, false);
        this.shake = Math.min(11, 3 + ev.amount * 0.5);
        self.hit = 1;
      }, 130);
      this._timer(done, 500);
      return;
    }

    // projectile / bolt
    const caster = c[ev.actor];
    const target = c[ev.target];
    const color = this._color(ev);
    caster.castGlow = 1;
    caster.offset = 9 * caster.facing;
    const fromX = caster.x + 26 * caster.facing;
    const fromY = GROUND - 60;
    const toX = target.x + 20 * target.facing;
    const toY = GROUND - 58;

    const onImpact = () => {
      this._applyState(ev);
      const dmg = ev.dmg || 0;
      if (ev.dmg != null) this._floater(target, '-' + ev.dmg, '#ff5b5b');
      if (ev.absorbed) this._floater(target, ev.absorbed + ' blocked', '#5fd0ff', -18);
      if (ev.heal) this._floater(caster, '+' + ev.heal, '#4ade80', 18);
      if (ev.sub === 'cast') { target.burnAura = 1; this._floater(target, '\u{1f525}', '#ff5c3c', 20); }
      if (ev.note) this._floater(target, ev.note, color); // Silence and other debuffs
      this.shake = Math.min(17, ev.note ? 4 : 4 + dmg * 0.55);
      this.flash = ev.note ? 0.2 : 0.45;
      this._burst(toX, toY, color, 18 + dmg, false);
      target.offset = -11 * caster.facing;
      target.hit = 1;
      if (ev.heal) this._tether(toX, toY, fromX, fromY, '#c779ff'); // drain life-steal
      this._timer(done, 230);
    };

    if (ev.move === 'bolt') {
      this._timer(() => this.projectiles.push({
        bolt: true, fromX, fromY, toX, toY, color, t: 0, dur: 0.16, onImpact,
      }), 120);
    } else {
      this._timer(() => this.projectiles.push({
        fromX, fromY, toX, toY, color, t: 0, dur: 0.42,
        size: 6 + (ev.value || 10) * 0.24, onImpact,
      }), 150);
    }
  }

  _applyState(ev) {
    const s = ev.state;
    this.casters.a.hp = s.hpA; this.casters.a.shield = s.shieldA;
    this.casters.b.hp = s.hpB; this.casters.b.shield = s.shieldB;
  }

  _floater(c, text, color, dx = 0) {
    this.floaters.push({ x: c.x + dx, y: GROUND - 96, vy: 36, life: 1.15, max: 1.15, text, color });
  }

  _burst(x, y, color, n, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28;
      const sp = 40 + Math.random() * 130;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: up ? -Math.abs(Math.sin(a) * sp) - 30 : Math.sin(a) * sp - 20,
        life: 0.5 + Math.random() * 0.5, max: 1, color,
        size: 1.5 + Math.random() * 2.5, g: up ? 60 : 220,
      });
    }
  }

  _tether(x0, y0, x1, y1, color) {
    for (let i = 0; i < 12; i++) {
      const t = i / 12;
      this.particles.push({
        x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t,
        vx: (x1 - x0) * 1.6, vy: (y1 - y0) * 1.6 - 30,
        life: 0.4 + Math.random() * 0.3, max: 1, color, size: 2, g: 0,
      });
    }
  }

  // ---- main loop ----
  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this._update(dt);
    this._render(now / 1000);
    this.raf = requestAnimationFrame(this.loop);
  }

  _update(dt) {
    for (const k of ['a', 'b']) {
      const c = this.casters[k];
      c.dispHp += (c.hp - c.dispHp) * Math.min(1, dt * 9);
      c.dispShield += (c.shield - c.dispShield) * Math.min(1, dt * 9);
      c.offset += (0 - c.offset) * Math.min(1, dt * 9);
      c.castGlow = Math.max(0, c.castGlow - dt * 2.2);
      c.hit = Math.max(0, c.hit - dt * 3);
      c.burnAura = Math.max(0, c.burnAura - dt * 0.14);
    }
    this.shake = Math.max(0, this.shake - dt * 40);
    this.flash = Math.max(0, this.flash - dt * 2);

    for (const p of this.projectiles) {
      p.t += dt / p.dur;
      if (p.t >= 1 && !p.fired) { p.fired = true; p.onImpact(); }
    }
    this.projectiles = this.projectiles.filter((p) => p.t < 1.05);

    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const f of this.floaters) { f.y -= f.vy * dt; f.life -= dt; }
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }

  // ---- rendering ----
  _render(time) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }
    this._bg(time);
    this._caster(this.casters.b, time);
    this._caster(this.casters.a, time);
    for (const p of this.projectiles) this._projectile(p);
    for (const p of this.particles) this._particle(p);
    for (const f of this.floaters) this._floaterDraw(f);
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.25})`;
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
    ctx.restore();
  }

  _bg(time) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#221a40');
    g.addColorStop(0.55, '#160f2c');
    g.addColorStop(1, '#0a0716');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // drifting runes
    for (const r of this.runes) {
      const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(time * 1.5 + r.p));
      ctx.fillStyle = `rgba(176,123,255,${tw * 0.5})`;
      ctx.beginPath();
      ctx.arc(r.x, r.y + Math.sin(time * 0.4 + r.p) * 4, r.r, 0, 6.28);
      ctx.fill();
    }
    // ground
    const gg = ctx.createLinearGradient(0, GROUND, 0, H);
    gg.addColorStop(0, '#2a2150');
    gg.addColorStop(1, '#120c24');
    ctx.fillStyle = gg;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.strokeStyle = 'rgba(176,123,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(W, GROUND); ctx.stroke();
    // summoning circles
    for (const k of ['a', 'b']) {
      const c = this.casters[k];
      ctx.strokeStyle = 'rgba(176,123,255,0.18)';
      ctx.beginPath();
      ctx.ellipse(c.x, GROUND + 6, 56, 12, 0, 0, 6.28);
      ctx.stroke();
    }
  }

  _caster(c, time) {
    const ctx = this.ctx;
    const bob = Math.sin(time * 2 + c.phase) * 3;
    const x = c.x + c.offset;
    const baseY = GROUND + bob;
    const f = c.facing;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(c.x, GROUND + 8, 40, 9, 0, 0, 6.28);
    ctx.fill();

    // burn aura at feet
    if (c.burnAura > 0) {
      for (let i = 0; i < 6; i++) {
        const fx = x + (i - 2.5) * 12;
        const h = (18 + Math.sin(time * 9 + i) * 8) * c.burnAura;
        const g = ctx.createLinearGradient(fx, baseY, fx, baseY - h);
        g.addColorStop(0, `rgba(255,120,40,${0.6 * c.burnAura})`);
        g.addColorStop(1, 'rgba(255,60,30,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(fx - 5, baseY);
        ctx.quadraticCurveTo(fx, baseY - h, fx + 5, baseY);
        ctx.fill();
      }
    }

    const hitTint = c.hit > 0;
    const robe = hitTint ? '#ffffff' : c.color;

    // robe body
    const topY = baseY - 96;
    ctx.fillStyle = robe;
    ctx.beginPath();
    ctx.moveTo(x, topY + 18);
    ctx.lineTo(x - 30, baseY);
    ctx.lineTo(x + 30, baseY);
    ctx.closePath();
    ctx.fill();
    // robe shading
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.moveTo(x, topY + 18);
    ctx.lineTo(x + 8 * f, topY + 18);
    ctx.lineTo(x + 30 * f, baseY);
    ctx.lineTo(x + 12 * f, baseY);
    ctx.closePath();
    ctx.fill();

    // head
    ctx.fillStyle = hitTint ? '#ffffff' : '#f0d9b5';
    ctx.beginPath();
    ctx.arc(x, topY + 4, 12, 0, 6.28);
    ctx.fill();

    // wizard hat
    ctx.fillStyle = robe;
    ctx.beginPath();
    ctx.moveTo(x - 15, topY - 4);
    ctx.lineTo(x + 15, topY - 4);
    ctx.lineTo(x + 4 * f, topY - 34);
    ctx.closePath();
    ctx.fill();

    // staff with glowing tip in the leading hand
    const handX = x + 24 * f;
    const handY = baseY - 52;
    ctx.strokeStyle = '#7a5a36';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(handX, handY + 30);
    ctx.lineTo(handX, handY - 26);
    ctx.stroke();
    const glow = 0.4 + c.castGlow * 0.6;
    const tipR = 5 + c.castGlow * 5;
    const tg = ctx.createRadialGradient(handX, handY - 28, 0, handX, handY - 28, tipR * 2.5);
    tg.addColorStop(0, c.color);
    tg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = glow;
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.arc(handX, handY - 28, tipR * 2.5, 0, 6.28);
    ctx.fill();
    ctx.globalAlpha = 1;

    // shield bubble
    if (c.dispShield > 0.4) {
      const alpha = Math.min(0.5, 0.18 + c.dispShield / c.maxHp);
      ctx.strokeStyle = `rgba(95,208,255,${alpha + 0.25})`;
      ctx.fillStyle = `rgba(95,208,255,${alpha * 0.3})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, baseY - 46, 42, 56, 0, 0, 6.28);
      ctx.fill();
      ctx.stroke();
    }

    this._hpBar(c);
  }

  _hpBar(c) {
    const ctx = this.ctx;
    const w = 132, x = c.x - w / 2, y = BAR_Y;
    // name + number
    ctx.font = '600 12px "Trebuchet MS", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#cfc6ea';
    ctx.textAlign = 'left';
    ctx.fillText(c.name, x, y - 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.fillText(Math.round(c.dispHp), x + w, y - 6);
    // track
    ctx.fillStyle = '#0a0716';
    this._roundRect(x, y, w, 11, 5); ctx.fill();
    // fill
    const fw = (w - 2) * Math.max(0, c.dispHp) / c.maxHp;
    if (fw > 0) {
      ctx.fillStyle = c.color;
      this._roundRect(x + 1, y + 1, fw, 9, 4); ctx.fill();
    }
    // shield bar
    if (c.dispShield > 0.4) {
      const sw = (w - 2) * Math.min(1, c.dispShield / c.maxHp);
      ctx.fillStyle = 'rgba(95,208,255,0.85)';
      this._roundRect(x + 1, y - 4, sw, 3, 1.5); ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#7fdcff';
      ctx.font = '600 10px "Trebuchet MS", sans-serif';
      ctx.fillText('\u{1f6e1} ' + Math.round(c.dispShield), x, y + 24);
    }
    ctx.textAlign = 'left';
  }

  _projectile(p) {
    const ctx = this.ctx;
    if (p.bolt) {
      // jagged lightning bolt that flickers across its short life
      const segs = 7;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = p.color; ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(p.fromX, p.fromY);
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const jx = (Math.random() - 0.5) * 22;
        const jy = (Math.random() - 0.5) * 22;
        ctx.lineTo(p.fromX + (p.toX - p.fromX) * t + jx, p.fromY + (p.toY - p.fromY) * t + jy);
      }
      ctx.lineTo(p.toX, p.toY);
      ctx.stroke();
      ctx.shadowBlur = 0;
      return;
    }
    // arcing orb with a glowing trail
    const t = Math.min(1, p.t);
    const x = p.fromX + (p.toX - p.fromX) * t;
    const arc = Math.sin(Math.PI * t) * 64;
    const y = p.fromY + (p.toY - p.fromY) * t - arc;
    const g = ctx.createRadialGradient(x, y, 0, x, y, p.size * 2.4);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.4, p.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, p.size * 2.4, 0, 6.28);
    ctx.fill();
  }

  _particle(p) {
    const ctx = this.ctx;
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, 6.28);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  _floaterDraw(f) {
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, f.life / f.max);
    ctx.font = '700 18px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
