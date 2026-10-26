// Shared UI helpers: spooky backdrop, artwork, toasts, confetti, photo shrinking.
import { isDemo, firebaseReady, DEMO_PIN } from './backend.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const PARTY = {
  name: 'Ghouls Gone Wild',
  when: 'Saturday, Oct 31 · 9:00 pm',
  where: 'Miracle’s House of Horrors',
  prize: 'Winner gets a gift basket',
};

// Links between pages keep ?demo so a demo session stays in demo mode.
export function pageUrl(file = '') {
  const u = new URL(file || './', location.href);
  u.search = new URLSearchParams(location.search).has('demo') ? '?demo' : '';
  return u.href;
}

export const BAT = `<svg class="bat" viewBox="0 0 200 90" aria-hidden="true">
  <path fill="#9a52b8" d="M100 42C82 20 52 8 8 26c16 6 22 20 17 36 14-10 26-6 31 8 9-12 22-14 34-8z"/>
  <path fill="#9a52b8" d="M100 42c18-22 48-34 92-16-16 6-22 20-17 36-14-10-26-6-31 8-9-12-22-14-34-8z"/>
  <path fill="#7a3a96" d="M44 30c4 10 4 22 0 34M66 28c3 10 4 22 1 34M156 30c-4 10-4 22 0 34M134 28c-3 10-4 22-1 34" stroke="#6a2d86" stroke-width="5" stroke-linecap="round"/>
  <path fill="#9a52b8" d="M84 52q0-22 5-30l6 11q5-2 10 0l6-11q5 8 5 30 0 18-16 18T84 52z"/>
  <circle cx="93" cy="47" r="7" fill="#fff"/><circle cx="107" cy="47" r="7" fill="#fff"/>
  <circle cx="94.5" cy="48" r="4" fill="#f0873a"/><circle cx="105.5" cy="48" r="4" fill="#f0873a"/>
</svg>`;

export const GHOST = `<svg class="ghost" viewBox="0 0 100 110" aria-hidden="true">
  <path fill="#f4eee2" d="M14 100V48C14 22 30 8 50 8s36 14 36 40v52l-9-8-9 10-9-10-9 10-9-10-9 10-9-10z"/>
  <ellipse cx="38" cy="46" rx="6" ry="9" fill="#2a1a22"/><ellipse cx="62" cy="46" rx="6" ry="9" fill="#2a1a22"/>
  <ellipse cx="50" cy="68" rx="6" ry="8" fill="#5a2a6e"/>
</svg>`;

export const PUMPKIN = `<svg class="pumpkin" viewBox="0 0 100 100" aria-hidden="true">
  <path d="M30 34q20-34 40 0" fill="none" stroke="#f0873a" stroke-width="5"/>
  <ellipse cx="50" cy="66" rx="40" ry="30" fill="#f0873a"/>
  <path d="M30 60l10-6 6 8zM70 60l-10-6-6 8z" fill="#2a1a22"/>
  <path d="M28 74q22 16 44 0l-6 4-5-4-6 5-5-5-6 5-5-5-5 4z" fill="#2a1a22"/>
  <circle cx="38" cy="38" r="5" fill="#9fe0bf"/><circle cx="50" cy="35" r="5" fill="#9a52b8"/><circle cx="62" cy="38" r="5" fill="#f4eee2"/>
</svg>`;

// Seeded random so the webs look the same on every load.
function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function webPath(rand, cx, cy, r, spokes, rings) {
  const angs = [];
  for (let i = 0; i < spokes; i++) angs.push((i / spokes) * Math.PI * 2 + (rand() - 0.5) * 0.25);
  const pt = (a, rr) => `${(cx + Math.cos(a) * rr).toFixed(1)} ${(cy + Math.sin(a) * rr).toFixed(1)}`;
  let d = angs.map(a => `M${cx} ${cy}L${pt(a, r)}`).join('');
  for (let k = 1; k <= rings; k++) {
    const base = (r * k) / rings;
    const radii = angs.map(() => base * (0.92 + rand() * 0.12));
    angs.forEach((a, i) => {
      const j = (i + 1) % angs.length;
      const b = j === 0 ? angs[0] + Math.PI * 2 : angs[j];
      const mid = (a + b) / 2;
      d += `M${pt(a, radii[i])}Q${pt(mid, ((radii[i] + radii[j]) / 2) * 0.86)} ${pt(b, radii[j])}`;
    });
  }
  return d;
}

