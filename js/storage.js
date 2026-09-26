/* ------------------------------------------------------------------
   storage.js — everything we remember about you lives in localStorage.

   localStorage can throw: Safari private mode, a full disk, or a browser
   that blocks site data. So every read/write goes through Store, which
   never throws. An in-memory Map mirrors the data, so even if saving fails
   the site keeps working for the current visit (it just won't remember
   things after a reload).
   ------------------------------------------------------------------ */

const Store = (() => {
  const PREFIX = 'earshot:';
  const memory = new Map();

  function get(key, fallback) {
    if (memory.has(key)) return memory.get(key);
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) {
        const value = JSON.parse(raw);
        memory.set(key, value);
        return value;
      }
    } catch (err) {
      /* Blocked storage or corrupted JSON: fall through to the default. */
    }
    return fallback;
  }

  function set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  return { get, set };
})();

/* We only store the fields we need, which keeps localStorage (about 5 MB) small. */
function slimTrack(t) {
  return {
    id: t.id, uri: t.uri, title: t.title, artist: t.artist, artistId: t.artistId,
    album: t.album, artwork: t.artwork, artworkSmall: t.artworkSmall,
    genre: t.genre, year: t.year, url: t.url,
  };
}

/* Tell the rest of the page that data changed. A CustomEvent on `document`
   is a tiny "pub/sub" (publish/subscribe) bus: the feed can update its
   heart icons without knowing anything about the Library view. */
const emitChange = (what) => document.dispatchEvent(new CustomEvent('earshot:change', { detail: what }));

/* ---------- Saved songs (the Library) ---------- */
const Saved = {
  all: () => Store.get('saved', []),
  has(id) { return this.all().some((t) => t.id === id); },
  toggle(track) {
    const list = this.all();
    const saved = !list.some((t) => t.id === track.id);
    Store.set('saved', saved ? [{ ...slimTrack(track), savedAt: Date.now() }, ...list] : list.filter((t) => t.id !== track.id));
    emitChange('saved');
    return saved;
  },
  remove(id) {
    Store.set('saved', this.all().filter((t) => t.id !== id));
    emitChange('saved');
  },
};

/* ---------- Listening history ----------
   One entry per song (not per play) with a play counter, so the list stays
   short no matter how much you listen. */
const Listens = {
  MAX: 500,
  all: () => Store.get('history', []),
  record(track) {
    const now = Date.now();
    const list = this.all();
    const existing = list.find((t) => t.id === track.id);
    const entry = existing
      ? { ...existing, plays: (existing.plays || 1) + 1, timestamp: now }
      : { ...slimTrack(track), plays: 1, firstHeard: now, timestamp: now };
    const next = [entry, ...list.filter((t) => t.id !== track.id)].slice(0, this.MAX);
    Store.set('history', next);
    emitChange('history');
  },
  /* Called a moment after record(), once the artist's genre has been looked up. */
  setGenre(id, genre) {
    Store.set('history', this.all().map((t) => (t.id === id ? { ...t, genre } : t)));
    emitChange('history');
  },
  clear() {
    Store.set('history', []);
    emitChange('history');
  },
};

/* ---------- Pool ----------
   Every song the feed has shown you (heard or not). The quiz uses these as
   wrong-answer options when your history alone doesn't have enough variety. */
const Pool = {
  MAX: 300,
  all: () => Store.get('pool', []),
  add(tracks) {
    if (!tracks.length) return;
    const ids = new Set(tracks.map((t) => t.id));
    const next = [...tracks.map(slimTrack), ...this.all().filter((t) => !ids.has(t.id))].slice(0, this.MAX);
    Store.set('pool', next);
  },
};
