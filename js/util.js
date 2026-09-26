/* ------------------------------------------------------------------
   util.js — small helpers shared by every other file.
   ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* Song titles come from an outside API, so we never paste them into
   innerHTML raw. Escaping turns "<" into "&lt;" etc. — this is what stops
   an XSS (cross-site scripting) attack via a weird song title. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Fisher–Yates shuffle: walk backwards, swap each item with a random earlier
   one. Unlike sort(() => Math.random() - 0.5), every order is equally likely. */
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* "Song (Remastered 2011)" and "Song - Radio Edit" should count as the same
   song, so we strip bracketed bits and dash-suffixes before comparing. */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^a-z0-9À-ɏ֐-׿ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const dedupeKey = (track) => `${normalizeTitle(track.title)}|${String(track.artist).toLowerCase().trim()}`;

/* One toast at a time; a new message replaces the old one. The element has
   role="status", so screen readers announce it without stealing focus. */
let toastTimer = null;
function toast(message, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function formatAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

const Icons = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>',
};
