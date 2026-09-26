/* ------------------------------------------------------------------
   player.js — plays songs through Spotify's embedded player.

   Spotify doesn't give new apps raw audio files, so playback goes through
   the official embed (an <iframe> from open.spotify.com) controlled by
   Spotify's "iFrame API". We make exactly ONE embed and swap songs into
   it with loadUri(). It lives in the "dock" above the tab bar.

   The iframe is a separate website, so we can't read its <audio> element.
   Instead it sends us 'playback_update' events ({ isPaused, position,
   duration } in milliseconds), and everything here (listen counting,
   "song ended", quiz snippets) is worked out from those updates.

   If you're logged in to Spotify in this browser, the embed may play full
   songs; otherwise it plays 30-second previews. Either way, each feed
   card moves on after the embed reports the end.

   Every play has an "owner" ('feed', 'library' or 'quiz') so each view
   knows whether the current sound belongs to it.
   ------------------------------------------------------------------ */

const Player = (() => {
  const SCRIPT_URL = 'https://open.spotify.com/embed/iframe-api/v1';
  const LISTEN_THRESHOLD_MS = 5000;
  const STALL_MS = 8000;
  const STUCK_MS = 7000; // "playing" but the position hasn't moved for this long

  let dock, veil;
  let apiPromise = null;
  let controllerPromise = null;
  let controller = null;
  let loadedUri = null;

  let track = null;
  let owner = null;
  let paused = true;
  let position = 0;
  let duration = 0;
  let listened = 0;
  let logged = false;
  let snippet = null;   // { start, length } waiting to be applied
  let stopAt = null;    // ms position where a quiz snippet stops
  let watchdog = null;
  let pendingPlay = null;   // id of a track waiting for the embed to finish loading
  let lastMoveAt = 0;       // when the playback position last changed
  let recoveries = 0;       // retries used on the current track
  const subscribers = new Set();

  const emit = (type) => subscribers.forEach((fn) => fn(type, track, owner));

  function init() {
    dock = $('#dock');
    veil = $('#dock-veil');
    loadApi().catch(() => {}); // start downloading early; errors surface on first play
    /* Stuck detector: sometimes the embed says "playing" but the position
       never moves (a stalled stream). One reload, then give up and let the
       view skip the song instead of sitting in silence. */
    setInterval(() => {
      if (!track || paused || !controller || Date.now() - lastMoveAt < STUCK_MS) return;
      lastMoveAt = Date.now();
      if (recoveries++ === 0) {
        loadedUri = null; // forces a fresh loadUri of the same song
        play(track, owner);
      } else {
        controller.pause();
        emit('stuck');
      }
    }, 2000);
  }

  /* The iFrame API script calls window.onSpotifyIframeApiReady when it's
     ready, so we wrap that callback in a Promise we can await. */
  function loadApi() {
    if (!apiPromise) {
      apiPromise = new Promise((resolve, reject) => {
        window.onSpotifyIframeApiReady = (IFrameAPI) => resolve(IFrameAPI);
        const s = document.createElement('script');
        s.src = SCRIPT_URL;
        s.async = true;
        s.onerror = () => { apiPromise = null; reject(new Error('Could not load the Spotify player.')); };
        document.head.appendChild(s);
      });
    }
    return apiPromise;
  }

  function getController(firstUri) {
    if (!controllerPromise) {
      controllerPromise = loadApi().then((IFrameAPI) => new Promise((resolve) => {
        dock.hidden = false;
        document.body.classList.add('has-dock');
        const host = $('#dock-embed');
        IFrameAPI.createController(host, { uri: firstUri, width: '100%', height: 80 }, (c) => {
          loadedUri = firstUri;
          c.addListener('playback_update', onUpdate);
          /* Resolve on 'ready' (the embed finished loading), with a
             fallback in case that event never arrives. */
          let done = false;
          const finish = () => { if (!done) { done = true; controller = c; resolve(c); } };
          c.addListener('ready', finish);
          /* After loadUri the embed fires 'ready' again once the new song is
             loaded: the safest moment to press play. */
          c.addListener('ready', () => {
            if (pendingPlay && track && track.id === pendingPlay && paused) c.play();
          });
          setTimeout(finish, 4000);
        });
      })).catch((err) => { controllerPromise = null; throw err; });
    }
    return controllerPromise;
  }

  /* Create the embed ahead of time (e.g. behind the "Tap to start" screen),
     so the first tap only has to press play. */
  function prepare(t) { getController(t.uri).catch(() => {}); }

  /* ---------------- reacting to the embed ---------------- */

  function onUpdate(e) {
    const d = (e && e.data) || {};
    const wasPaused = paused;
    const prevPos = position;
    paused = !!d.isPaused;
    position = d.position || 0;
    duration = d.duration || duration;
    if (!paused) { clearTimeout(watchdog); pendingPlay = null; }
    if (position !== prevPos || (!paused && wasPaused)) lastMoveAt = Date.now();

    /* Quiz snippet: we can only seek once the track is actually playing. */
    if (snippet && !paused && duration) {
      const latest = Math.max(0, duration / 1000 - snippet.length - 1);
      const start = Math.min(snippet.start, latest);
      controller.seek(start);
      stopAt = (start + snippet.length) * 1000;
      snippet = null;
      return;
    }

    /* Listen counting: only small forward steps count, so a seek can't
       fake 5 seconds of listening. */
    const delta = position - prevPos;
    if (!paused && delta > 0 && delta < 2500) listened += delta;
    if (!logged && track && listened >= LISTEN_THRESHOLD_MS && owner !== 'quiz') {
      logged = true;
      recordListen(track);
    }

    if (stopAt !== null && position >= stopAt) {
      stopAt = null;
      controller.pause();
      emit('snippet-end');
    }

    if (paused && !wasPaused) {
      /* The embed has no 'ended' event: a pause that lands at (or resets
         from) the very end of the track means it finished. */
      const nearEnd = duration && (position >= duration - 800 || (position === 0 && prevPos >= duration - 2000));
      /* Only trust "ended" if we actually heard this track play for a
         second; a stale update from a finished track must not skip ahead. */
      const atEnd = nearEnd && listened > 1000;
      emit(atEnd ? 'ended' : 'pause');
    } else if (!paused && wasPaused) {
      emit('play');
    }
    emit('time');
  }

  /* Save the listen right away, then look up the artist's genre in the
     background and patch it in (tracks themselves have no genre on Spotify). */
  function recordListen(t) {
    Listens.record(t);
    Taste.signal(t, 'listen');
    Spotify.artistGenre(t.artistId).then((g) => { if (g) Listens.setGenre(t.id, g); });
  }

  /* ---------------- commands ---------------- */

  /* play(track, owner, { start, duration }) — start/duration (seconds)
     make a short snippet, used by the quiz. */
  function play(next, nextOwner, opts = {}) {
    const fresh = !track || track.id !== next.id || owner !== nextOwner || opts.start != null;
    if (fresh) {
      track = next;
      owner = nextOwner;
      listened = 0;
      logged = false;
      stopAt = null;
      position = 0;
      paused = true;
      recoveries = 0;
    }
    lastMoveAt = Date.now();
    snippet = opts.start != null ? { start: opts.start, length: opts.duration || 6 } : null;

    /* If nothing starts within a few seconds, tell the views. Usually that
       means the browser blocked autoplay, or the track can't play here. */
    clearTimeout(watchdog);
    const playingId = next.id;
    watchdog = setTimeout(() => { if (paused && track && track.id === playingId) emit('stalled'); }, STALL_MS);

    const go = (c) => {
      if (loadedUri !== next.uri) {
        loadedUri = next.uri;
        pendingPlay = playingId;
        c.loadUri(next.uri);
        /* Press play once the new song is loaded ('ready', see above), with
           two timed fallbacks in case that event doesn't come. Each checks
           `paused` so a song that already started isn't restarted. */
        [400, 2500].forEach((ms) => setTimeout(() => {
          if (pendingPlay === playingId && track && track.id === playingId && paused) c.play();
        }, ms));
      } else if (fresh || opts.start != null) {
        /* Same song already in the embed (maybe finished): rewind first. */
        c.seek(0);
        c.play();
      } else {
        c.resume();
      }
    };
    /* Calling the controller synchronously when it already exists keeps
       us inside the user's tap, which browsers like for autoplay. */
    if (controller) go(controller);
    else getController(next.uri).then(go).catch((err) => { toast(err.message); emit('stalled'); });
  }

  function pause() {
    clearTimeout(watchdog);
    snippet = null;
    if (controller && !paused) controller.pause();
  }

  function toggle() {
    if (!controller) return;
    if (paused) { controller.resume(); } else { controller.pause(); }
  }

  /* The quiz covers the embed during "Name that song", since the player
     shows the title. The veil sits over the embed; audio keeps playing. */
  function setVeil(on) { if (veil) veil.hidden = !on; }

  return {
    init, prepare, play, pause, toggle, setVeil,
    isPlaying: () => !!track && !paused,
    isCurrent: (id, who) => !!track && track.id === id && owner === who,
    owner: () => owner,
    track: () => track,
    progress: () => (duration ? Math.min(1, position / duration) : 0),
    listenedMs: () => listened,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
})();
