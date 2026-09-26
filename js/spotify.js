/* ------------------------------------------------------------------
   spotify.js — login + search against the Spotify Web API.

   LOGIN: "Authorization Code with PKCE" (Proof Key for Code Exchange).
   Normal OAuth needs a client *secret*, and a static site can't hide
   one. PKCE replaces the secret with a one-time puzzle:
     1. We invent a random string (the "code verifier") and keep it.
     2. We send Spotify only its SHA-256 hash (the "code challenge").
     3. You log in on spotify.com, which redirects back with ?code=…
     4. We trade that code + the ORIGINAL verifier for an access token.
   Anyone who intercepts the code can't use it without the verifier.

   Access tokens last 1 hour; the refresh token gets a new one silently.
   ------------------------------------------------------------------ */

class AuthError extends Error {}

const Spotify = (() => {
  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API = 'https://api.spotify.com/v1';
  const LIMIT = 10; // small pages: works even under Spotify's strictest dev-mode limits

  const clientId = () => ((window.EARSHOT_CONFIG && window.EARSHOT_CONFIG.spotifyClientId) || Store.get('clientId', '')).trim();
  const setClientId = (id) => Store.set('clientId', String(id).trim());
  const hasConfigClientId = () => !!(window.EARSHOT_CONFIG && window.EARSHOT_CONFIG.spotifyClientId);

  /* Spotify must be told this exact address in the app dashboard. We drop
     "index.html" so /repo/ and /repo/index.html both use the same URI. */
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  const isLoggedIn = () => !!Store.get('token', null);
  function logout() {
    Store.set('token', null);
    document.dispatchEvent(new CustomEvent('earshot:auth'));
  }

  /* ---------------- PKCE helpers ---------------- */

  function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    /* crypto.getRandomValues is cryptographically strong; Math.random isn't. */
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  /* base64url = base64 with URL-safe characters and no "=" padding. */
  async function challengeFor(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    /* crypto.subtle only exists on https:// or http://127.0.0.1 ("secure contexts"). */
    if (!window.crypto || !crypto.subtle) throw new Error('Login needs https:// (or http://127.0.0.1 when testing locally).');
    const verifier = randomString(64);
    const state = randomString(16); // guards against someone else's login being injected
    if (!Store.set('pkce', { verifier, state, back: location.hash })) {
      throw new Error('This browser is blocking storage, so the Spotify login can’t complete.');
    }
    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      state,
    });
    location.assign(`${AUTH_URL}?${params}`);
  }

  /* Runs on every page load. Returns null (not a login return), {ok}, or {error}. */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return null;
    const pkce = Store.get('pkce', null);
    /* Remove ?code=… from the address bar so a refresh doesn't reuse it. */
    history.replaceState(null, '', redirectUri() + ((pkce && pkce.back) || ''));
    Store.set('pkce', null);

    if (params.has('error')) {
      return { error: params.get('error') === 'access_denied' ? 'You cancelled the Spotify login.' : `Spotify login failed (${params.get('error')}).` };
    }
    if (!pkce || params.get('state') !== pkce.state) return { error: 'The login check didn’t match. Please try again.' };

    await tokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: redirectUri(),
      client_id: clientId(),
      code_verifier: pkce.verifier,
    });
    return { ok: true };
  }

  async function tokenRequest(body) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    const prev = Store.get('token', null);
    Store.set('token', {
      access: data.access_token,
      refresh: data.refresh_token || (prev && prev.refresh),
      expires: Date.now() + (data.expires_in || 3600) * 1000,
    });
  }

  /* Several requests may notice an expired token at once; sharing one
     in-flight refresh promise stops them all refreshing separately. */
  let refreshing = null;
  async function accessToken() {
    const tok = Store.get('token', null);
    if (!tok) throw new AuthError('Not logged in');
    if (Date.now() < tok.expires - 60_000) return tok.access;
    if (!tok.refresh) { logout(); throw new AuthError('Session expired'); }
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: clientId() })
        .finally(() => { refreshing = null; });
    }
    try {
      await refreshing;
    } catch (err) {
      logout();
      throw new AuthError('Session expired');
    }
    return Store.get('token', {}).access;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, params = {}, retry = true) {
    const token = await accessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let res;
    try {
      res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 && retry) {
      /* Token rejected early: mark it expired and go round once more. */
      const tok = Store.get('token', null);
      if (tok) Store.set('token', { ...tok, expires: 0 });
      return api(path, params, false);
    }
    if (res.status === 429 && retry) {
      /* 429 = rate limited. Wait as long as Spotify asks (capped), retry once. */
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 1, 5);
      await sleep(wait * 1000);
      return api(path, params, false);
    }
    if (!res.ok) {
      /* Spotify explains most errors in the JSON body ({ error: { message } }).
         Showing its exact words makes problems far easier to diagnose. */
      const body = await res.json().catch(() => ({}));
      const detail = body && body.error && body.error.message ? ` Spotify says: “${body.error.message}”.` : '';
      if (res.status === 403) {
        throw new Error(`Spotify refused the request (403).${detail} Check that your Spotify account is listed under “User Management” in the app dashboard, then disconnect and connect again.`);
      }
      throw new Error(`Spotify API error ${res.status}.${detail}`);
    }
    return res.json();
  }

  /* Spotify's track object → the small shape the app uses. */
  function normalize(t, genre) {
    if (!t || !t.id || !t.uri || t.is_playable === false) return null;
    const images = (t.album && t.album.images) || []; // largest first
    const artwork = images[0] ? images[0].url : '';
    return {
      id: t.id,
      uri: t.uri,
      title: t.name || 'Untitled',
      artist: (t.artists || []).map((a) => a.name).join(', ') || 'Unknown artist',
      artistId: t.artists && t.artists[0] ? t.artists[0].id : '',
      album: (t.album && t.album.name) || '',
      artwork,
      artworkSmall: images.length ? images[images.length - 1].url : artwork,
      genre: genre || '',
      year: ((t.album && t.album.release_date) || '').slice(0, 4),
      url: (t.external_urls && t.external_urls.spotify) || `https://open.spotify.com/track/${t.id}`,
    };
  }

  /* Returns { tracks, raw }. raw = how many Spotify sent (0 → no more pages). */
  async function search(q, offset, genre) {
    const data = await api('/search', {
      q, type: 'track', limit: String(LIMIT), offset: String(offset),
      market: 'from_token', // use the logged-in user's country, so tracks are playable there
    });
    const items = (data.tracks && data.tracks.items) || [];
    return { tracks: items.map((t) => normalize(t, genre)).filter(Boolean), raw: items.length };
  }

  /* Tracks don't carry genres on Spotify, artists do. Cached per artist. */
  const genreCache = new Map();
  async function artistGenre(artistId) {
    if (!artistId || !isLoggedIn()) return '';
    if (!genreCache.has(artistId)) {
      genreCache.set(artistId, api(`/artists/${artistId}`)
        .then((a) => {
          const g = (a.genres || [])[0] || '';
          return g.replace(/\b\w/g, (c) => c.toUpperCase());
        })
        .catch(() => ''));
    }
    return genreCache.get(artistId);
  }

  return {
    LIMIT, clientId, setClientId, hasConfigClientId, redirectUri,
    isLoggedIn, login, logout, handleRedirect, search, artistGenre,
  };
})();