export function paintBackdrop() {
  const rand = rng(31);
  const webs = [
    { cls: 'web web-tl', spokes: 14, rings: 9 },
    { cls: 'web web-br', spokes: 16, rings: 10 },
    { cls: 'web web-c', spokes: 12, rings: 7 },
  ];
  const holder = document.createElement('div');
  holder.className = 'backdrop';
  holder.setAttribute('aria-hidden', 'true');
  holder.innerHTML = webs.map(w => `<svg class="${w.cls}" viewBox="0 0 1000 1000">
    <path d="${webPath(rand, 500, 500, 500, w.spokes, w.rings)}"/></svg>`).join('');
  document.body.prepend(holder);
}

export function demoBanner(extra = '') {
  if (!isDemo || new URLSearchParams(location.search).has('as')) return;
  const el = document.createElement('div');
  el.className = 'demo-banner';
  el.innerHTML = `<strong>Demo mode.</strong> ${firebaseReady ? '' : 'Firebase isn’t set up yet, so '}
    votes stay in this browser only. Each tab acts as a different guest.
    Host password: <code>${DEMO_PIN}</code>. ${extra}`;
  document.body.prepend(el);
}

export function toast(msg, kind = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

// In-page replacement for confirm(): returns a promise of true/false.
// With `typed`, the confirm button stays disabled until that word is typed.
export function askConfirm(message, { ok = 'Yes', danger = false, typed = '' } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="card modal-box" role="dialog" aria-modal="true">
      <p>${esc(message)}</p>
      ${typed ? `<label class="field">Type ${esc(typed)} to confirm<input id="modal-typed" autocomplete="off"></label>` : ''}
      <div class="btn-row">
        <button type="button" class="btn btn-soft" data-r="no">Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="yes" ${typed ? 'disabled' : ''}>${esc(ok)}</button>
      </div></div>`;
    const yes = wrap.querySelector('[data-r=yes]');
    const close = v => { wrap.remove(); removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    wrap.addEventListener('click', e => {
      const r = e.target === wrap ? 'no' : e.target.closest('[data-r]')?.dataset.r;
      if (r === 'no') close(false);
      if (r === 'yes' && !yes.disabled) close(true);
    });
    wrap.querySelector('#modal-typed')?.addEventListener('input', e => { yes.disabled = e.target.value.trim() !== typed; });
    addEventListener('keydown', onKey);
    document.body.append(wrap);
    (wrap.querySelector('#modal-typed') ?? yes).focus();
  });
}

addEventListener('backend-error', e => {
  const err = e.detail;
  toast(err?.code === 'permission-denied'
    ? 'The database refused that request. Are the security rules published?'
    : `Connection problem: ${err?.message ?? err}`, 'err');
});

// Shrinks a phone photo to a small JPEG data URL (fits comfortably in a Firestore doc).
export async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Couldn’t read that photo. Try a different one.'));
      i.src = url;
    });
    let size = 720, quality = 0.8, out = '';
    for (let tries = 0; tries < 6; tries++) {
      const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', quality);
      if (out.length < 160000) break;
      size = Math.round(size * 0.8);
      quality = Math.max(0.5, quality - 0.08);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function photoTag(entry, cls = '') {
  return entry?.photo
    ? `<img class="${cls}" src="${esc(entry.photo)}" alt="${esc(entry.costume)}" loading="lazy">`
    : `<div class="${cls} no-photo">${GHOST}</div>`;
}

// Ranked results → the winning entries (all tied at the top, if any votes were cast).
export function winnersOf(results) {
  const ranking = results?.ranking ?? [];
  const top = ranking[0]?.votes ?? 0;
  return top > 0 ? ranking.filter(r => r.votes === top) : [];
}

export function confetti(duration = 4500) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  document.body.append(c);
  const ctx = c.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const resize = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; };
  resize();
  const colors = ['#9fe0bf', '#9a52b8', '#f0873a', '#f4eee2', '#e2333f'];
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * c.width,
    y: -Math.random() * c.height * 0.6,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    r: (4 + Math.random() * 6) * dpr,
    rot: Math.random() * 6,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
    tri: Math.random() < 0.4, // candy-corn triangles
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      if (b.tri) {
        ctx.beginPath(); ctx.moveTo(0, -b.r); ctx.lineTo(b.r, b.r); ctx.lineTo(-b.r, b.r); ctx.fill();
      } else {
        ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2);
      }
      ctx.restore();
    }
    if (now - start < duration) requestAnimationFrame(frame);
    else c.remove();
  })(start);
}
