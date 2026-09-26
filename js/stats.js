/* ------------------------------------------------------------------
   stats.js — what you've heard, counted up. Plus a "how it works" panel.
   ------------------------------------------------------------------ */

const StatsView = (() => {
  let root;

  function init() {
    root = $('#stats-root');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="logout"]')) {
        Spotify.logout();
        render();
        toast('Disconnected from Spotify');
        return;
      }
      if (!e.target.closest('[data-action="clear"]')) return;
      if (window.confirm('Clear your whole listening history? Saved songs and quiz scores stay.')) {
        Listens.clear();
        render();
        toast('Listening history cleared');
      }
    });
  }

  /* Tally helper: counts plays per key, returns the top N as [key, count]. */
  function top(list, keyFn, n = 5) {
    const counts = new Map();
    list.forEach((t) => {
      const k = keyFn(t);
      if (k) counts.set(k, (counts.get(k) || 0) + (t.plays || 1));
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function bars(rows) {
    if (!rows.length) return '<p class="muted">Nothing yet.</p>';
    const max = rows[0][1];
    return `<ol class="bars">${rows.map(([label, n]) => `
      <li>
        <span class="bar-label">${escapeHtml(label)}</span>
        <span class="bar-value">${n} play${n === 1 ? '' : 's'}</span>
        <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${Math.max(6, (n / max) * 100)}%"></span></span>
      </li>`).join('')}</ol>`;
  }

  function render() {
    const history = Listens.all();
    const plays = history.reduce((sum, t) => sum + (t.plays || 1), 0);
    const best = Store.get('quizBest', null);
    const recent = history.slice(0, 8);

    root.innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="tile-num">${history.length}</span><span class="tile-label">Songs heard</span></div>
        <div class="tile"><span class="tile-num">${plays}</span><span class="tile-label">Total listens</span></div>
        <div class="tile"><span class="tile-num">${Saved.all().length}</span><span class="tile-label">Saved</span></div>
        <div class="tile"><span class="tile-num">${best ? `${best.score}<small>/10</small>` : '–'}</span><span class="tile-label">Best quiz</span></div>
      </div>
      <p class="muted small">A song counts as heard after 5 seconds of playback.</p>

      <section class="block" aria-labelledby="h-artists">
        <h2 id="h-artists" class="block-title">Top artists</h2>
        ${bars(top(history, (t) => t.artist))}
      </section>

      <section class="block" aria-labelledby="h-genres">
        <h2 id="h-genres" class="block-title">Top genres</h2>
        ${bars(top(history, (t) => t.genre))}
      </section>

      <section class="block" aria-labelledby="h-recent">
        <h2 id="h-recent" class="block-title">Recently heard</h2>
        ${recent.length ? `<ol class="rows rows-compact">${recent.map((t) => `
          <li class="row">
            <img class="row-art" src="${escapeHtml(t.artworkSmall || t.artwork)}" alt="" width="44" height="44" loading="lazy">
            <span class="row-text">
              <span class="row-title">${escapeHtml(t.title)}</span>
              <span class="row-sub">${escapeHtml(t.artist)} · ${formatAgo(t.timestamp)}</span>
            </span>
          </li>`).join('')}</ol>` : '<p class="muted">Head to the feed and let a few songs play.</p>'}
        ${history.length ? '<button type="button" class="text-btn" data-action="clear">Clear listening history</button>' : ''}
      </section>

      ${Spotify.isLoggedIn() ? '<section class="block"><h2 class="block-title">Account</h2><p class="muted">Connected to Spotify in this browser.</p><button type="button" class="text-btn" data-action="logout">Disconnect Spotify</button></section>' : ''}

      <details class="notes">
        <summary>How this site works</summary>
        <dl>
          <dt>Scroll snap</dt>
          <dd>The feed is one scrolling box with <code>scroll-snap-type: y mandatory</code>. Each card is a snap point, so a flick always settles on exactly one song. No JavaScript needed for that part.</dd>
          <dt>IntersectionObserver</dt>
          <dd>Instead of doing math on every scroll event, the browser tells us when a card becomes 60% visible. That's the moment its song starts.</dd>
          <dt>Autoplay policy</dt>
          <dd>Browsers won't play sound until you interact with the page, hence the “Tap to start” screen. After that, one shared Spotify player is reused for every song.</dd>
          <dt>Spotify login (PKCE)</dt>
          <dd>A static site can't hide a password-like “client secret”, so the login uses PKCE: we send Spotify a hash of a random string, and later prove we own it by sending the original. Your Spotify password only ever goes to spotify.com.</dd>
          <dt>Spotify Web API + embed</dt>
          <dd>Searches go to the Spotify Web API. Spotify doesn't give new apps raw audio, so songs play through Spotify's official embedded player, driven by its iFrame API (<code>loadUri</code>, <code>play</code>, <code>pause</code>). The embed reports its position back to us, which is how the site counts listens and knows when a song ends.</dd>
          <dt>localStorage</dt>
          <dd>Your library, history and scores live only in this browser. No account, no server. Clear your site data and they're gone.</dd>
        </dl>
      </details>`;
  }

  return { init, render };
})();
