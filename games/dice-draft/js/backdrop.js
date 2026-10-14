// The page background: Bones' junkyard at night. A bent corrugated fence with
// barbed wire and scrap piled behind it, a burn barrel (flames, embers, firelight
// on the fence), a tyre stack, his tag sprayed on the fence and a crane hook
// swinging overhead. All of it is DOM and inline SVG drawn behind #app, so it
// costs no download; every animation moves only transform or opacity, and
// prefers-reduced-motion stills it (css/styles.css, "the junkyard").

const PANELS = 30; // ~3000px of fence: wider than any screen

// A fixed pseudo-random sequence, so the fence is bent the same way every visit.
function wobble(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

function fence() {
  const r = wobble(7);
  let html = '';
  for (let i = 0; i < PANELS; i++) {
    const w = 96 + Math.round(r() * 26);
    const a = Math.round(r() * 22), b = Math.round(r() * 22); // how far each top corner sags
    const tint = r() < 0.3 ? 'blue' : r() < 0.4 ? 'rust' : '';
    const rust = `${Math.round(r() * 100)}% ${30 + Math.round(r() * 60)}%`;
    html += `<i class="fence-panel ${tint}" style="--w:${w}px;--a:${a}px;--b:${b}px;--dy:${Math.round(r() * 14) - 7}px;--tilt:${(r() * 1.6 - 0.8).toFixed(2)}deg;--rust:${rust}"></i>`;
  }
  return html;
}

const JUNK = `<svg class="junk" viewBox="0 0 1600 120" preserveAspectRatio="xMidYMax slice">
  <path d="M0 120 L0 70 L40 66 L60 40 L130 34 L160 60 L200 62 L210 40 L260 36 L280 70 L330 72 L350 50 L420 46 L440 20 L520 16 L550 44 L600 48 L640 80 L700 82 L720 58 L790 52 L810 30 L880 26 L900 54 L960 58 L980 76 L1040 78 L1060 46 L1120 40 L1140 14 L1220 10 L1250 40 L1300 44 L1330 70 L1390 72 L1410 50 L1480 44 L1500 64 L1560 66 L1600 60 L1600 120 Z" fill="#140F26"/>
  <g fill="#0B0819"><circle cx="90" cy="70" r="14"/><circle cx="150" cy="70" r="14"/><circle cx="470" cy="50" r="15"/><circle cx="540" cy="50" r="15"/><circle cx="1170" cy="44" r="15"/><circle cx="1240" cy="44" r="15"/></g>
</svg>`;

const BARREL = `<div class="barrel">
  <i class="firelight"></i>
  <svg class="drum" viewBox="0 0 80 104" aria-hidden="true">
    <defs><linearGradient id="drum" x1="0" x2="1"><stop offset="0" stop-color="#24192A"/><stop offset=".4" stop-color="#6E4434"/><stop offset=".7" stop-color="#4A2E2A"/><stop offset="1" stop-color="#1E1624"/></linearGradient></defs>
    <ellipse cx="40" cy="102" rx="44" ry="7" fill="#05040C" opacity=".7"/>
    <rect x="2" y="6" width="76" height="96" rx="4" fill="url(#drum)"/>
    <g stroke="#1A1220" stroke-width="3"><line x1="2" y1="36" x2="78" y2="36"/><line x1="2" y1="72" x2="78" y2="72"/></g>
    <g class="holes" fill="#FF9A3A"><circle cx="20" cy="52" r="3"/><circle cx="40" cy="56" r="3.4"/><circle cx="60" cy="50" r="2.6"/><circle cx="30" cy="88" r="2.6"/><circle cx="52" cy="86" r="3"/></g>
    <ellipse cx="40" cy="6" rx="38" ry="7" fill="#3A2830"/>
    <ellipse cx="40" cy="7" rx="33" ry="5" fill="#FF7A2A"/>
  </svg>
  <svg class="flame f1" viewBox="0 0 90 110" aria-hidden="true"><path d="M14 104C6 70 26 60 22 30c14 18 18 0 24-24 6 28 24 36 16 64 10-8 14 8 14 34Z" fill="#FF6A2A"/></svg>
  <svg class="flame f2" viewBox="0 0 90 110" aria-hidden="true"><path d="M26 104c-4-24 8-30 8-52 10 14 14 2 16-16 6 22 16 30 12 68Z" fill="#FFB43A"/></svg>
  <svg class="flame f3" viewBox="0 0 90 110" aria-hidden="true"><path d="M36 104c-2-14 6-20 8-34 6 12 12 18 8 34Z" fill="#FFE68A"/></svg>
  <i class="ember e1"></i><i class="ember e2"></i><i class="ember e3"></i><i class="ember e4"></i><i class="ember e5"></i>
</div>`;

const TYRE = '<rect x="-40" y="0" width="80" height="18" fill="url(#tyre)"/><ellipse cx="0" cy="18" rx="40" ry="12" fill="#0E0C16"/><ellipse cx="0" cy="0" rx="40" ry="12" fill="#2A2638"/><ellipse cx="0" cy="0" rx="18" ry="5" fill="#05040C"/>';
const TYRES = `<svg class="tyres" viewBox="-50 -60 100 92" aria-hidden="true">
  <defs><linearGradient id="tyre" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2E2A3C"/><stop offset="1" stop-color="#0E0C16"/></linearGradient></defs>
  <ellipse cx="0" cy="26" rx="46" ry="6" fill="#05040C" opacity=".6"/>
  <g>${TYRE}</g><g transform="translate(4 -18) rotate(-3)">${TYRE}</g><g transform="translate(-6 -38) rotate(5)">${TYRE}</g>
</svg>`;

const TAG = `<div class="tag">
  <svg viewBox="0 0 46 16" aria-hidden="true"><polyline points="6,14 10,2 17,9 23,0 29,9 36,2 40,14 6,14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>
  <span>BONES</span>
</div>`;

const SIGN = '<div class="beware"><span>Beware</span><span>of dog</span></div>';

const HOOK = `<svg class="hook" viewBox="0 0 80 130" aria-hidden="true">
  <line x1="40" y1="0" x2="40" y2="78" stroke="#4A4668" stroke-width="5" stroke-dasharray="7 3"/>
  <rect x="31" y="76" width="18" height="12" rx="2" fill="#5E5A7C"/>
  <path d="M40 88v16a12 12 0 1 1-14 8" stroke="#8C88A8" stroke-width="5.5" fill="none" stroke-linecap="round"/>
</svg>`;

export function buildBackdrop(el) {
  if (!el) return;
  el.innerHTML = `
    ${JUNK}
    <div class="fence">${fence()}</div>
    <i class="wire"></i>
    ${TAG}${SIGN}
    <div class="dirt"><i class="slick"><i></i></i></div>
    ${TYRES}${BARREL}
    <i class="haze"></i>
    ${HOOK}
    <i class="vignette"></i>`;
}
