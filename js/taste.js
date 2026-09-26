/* ------------------------------------------------------------------
   taste.js — what the "For you" station knows about your taste.

   Spotify has shut its "recommendations" and "related artists" endpoints
   to new apps, so Earshot builds its own simple recommender from two
   sources:

   1. Your Spotify top artists (read once, cached): their genres say which
      stations to lean on, e.g. Sade + Frank Ocean → mostly R&B/soul.
   2. What you do in Earshot: hearts, full listens, quick skips and the
      "Not for me" button nudge scores up or down. This is a tiny version
      of "implicit feedback" learning: behaviour, not ratings.

   Scores become "seed searches" for the feed. Stations you like get more
   seeds, stations you keep rejecting get none. Everything is stored only
   in this browser.
   ------------------------------------------------------------------ */

const Taste = (() => {
  /* Each station is a list of Spotify search seeds. `genre:"…"` and
     `artist:"…"` are Spotify search filters. */
  const STATIONS = {
    pop: { label: 'Pop', seeds: ['genre:pop', 'genre:"dance pop"', 'genre:pop year:2020-2026', 'genre:pop year:2010-2019', 'artist:"Dua Lipa"', 'artist:"Sabrina Carpenter"', 'artist:"Chappell Roan"', 'artist:"Charli xcx"', 'artist:"Olivia Rodrigo"', 'artist:"Lorde"'] },
    hiphop: { label: 'Hip-hop', seeds: ['genre:"hip hop"', 'genre:rap', 'genre:"hip hop" year:2018-2026', 'artist:"Kendrick Lamar"', 'artist:"Tyler, The Creator"', 'artist:"Doechii"', 'artist:"OutKast"', 'artist:"Little Simz"', 'artist:"MF DOOM"', 'artist:"Missy Elliott"'] },
    rock: { label: 'Rock', seeds: ['genre:rock', 'genre:"alternative rock"', 'genre:"classic rock"', 'artist:"Arctic Monkeys"', 'artist:"Queens of the Stone Age"', 'artist:"The Black Keys"', 'artist:"Fleetwood Mac"', 'artist:"The Strokes"', 'artist:"IDLES"', 'artist:"Foo Fighters"'] },
    indie: { label: 'Indie', seeds: ['genre:indie', 'genre:"indie rock"', 'genre:"indie pop"', 'artist:"Phoebe Bridgers"', 'artist:"Tame Impala"', 'artist:"Beach House"', 'artist:"Alvvays"', 'artist:"Big Thief"', 'artist:"Japanese Breakfast"', 'artist:"Vampire Weekend"'] },
    electronic: { label: 'Electronic', seeds: ['genre:electronic', 'genre:house', 'genre:techno', 'artist:"Fred again.."', 'artist:"Daft Punk"', 'artist:"Bicep"', 'artist:"Caribou"', 'artist:"Jamie xx"', 'artist:"KAYTRANADA"', 'artist:"Four Tet"'] },
    rnb: { label: 'R&B', seeds: ['genre:"r&b"', 'genre:soul', 'genre:"neo soul"', 'genre:"quiet storm"', 'artist:"Sade"', 'artist:"SZA"', 'artist:"Frank Ocean"', 'artist:"Daniel Caesar"', 'artist:"Kali Uchis"', 'artist:"Steve Lacy"', 'artist:"Jorja Smith"', 'artist:"Erykah Badu"'] },
    chill: { label: 'Chill', seeds: ['genre:chill', 'genre:"lo-fi"', 'genre:ambient', 'genre:acoustic', 'artist:"Khruangbin"', 'artist:"Bon Iver"', 'artist:"Men I Trust"', 'artist:"Nujabes"', 'artist:"Norah Jones"', 'artist:"Mazzy Star"'] },
  };

  /* Spotify genre names are very specific ("quiet storm", "alternative
     r&b"…). These rules fold them into our seven stations. Order matters:
     "indie pop" must hit indie before the generic pop rule. */
  const GENRE_RULES = [
    [/r&b|soul|funk|quiet storm|motown/i, 'rnb'],
    [/hip hop|rap|trap|drill|grime/i, 'hiphop'],
    [/indie|bedroom|shoegaze|dream pop|slowcore/i, 'indie'],
    [/house|techno|electronic|edm|garage|dubstep|drum and bass|trance|electronica/i, 'electronic'],
    [/lo-?fi|ambient|chill|acoustic|folk|jazz|bossa/i, 'chill'],
    [/rock|metal|punk|grunge|emo/i, 'rock'],
    [/pop|dance/i, 'pop'],
  ];

  /* How strongly each action counts. Negative = "less like this". */
  const WEIGHTS = { save: 3, complete: 2, listen: 1, skip: -0.5, dislike: -4 };
  const TOP_CACHE_MS = 6 * 60 * 60 * 1000;

  const empty = () => ({ stations: {}, artists: {}, blocked: [], artistStation: {} });
  const load = () => ({ ...empty(), ...Store.get('taste', {}) });
  const clamp = (n) => Math.max(-10, Math.min(20, n));
  function save(t) {
    /* Keep the artist table from growing forever: drop the weakest opinions. */
    const names = Object.keys(t.artists);
    if (names.length > 400) {
      names.sort((a, b) => Math.abs(t.artists[a]) - Math.abs(t.artists[b]))
        .slice(0, names.length - 400)
        .forEach((n) => { delete t.artists[n]; delete t.artistStation[n]; });
    }
    Store.set('taste', t);
    emitChange('taste');
  }

  const primaryArtist = (track) => String((track && track.artist) || '').split(', ')[0];
  const stationFromLabel = (label) => Object.keys(STATIONS).find((k) => STATIONS[k].label === label) || '';
  function stationFromGenres(genres) {
    for (const g of genres || []) for (const [rule, key] of GENRE_RULES) if (rule.test(g)) return key;
    return '';
  }
  function stationFromSeeds(name) {
    const needle = `artist:"${name}"`.toLowerCase();
    return Object.keys(STATIONS).find((k) => STATIONS[k].seeds.some((s) => s.toLowerCase() === needle)) || '';
  }

  /* ---------------- learning from what you do ---------------- */

  function signal(track, kind) {
    const delta = WEIGHTS[kind];
    const artist = primaryArtist(track);
    if (!delta || !artist) return;
    const t = load();
    const key = stationFromLabel(track.genre) || t.artistStation[artist] || stationFromSeeds(artist);
    t.artists[artist] = clamp((t.artists[artist] || 0) + delta);
    if (key) {
      t.stations[key] = clamp((t.stations[key] || 0) + delta * 0.6);
      if (!t.artistStation[artist]) t.artistStation[artist] = key;
    }
    if (kind === 'dislike' && !t.blocked.includes(artist)) t.blocked.push(artist);
    save(t);
  }

  const isBlocked = (track) => load().blocked.includes(primaryArtist(track));

  function unblock(name) {
    const t = load();
    t.blocked = t.blocked.filter((n) => n !== name);
    t.artists[name] = 0;
    save(t);
    emitChange('taste-reset');
  }

  function reset() {
    save(empty());
    Store.set('topArtists', null); // re-read your Spotify top artists too
    emitChange('taste-reset');
  }

  /* ---------------- your Spotify top artists ---------------- */

  const cachedTop = () => (Store.get('topArtists', null) || { items: [] }).items;

  async function refreshTop() {
    const cached = Store.get('topArtists', null);
    if (cached && Date.now() - cached.at < TOP_CACHE_MS) return cached.items;
    try {
      const items = await Spotify.topArtists();
      Store.set('topArtists', { at: Date.now(), items });
      return items;
    } catch (err) {
      return cached ? cached.items : [];
    }
  }

  /* ---------------- building the "For you" seed list ---------------- */

  function seeds() {
    const t = load();
    const top = cachedTop().filter((a) => !t.blocked.includes(a.name));

    /* Which stations do your top artists live in? Higher-ranked artists count more. */
    const boost = {};
    top.forEach((a, i) => {
      const key = stationFromGenres(a.genres) || stationFromSeeds(a.name) || t.artistStation[a.name];
      if (key) boost[key] = (boost[key] || 0) + (i < 5 ? 2 : 1);
    });
    const personal = top.length > 0 || Object.values(t.stations).some((s) => s > 0);

    const out = [];
    for (const [key, st] of Object.entries(STATIONS)) {
      const score = t.stations[key] || 0;
      if (score <= -3) continue; // you've rejected this station enough times
      /* Without any taste data, every station counts the same (a plain mix).
         With taste data, unrelated stations keep a small "exploration"
         share (0.25) so the feed can still surprise you. */
      const weight = personal ? 0.25 + (boost[key] || 0) + Math.max(0, score) / 2 : 1;
      const n = Math.min(st.seeds.length, Math.max(1, Math.round(weight * 3)));
      shuffle(st.seeds).slice(0, n).forEach((q) => out.push({ q, genre: st.label }));
    }

    const labelFor = (name, genres) => {
      const key = stationFromGenres(genres) || stationFromSeeds(name) || t.artistStation[name];
      return key ? STATIONS[key].label : '';
    };
    const artistSeed = (name, genres) => ({ q: `artist:"${name.replace(/"/g, '')}"`, genre: labelFor(name, genres) });

    /* A few of your own top artists, for familiar picks between discoveries. */
    top.slice(0, 6).forEach((a) => out.push(artistSeed(a.name, a.genres)));

    /* The exact Spotify genres your top artists belong to: the best route
       to "sounds like what I listen to" without a recommendations API. */
    const genreCount = {};
    top.forEach((a) => (a.genres || []).forEach((g) => { genreCount[g] = (genreCount[g] || 0) + 1; }));
    Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .forEach(([g]) => out.push({ q: `genre:"${g}"`, genre: (STATIONS[stationFromGenres([g])] || {}).label || '' }));

    /* Artists you've loved inside Earshot. */
    Object.entries(t.artists).filter(([n, s]) => s >= 3 && !t.blocked.includes(n))
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([n]) => out.push(artistSeed(n, [])));

    return shuffle(out);
  }

  /* For the Stats page. */
  function summary() {
    const t = load();
    const leaning = Object.entries(t.stations).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => STATIONS[k].label);
    const avoiding = Object.entries(t.stations).filter(([, s]) => s <= -3).map(([k]) => STATIONS[k].label);
    return { top: cachedTop(), leaning, avoiding, blocked: t.blocked.slice() };
  }

  return { STATIONS, signal, isBlocked, unblock, reset, refreshTop, seeds, summary, primaryArtist };
})();
