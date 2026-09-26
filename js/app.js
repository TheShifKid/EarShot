/* ------------------------------------------------------------------
   app.js — boots everything and switches between the four views.

   Routing uses the URL hash (#feed, #library, …). GitHub Pages only serves
   files, so "real" URLs like /library would 404, but the part after # never
   reaches the server. It also makes the browser's Back button work for free.
   ------------------------------------------------------------------ */

const App = (() => {
  const VIEWS = ['feed', 'library', 'quiz', 'stats'];
  const RENDERERS = { library: () => LibraryView.render(), quiz: () => QuizView.render(), stats: () => StatsView.render() };
  let current = null;

  function route() {
    const wanted = location.hash.slice(1);
    const name = VIEWS.includes(wanted) ? wanted : 'feed';
    if (name === current) return;
    const prev = current;
    current = name;

    /* Tidy up the view we're leaving. */
    if (prev === 'feed') Feed.onHide();
    if (prev === 'library' && Player.owner() === 'library') Player.pause();
    if (prev === 'quiz') QuizView.onHide();

    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
    $$('.tab').forEach((tab) => {
      if (tab.dataset.tab === name) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    document.body.dataset.view = name;

    if (name === 'feed') {
      Feed.onShow();
    } else {
      RENDERERS[name]();
      const view = $(`#view-${name}`);
      view.scrollTop = 0;
      /* Move focus to the new heading so screen-reader and keyboard users
         land at the top of the new page (skipped on first load). */
      if (prev) $('h1', view).focus({ preventScroll: true });
    }
  }

  async function boot() {
    /* Coming back from the Spotify login page? Finish that first. */
    let auth = null;
    try {
      auth = await Spotify.handleRedirect();
    } catch (err) {
      auth = { error: `Spotify login failed: ${err.message}` };
    }

    Player.init();
    LibraryView.init();
    StatsView.init();
    QuizView.init();
    Feed.init(auth);
    route();
    window.addEventListener('hashchange', route);

    document.addEventListener('keydown', (e) => { if (current === 'feed') Feed.onKey(e); });

    /* Pause when the tab/app goes to the background, like most feed apps. */
    document.addEventListener('visibilitychange', () => { if (document.hidden) Player.pause(); });

    if (auth && auth.ok) toast('Connected to Spotify');
  }

  boot();

  return { currentView: () => current };
})();
