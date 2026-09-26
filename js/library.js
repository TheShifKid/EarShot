/* ------------------------------------------------------------------
   library.js — your saved songs. Preview them or remove them.
   ------------------------------------------------------------------ */

const LibraryView = (() => {
  let root;

  function init() {
    root = $('#library-root');
    root.addEventListener('click', onClick);
    Player.subscribe((type) => { if (type === 'play' || type === 'pause' || type === 'ended' || type === 'error') syncButtons(); });
    document.addEventListener('earshot:change', (e) => { if (e.detail === 'saved' && App.currentView() === 'library') render(); });
  }

  function render() {
    const items = Saved.all();
    if (!items.length) {
      root.innerHTML = `
        <div class="empty">
          <p class="empty-big">Nothing on the shelf yet.</p>
          <p>Tap the heart on any song in the feed and it lands here.</p>
          <a class="pill-btn" href="#feed">Go to the feed</a>
        </div>`;
      return;
    }
    root.innerHTML = `
      <p class="count">${items.length} song${items.length === 1 ? '' : 's'}</p>
      <ol class="rows">
        ${items.map((t, i) => `
          <li class="row" data-id="${escapeHtml(t.id)}">
            <span class="row-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
            <img class="row-art" src="${escapeHtml(t.artworkSmall || t.artwork)}" alt="" width="56" height="56" loading="lazy">
            <span class="row-text">
              <span class="row-title">${escapeHtml(t.title)}</span>
              <span class="row-sub">${escapeHtml(t.artist)}</span>
            </span>
            <span class="row-actions">
              <button type="button" class="icon-btn" data-action="play" aria-label="Play ${escapeHtml(t.title)}">${Icons.play}</button>
              ${t.url ? `<a class="icon-btn" href="${escapeHtml(t.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(t.title)} in Spotify (new tab)">${Icons.external}</a>` : ''}
              <button type="button" class="icon-btn" data-action="remove" aria-label="Remove ${escapeHtml(t.title)} from library">${Icons.remove}</button>
            </span>
          </li>`).join('')}
      </ol>`;
    syncButtons();
  }

  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('.row');
    const id = row.dataset.id;
    const track = Saved.all().find((t) => t.id === id);
    if (!track) return;

    if (btn.dataset.action === 'play') {
      if (Player.isCurrent(id, 'library')) Player.toggle();
      else Player.play(track, 'library');
    } else if (btn.dataset.action === 'remove') {
      /* Remember where focus should go BEFORE the row disappears, otherwise
         keyboard users get thrown back to the top of the page. */
      const next = row.nextElementSibling || row.previousElementSibling;
      const nextId = next && next.dataset.id;
      if (Player.isCurrent(id, 'library')) Player.pause();
      Saved.remove(id);
      toast(`Removed “${track.title}”`);
      render();
      const target = nextId && root.querySelector(`.row[data-id="${nextId}"] [data-action="remove"]`);
      (target || $('#view-library h1')).focus();
    }
  }

  function syncButtons() {
    if (!root) return;
    $$('.row', root).forEach((row) => {
      const btn = row.querySelector('[data-action="play"]');
      const playing = Player.isPlaying() && Player.isCurrent(row.dataset.id, 'library');
      row.classList.toggle('is-playing', playing);
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      const title = row.querySelector('.row-title').textContent;
      btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${title}`);
    });
  }

  return { init, render };
})();
