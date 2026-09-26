/* ------------------------------------------------------------------
   feed.js — the vertical, swipeable song feed.

   Key techniques:
   • CSS scroll-snap (in style.css) makes each card "click" into place.
   • IntersectionObserver tells us which card is on screen, without
     listening to every scroll event (much cheaper than onscroll math).
   • Infinite loading: when you're 4 cards from the end we fetch more.
   • De-duplication by track id AND by normalized "title|artist", because
     the same song often exists on several albums with different IDs.
   ------------------------------------------------------------------ */

const Feed = (() => {
  /* Spotify has no "give me random pop" endpoint, so each station is a list
     of seed searches. `genre:"…"` and `artist:"…"` are Spotify search
     filters; mixing both keeps the feed varied but on-topic. */
  const GENRES = {
    pop: { label: 'Pop', seeds: ['genre:pop', 'genre:"dance pop"', 'genre:pop year:2020-2026', 'genre:pop year:2010-2019', 'artist:"Dua Lipa"', 'artist:"Sabrina Carpenter"', 'artist:"Chappell Roan"', 'artist:"Charli xcx"', 'artist:"Olivia Rodrigo"', 'artist:"Lorde"'] },
    hiphop: { label: 'Hip-hop', seeds: ['genre:"hip hop"', 'genre:rap', 'genre:"hip hop" year:2018-2026', 'artist:"Kendrick Lamar"', 'artist:"Tyler, The Creator"', 'artist:"Doechii"', 'artist:"OutKast"', 'artist:"Little Simz"', 'artist:"MF DOOM"', 'artist:"Missy Elliott"'] },
    rock: { label: 'Rock', seeds: ['genre:rock', 'genre:"alternative rock"', 'genre:"classic rock"', 'artist:"Arctic Monkeys"', 'artist:"Queens of the Stone Age"', 'artist:"The Black Keys"', 'artist:"Fleetwood Mac"', 'artist:"The Strokes"', 'artist:"IDLES"', 'artist:"Foo Fighters"'] },
    indie: { label: 'Indie', seeds: ['genre:indie', 'genre:"indie rock"', 'genre:"indie pop"', 'artist:"Phoebe Bridgers"', 'artist:"Tame Impala"', 'artist:"Beach House"', 'artist:"Alvvays"', 'artist:"Big Thief"', 'artist:"Japanese Breakfast"', 'artist:"Vampire Weekend"'] },
    electronic: { label: 'Electronic', seeds: ['genre:electronic', 'genre:house', 'genre:techno', 'artist:"Fred again.."', 'artist:"Daft Punk"', 'artist:"Bicep"', 'artist:"Caribou"', 'artist:"Jamie xx"', 'artist:"KAYTRANADA"', 'artist:"Four Tet"'] },
    rnb: { label: 'R&B', seeds: ['genre:"r&b"', 'genre:soul', 'genre:"neo soul"', 'artist:"SZA"', 'artist:"Frank Ocean"', 'artist:"Daniel Caesar"', 'artist:"Kali Uchis"', 'artist:"Steve Lacy"', 'artist:"Jorja Smith"', 'artist:"Erykah Badu"'] },
    chill: { label: 'Chill', seeds: ['genre:chill', 'genre:"lo-fi"', 'genre:ambient', 'genre:acoustic', 'artist:"Khruangbin"', 'artist:"Bon Iver"', 'artist:"Men I Trust"', 'artist:"Nujabes"', 'artist:"Norah Jones"', 'artist:"Mazzy Star"'] },
  };
  const MAX_ROUNDS = 8;      // pages deep per seed before a station runs dry
  const PER_ARTIST_CAP = 3;  // keep one artist from flooding a batch

  const state = {
    genre: 'mix', query: '', seeds: [], cursor: 0, round: 0,
    tracks: [], cards: [], seen: new Set(),
    loading: false, exhausted: false, lastError: null, active: -1, unlocked: false,
    requestId: 0, scrollMemory: 0, lastGesture: 0, playWasTapped: false,
  };
  let feedEl, statusEl, gateEl, gateBody, observer, markedCard = null;

  /* ---------------- setup ---------------- */

  function init(authResult) {
    feedEl = $('#feed');
    gateEl = $('#gate');
    gateBody = $('#gate-body');

    /* root = the feed itself (it's the scrolling box, not the window).
       threshold 0.6 = "tell me when 60% of a card is visible". With full-
       height cards only one card can be 60% visible at a time. */
    observer = new IntersectionObserver(onIntersect, { root: feedEl, threshold: [0, 0.6] });

    feedEl.addEventListener('click', onFeedClick);
    gateEl.addEventListener('click', onGateClick);
    gateEl.addEventListener('submit', onSetupSubmit);
    Player.subscribe(onPlayer);
    document.addEventListener('earshot:change', (e) => { if (e.detail === 'saved') syncSaveButtons(); });
    document.addEventListener('earshot:auth', () => {
      if (Spotify.isLoggedIn()) return;
      state.unlocked = false;
      setGate('login', 'Your Spotify session ended. Connect again to keep listening.');
    });
    /* Remember when the user last tapped or pressed a key; see onPlayer 'stalled'. */
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { state.lastGesture = Date.now(); }, true));

    /* Rotating a phone changes every card's height; re-align to the
       current card so you don't end up halfway between two songs. */
    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        const card = state.cards[state.active];
        if (card && !feedEl.closest('[hidden]')) feedEl.scrollTop = card.offsetTop;
      });
    });

    $$('.chip').forEach((chip) => chip.addEventListener('click', () => onChip(chip)));
    $('#search-form').addEventListener('submit', onSearch);

    if (!Spotify.clientId()) setGate('setup');
    else if (!Spotify.isLoggedIn()) setGate('login', authResult && authResult.error);
    else reload('mix');
  }

  /* ---------------- loading songs ---------------- */

  function seedsFor(genre, query) {
    if (genre === 'search') return [{ q: query, genre: '' }];
    const pick = genre === 'mix' ? Object.values(GENRES) : [GENRES[genre]];
    return shuffle(pick.flatMap((g) => g.seeds.map((q) => ({ q, genre: g.label }))));
  }

  /* Hands out the next searches: every seed at page 1, then every seed at
     page 2, and so on, like reading the first page of every result list
     before any second page. */
  function nextQueries(n) {
    const out = [];
    while (out.length < n) {
      if (state.cursor >= state.seeds.length) {
        state.cursor = 0;
        state.round++;
        if (state.round >= MAX_ROUNDS) break;
      }
      out.push({ ...state.seeds[state.cursor++], offset: state.round * Spotify.LIMIT });
    }
    return out;
  }

  async function reload(genre, query = '') {
    const req = ++state.requestId;
    Object.assign(state, {
      genre, query, seeds: seedsFor(genre, query), cursor: 0, round: 0,
      tracks: [], cards: [], loading: false, exhausted: false, lastError: null, active: -1,
    });
    state.seen.clear();
    markedCard = null;
    if (Player.owner() === 'feed') Player.pause();

    observer.disconnect();
    feedEl.innerHTML = '';
    statusEl = document.createElement('div');
    statusEl.className = 'card card-status';
    feedEl.appendChild(statusEl);
    observer.observe(statusEl);
    feedEl.scrollTop = 0;

    if (!Spotify.clientId()) { setGate('setup'); return; }
    if (!Spotify.isLoggedIn()) { setGate('login'); return; }

    if (!state.unlocked) setGate('loading');
    await loadMore();
    if (req !== state.requestId) return; // a newer reload started meanwhile
    if (state.lastError instanceof AuthError) return; // the auth listener already showed the login gate

    if (!state.tracks.length) {
      setStatus(state.lastError ? 'error' : 'empty');
      if (!state.unlocked) setGate('error', state.lastError ? state.lastError.message : 'No playable songs came back. Try another station.');
    } else {
      Player.prepare(state.tracks[0]);
      if (!state.unlocked) setGate('ready');
    }
  }

  async function loadMore() {
    if (state.loading || state.exhausted || !Spotify.isLoggedIn()) return 0;
    const req = state.requestId;
    state.loading = true;
    setStatus('loading');

    let added = 0;
    let attempts = 0;
    let failures = 0;
    let requests = 0;
    let lastError = null;
    const isSearch = state.genre === 'search';

    while (added < 6 && attempts < 4 && !state.exhausted) {
      attempts++;
      const queries = nextQueries(isSearch ? 1 : 2);
      if (!queries.length) { state.exhausted = true; break; }

      /* allSettled (not all): one failed search shouldn't sink the others. */
      const results = await Promise.allSettled(queries.map((q) => Spotify.search(q.q, q.offset, q.genre)));
      if (req !== state.requestId) return 0;

      const batch = [];
      let raw = 0;
      for (const r of results) {
        requests++;
        if (r.status === 'fulfilled') { batch.push(...r.value.tracks); raw += r.value.raw; }
        else { failures++; lastError = r.reason; }
      }
      if (lastError instanceof AuthError) break;
      if (isSearch && failures === 0 && raw === 0) state.exhausted = true;
      added += append(capPerArtist(shuffle(batch)));
    }

    const allFailed = requests > 0 && failures === requests;
    state.lastError = added === 0 && (allFailed || lastError instanceof AuthError) ? lastError : null;
    if (isSearch && added === 0 && !state.lastError) state.exhausted = true;
    state.loading = false;

    if (state.lastError && state.tracks.length && !(state.lastError instanceof AuthError)) {
      toast('Couldn’t reach Spotify. Scroll down to retry.');
    }
    setStatus(state.exhausted ? 'end' : state.lastError ? 'error' : 'idle');
    return added;
  }

  function capPerArtist(list) {
    const counts = {};
    return list.filter((t) => (counts[t.artist] = (counts[t.artist] || 0) + 1) <= PER_ARTIST_CAP);
  }

  /* Adds new, never-seen tracks as cards. Returns how many were added. */
  function append(batch) {
    const fresh = [];
    const frag = document.createDocumentFragment();
    for (const t of batch) {
      const key = dedupeKey(t);
      if (state.seen.has(t.id) || state.seen.has(key)) continue;
      state.seen.add(t.id);
      state.seen.add(key);
      const index = state.tracks.push(t) - 1;
      const card = buildCard(t, index);
      state.cards.push(card);
      frag.appendChild(card);
      fresh.push(card);
    }
    feedEl.insertBefore(frag, statusEl); // the status card always stays last
    fresh.forEach((card) => observer.observe(card));
    Pool.add(fresh.map((c) => state.tracks[c.dataset.index]));
    return fresh.length;
  }

  function buildCard(t, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.index = index;
    card.dataset.id = t.id;
    card.setAttribute('aria-label', `${t.title} by ${t.artist}`);
    const saved = Saved.has(t.id);
    const meta = [t.album, t.year].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="card-bg" aria-hidden="true"></div>
      <div class="card-body">
        <p class="card-cat">
          <span>No.&nbsp;${String(index + 1).padStart(3, '0')}</span>
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          ${t.genre ? `<span class="card-genre">${escapeHtml(t.genre)}</span>` : ''}
        </p>
        <div class="cover" data-action="toggle">
          ${t.artwork ? `<img src="${escapeHtml(t.artwork)}" alt="" width="640" height="640" loading="lazy" decoding="async">` : ''}
          <span class="cover-badge" aria-hidden="true">${Icons.play}</span>
        </div>
        <div class="card-info">
          <h2 class="card-title">${escapeHtml(t.title)}</h2>
          <p class="card-artist">${escapeHtml(t.artist)}</p>
          ${meta ? `<p class="card-album">${escapeHtml(meta)}</p>` : ''}
        </div>
        <div class="progress" aria-hidden="true"><span></span></div>
        <div class="actions">
          <button type="button" class="btn-play" data-action="toggle" aria-label="Play ${escapeHtml(t.title)}">${Icons.play}</button>
          <button type="button" class="btn-save" data-action="save" aria-pressed="${saved}" aria-label="Save ${escapeHtml(t.title)} to library">${Icons.heart}</button>
          <a class="btn-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">Open in Spotify ${Icons.external}<span class="visually-hidden"> (opens in new tab)</span></a>
        </div>
      </div>`;
    /* The blurred background uses the SMALLEST artwork (64px): after a 48px
       blur nobody can tell, and it downloads far faster than the 640px one. */
    if (t.artworkSmall) card.querySelector('.card-bg').style.backgroundImage = `url("${t.artworkSmall.replace(/"/g, '%22')}")`;
    return card;
  }

  function setStatus(kind) {
    if (!statusEl) return;
    const label = state.genre === 'search' ? `“${escapeHtml(state.query)}”` : 'this station';
    const errText = state.lastError ? escapeHtml(state.lastError.message) : '';
    const views = {
      loading: '<p class="status-big">Digging through crates…</p>',
      idle: '<p class="status-big">More on the way…</p>',
      end: `<p class="status-big">That’s everything for ${label}.</p><p class="status-small">Pick another chip up top, or search for something new.</p>`,
      empty: `<p class="status-big">Nothing playable for ${label}.</p><p class="status-small">Try a different search.</p>`,
      error: `<p class="status-big">Couldn’t reach Spotify.</p><p class="status-small">${errText}</p><button type="button" class="pill-btn" data-action="retry">Try again</button>`,
    };
    statusEl.innerHTML = `<div class="status-inner">${views[kind]}</div>`;
  }

  /* ---------------- which card is on screen ---------------- */

  function onIntersect(entries) {
    for (const entry of entries) {
      if (entry.target === statusEl) {
        /* Reached the bottom: load more (this also retries after errors). */
        if (entry.isIntersecting && !state.loading && !state.exhausted && state.tracks.length) loadMore();
        continue;
      }
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) setActive(Number(entry.target.dataset.index));
    }
  }

  function setActive(index) {
    if (index === state.active || !state.cards[index]) return;
    if (state.cards[state.active]) state.cards[state.active].classList.remove('is-active');
    state.active = index;
    const card = state.cards[index];
    card.classList.add('is-active');
    setProgress(card, 0);
    if (state.unlocked && App.currentView() === 'feed') playActive();
    if (index >= state.tracks.length - 4) loadMore();
  }

  function playActive() {
    const t = state.tracks[state.active];
    if (!t) return;
    /* Was this play caused by a tap/keypress just now? If it still stalls,
       the track itself is the problem (not the browser's autoplay rule). */
    state.playWasTapped = Date.now() - state.lastGesture < 1200;
    Player.play(t, 'feed');
  }

  function go(index) {
    const i = Math.max(0, Math.min(index, state.cards.length - 1));
    const target = index > i ? statusEl : state.cards[i];
    if (target) target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  /* ---------------- clicks ---------------- */

  function onFeedClick(e) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'retry') { state.exhausted = false; state.tracks.length ? loadMore() : reload(state.genre, state.query); return; }

    const card = actionEl.closest('.card');
    const index = Number(card.dataset.index);
    const t = state.tracks[index];
    if (!t) return;

    if (action === 'toggle') {
      if (!state.unlocked) { start(); return; }
      if (index !== state.active) { go(index); return; }
      if (Player.isCurrent(t.id, 'feed')) Player.toggle(); else playActive();
    } else if (action === 'save') {
      const saved = Saved.toggle(t);
      toast(saved ? `Saved “${t.title}” to your Library` : 'Removed from Library');
    }
  }

  function onChip(chip) {
    const genre = chip.dataset.genre;
    const form = $('#search-form');
    if (genre === 'search') {
      const open = form.hidden;
      form.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
      if (open) $('#search-input').focus();
      return;
    }
    form.hidden = true;
    $('.chip-search').setAttribute('aria-expanded', 'false');
    selectChip(genre);
    reload(genre);
  }

  function onSearch(e) {
    e.preventDefault();
    const input = $('#search-input');
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    input.blur(); // closes the phone keyboard
    selectChip('search');
    reload('search', q);
  }

  function selectChip(genre) {
    $$('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.genre === genre)));
  }

  /* ---------------- the gate (setup → login → tap to start) ----------------
     Browsers refuse to play sound until the user interacts with the page
     (the "autoplay policy"), so the last step is always a tap. */

  function setGate(mode, message) {
    gateEl.hidden = false;
    gateEl.dataset.mode = mode;
    const msg = message ? `<p class="gate-msg" role="alert">${escapeHtml(message)}</p>` : '';
    const bigButton = (label, disabled) => `
      <button type="button" class="gate-btn" data-gate="go" ${disabled ? 'disabled' : ''}>
        <span class="gate-btn-dot" aria-hidden="true"></span><span>${label}</span>
      </button>`;

    if (mode === 'setup') {
      gateBody.innerHTML = `
        <form class="setup" novalidate>
          <p class="gate-tag">Earshot plays music through Spotify. One-time setup: create a free Spotify app and paste its Client ID here (the README walks you through it).</p>
          <label for="client-id" class="setup-label">Spotify Client ID</label>
          <input id="client-id" class="setup-input" autocomplete="off" spellcheck="false" placeholder="e.g. 1a2b3c4d5e6f…" required>
          <p class="gate-small">Redirect URI to register in the Spotify dashboard:<br><code>${escapeHtml(Spotify.redirectUri())}</code></p>
          ${msg}
          <button type="submit" class="gate-btn"><span class="gate-btn-dot" aria-hidden="true"></span><span>Save</span></button>
        </form>`;
      return;
    }
    const labels = { login: 'Connect Spotify', loading: 'Tuning in…', ready: 'Tap to start', resume: 'Tap to resume', error: 'Try again' };
    const extras = mode === 'login' ? `
      <p class="gate-small">You’ll log in on spotify.com. Earshot never sees your password.</p>
      ${Spotify.hasConfigClientId() ? '' : '<button type="button" class="text-btn" data-gate="change-id">Change Client ID</button>'}` : '';
    gateBody.innerHTML = `${mode === 'login' || mode === 'ready' ? '<p class="gate-tag">New music, one swipe at a time. Swipe to skip, heart to keep.</p>' : ''}
      ${msg}${bigButton(labels[mode], mode === 'loading')}${extras}`;
  }

  async function onGateClick(e) {
    const btn = e.target.closest('[data-gate]');
    if (!btn) return;
    const mode = gateEl.dataset.mode;
    if (btn.dataset.gate === 'change-id') { setGate('setup'); return; }
    if (mode === 'login') {
      try { await Spotify.login(); } catch (err) { setGate('login', err.message); }
    } else if (mode === 'error') {
      reload(state.genre, state.query);
    } else if (mode === 'ready' || mode === 'resume') {
      start();
    }
  }

  function onSetupSubmit(e) {
    e.preventDefault();
    const input = $('#client-id');
    const id = input.value.trim();
    /* Spotify Client IDs are 32 hexadecimal characters. */
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      setGate('setup', 'That doesn’t look like a Client ID. It should be 32 letters and numbers.');
      $('#client-id').value = id;
      $('#client-id').focus();
      return;
    }
    Spotify.setClientId(id);
    setGate('login');
  }

  /* Must run inside the tap handler: that's what counts as "user
     interaction" for the browser's autoplay policy. */
  function start() {
    state.unlocked = true;
    gateEl.hidden = true;
    if (state.active < 0 && state.cards.length) setActive(0);
    state.lastGesture = Date.now();
    playActive();
    feedEl.focus({ preventScroll: true });
  }

  /* ---------------- reacting to the player ---------------- */

  function onPlayer(type, track, owner) {
    syncPlayButtons();
    if (owner !== 'feed') return;
    const card = state.cards[state.active];
    const isActiveTrack = card && track && card.dataset.id === String(track.id);
    if (type === 'time' && isActiveTrack) setProgress(card, Player.progress());
    if (type === 'ended' && isActiveTrack) go(state.active + 1);
    if (type === 'stalled' && isActiveTrack) {
      if (state.playWasTapped) {
        /* You tapped play and it still didn't start: skip this one. */
        card.classList.add('is-broken');
        toast('This song won’t play here. Skipping.');
        go(state.active + 1);
      } else if (App.currentView() === 'feed') {
        /* Probably the browser's autoplay rule. Ask for a tap. */
        setGate('resume', 'Your browser paused autoplay.');
      }
    }
  }

  function setProgress(card, fraction) {
    const bar = card.querySelector('.progress span');
    if (bar) bar.style.transform = `scaleX(${fraction})`;
  }

  function setCardPlaying(card, playing) {
    card.classList.toggle('is-playing', playing);
    const btn = card.querySelector('.btn-play');
    const title = state.tracks[card.dataset.index].title;
    btn.innerHTML = playing ? Icons.pause : Icons.play;
    btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${title}`);
  }

  function syncPlayButtons() {
    const t = Player.track();
    const playingId = Player.isPlaying() && Player.owner() === 'feed' && t ? String(t.id) : null;
    if (markedCard && markedCard.dataset.id !== playingId) { setCardPlaying(markedCard, false); markedCard = null; }
    const card = state.cards[state.active];
    if (playingId && card && card.dataset.id === playingId && markedCard !== card) {
      setCardPlaying(card, true);
      markedCard = card;
    }
  }

  function syncSaveButtons() {
    const ids = new Set(Saved.all().map((t) => String(t.id)));
    state.cards.forEach((c) => c.querySelector('.btn-save').setAttribute('aria-pressed', String(ids.has(c.dataset.id))));
  }

  /* ---------------- view lifecycle (called by app.js) ---------------- */

  function onShow() {
    const card = state.cards[state.active];
    /* display:none can reset a scroll position, so put it back. */
    if (card) feedEl.scrollTop = card.offsetTop;
    else if (state.scrollMemory) feedEl.scrollTop = state.scrollMemory;
    if (state.unlocked && gateEl.hidden) playActive();
  }

  function onHide() {
    state.scrollMemory = feedEl.scrollTop;
    if (Player.owner() === 'feed') Player.pause();
  }

  /* Keyboard: called by app.js while the feed is visible. */
  function onKey(e) {
    if (e.target.closest('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    const onControl = e.target.closest('button, a');
    if (!gateEl.hidden) return; // the gate's own buttons handle Enter/Space
    if (key === 'ArrowDown' || key === 'PageDown' || key === 'j') { e.preventDefault(); go(state.active + 1); }
    else if (key === 'ArrowUp' || key === 'PageUp' || key === 'k') { e.preventDefault(); go(state.active - 1); }
    else if (key === ' ' && !onControl) {
      /* Space on a focused button should still press that button, so we
         only take it over when focus is elsewhere. */
      e.preventDefault();
      if (Player.owner() === 'feed' && Player.track()) Player.toggle();
      else playActive();
    }
  }

  return { init, onShow, onHide, onKey };
})();
