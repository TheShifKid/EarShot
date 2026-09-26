/* ------------------------------------------------------------------
   quiz.js — ten questions about the music YOU play on Spotify.

   The answers come from your real Spotify listening: recently played
   songs plus your top songs of the last month, half-year and year
   (read-only, fetched from Spotify and cached here for 30 minutes).
   New songs you only met in Earshot's feed are never the answer.

   Question types:
     name   → hear a snippet, pick the title
     artist → see a title, pick the artist
     cover  → see a title, pick the album art
   Wrong options ("distractors") come from your Spotify songs first, then
   from songs the feed showed you, so they look plausible.
   ------------------------------------------------------------------ */

const QuizView = (() => {
  const ROUND = 10;
  const MIN_HISTORY = 4;
  const TYPES = ['name', 'artist', 'cover'];
  const CACHE_MS = 30 * 60 * 1000;

  /* What makes two options "the same" for each question type. Two songs by
     the same artist would make two identical artist buttons, so we compare
     on this key rather than on track id. */
  const KEY = {
    name: (t) => normalizeTitle(t.title),
    artist: (t) => String(t.artist).toLowerCase().trim(),
    cover: (t) => t.artwork || '',
  };

  let root;
  let game = null;      // { questions, index, score, answered }
  let source = null;    // your Spotify songs, once loaded
  let loadId = 0;       // ignores slow loads that finish after you left

  function init() {
    root = $('#quiz-root');
    root.addEventListener('click', onClick);
    Player.subscribe((type, t, owner) => { if (owner === 'quiz') syncSnippetButton(); });
  }

  /* ---------------- building a round ---------------- */

  function uniqueById(lists) {
    const seen = new Set();
    return lists.flat().filter((t) => t && t.uri && !seen.has(t.id) && seen.add(t.id));
  }

  function buildQuestion(answer, type, history, others) {
    const key = KEY[type];
    const used = new Set([key(answer)]);
    const picks = [];
    /* History first (shuffled), then everything else: "from my history when
       possible, otherwise from other songs". */
    for (const cand of [...shuffle(history), ...shuffle(others)]) {
      if (picks.length === 3) break;
      const k = key(cand);
      if (!k || used.has(k)) continue;
      used.add(k);
      picks.push(cand);
    }
    if (picks.length < 3) return null;
    return { type, answer, options: shuffle([answer, ...picks]) };
  }

  /* Recently played + top songs, merged without duplicates. */
  async function spotifySongs() {
    const cached = Store.get('spotifySongs', null);
    if (cached && Date.now() - cached.at < CACHE_MS && cached.items.length) return cached.items;
    const results = await Promise.allSettled([
      Spotify.recentTracks(),
      Spotify.topTracks('short_term'),
      Spotify.topTracks('medium_term'),
      Spotify.topTracks('long_term'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    if (!ok.length) {
      if (cached && cached.items.length) return cached.items;
      throw results[0].reason;
    }
    const seenKeys = new Set();
    const items = uniqueById(ok.map((r) => r.value))
      .filter((t) => { const k = dedupeKey(t); return !seenKeys.has(k) && seenKeys.add(k); })
      .slice(0, 250)
      .map(slimTrack);
    Store.set('spotifySongs', { at: Date.now(), items });
    return items;
  }

  function buildRound(history) {
    const historyIds = new Set(history.map((t) => t.id));
    const others = uniqueById([Listens.all(), Pool.all(), Saved.all()]).filter((t) => !historyIds.has(t.id));

    /* Walk through your history in random order; if you've heard fewer than
       10 songs, go round again so every round still has 10 questions. */
    const questions = [];
    let order = shuffle(history);
    let guard = 0;
    while (questions.length < ROUND && guard++ < 200) {
      if (!order.length) order = shuffle(history);
      const answer = order.pop();
      const prev = questions[questions.length - 1];
      for (const type of shuffle(TYPES)) {
        if (prev && prev.answer.id === answer.id && prev.type === type) continue;
        const q = buildQuestion(answer, type, history.filter((t) => t.id !== answer.id), others);
        if (q) { questions.push(q); break; }
      }
    }
    return questions.length === ROUND ? questions : null;
  }

  /* ---------------- rendering ---------------- */

  function render() {
    if (game && !game.finished) return renderQuestion(false);
    if (game && game.finished) return renderResult();
    renderIntro();
  }

  async function renderIntro() {
    const id = ++loadId;
    const best = Store.get('quizBest', null);

    if (!Spotify.isLoggedIn() || !Spotify.hasScopes()) {
      root.innerHTML = `
        <div class="empty">
          <p class="empty-big">Connect Spotify first.</p>
          <p>The quiz asks about the songs you actually play on Spotify, so it needs read-only access to your listening. Connect from the Feed tab.</p>
          <a class="pill-btn" href="#feed">Go to the feed</a>
        </div>`;
      return;
    }

    root.innerHTML = '<p class="lede">Reading your Spotify listening…</p>';
    try {
      source = await spotifySongs();
    } catch (err) {
      if (id !== loadId) return;
      root.innerHTML = `
        <div class="empty">
          <p class="empty-big">Couldn’t read your Spotify listening.</p>
          <p>${escapeHtml(err.message)}</p>
          <button type="button" class="pill-btn" data-action="retry">Try again</button>
        </div>`;
      return;
    }
    if (id !== loadId) return;

    const n = source.length;
    if (n < MIN_HISTORY) {
      root.innerHTML = `
        <div class="empty">
          <p class="empty-big">Not enough listening yet.</p>
          <p>Spotify only has ${n} song${n === 1 ? '' : 's'} in your recent and top lists. Play a few more songs on Spotify and come back.</p>
          <div class="meter" aria-hidden="true">${Array.from({ length: MIN_HISTORY }, (_, i) => `<span class="${i < n ? 'on' : ''}"></span>`).join('')}</div>
          <p class="muted small">${n} of ${MIN_HISTORY} songs</p>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="quiz-intro">
        <p class="lede">Ten questions about the ${n} songs you’ve been playing on Spotify: your recent plays and your all-time favourites. Name that tune, match the artist, spot the cover.</p>
        ${best ? `<p class="best">Best score <strong>${best.score}/10</strong></p>` : ''}
        <button type="button" class="pill-btn pill-btn-big" data-action="start">Start the quiz</button>
      </div>`;
  }

  function prompts(q) {
    const title = `<span class="q-subject">“${escapeHtml(q.answer.title)}”</span>`;
    if (q.type === 'name') return { kicker: 'Name that song', html: '<p class="q-text">Listen, then pick the title.</p>' };
    if (q.type === 'artist') return { kicker: 'Who’s the artist?', html: `<p class="q-text">Who made ${title}?</p>` };
    return { kicker: 'Which album cover?', html: `<p class="q-text">Which cover goes with ${title}?</p>` };
  }

  function renderQuestion(autoplay) {
    const q = game.questions[game.index];
    const p = prompts(q);
    const letters = 'ABCD';
    const options = q.type === 'cover'
      ? `<div class="options options-covers">${q.options.map((o, i) => `
          <button type="button" class="opt opt-cover" data-action="answer" data-id="${escapeHtml(o.id)}" aria-label="Cover ${letters[i]}">
            <img src="${escapeHtml(o.artwork)}" alt="" width="300" height="300">
            <span class="opt-letter" aria-hidden="true">${letters[i]}</span>
          </button>`).join('')}</div>`
      : `<div class="options">${q.options.map((o, i) => `
          <button type="button" class="opt" data-action="answer" data-id="${escapeHtml(o.id)}">
            <span class="opt-letter" aria-hidden="true">${letters[i]}</span>
            <span class="opt-text">${escapeHtml(q.type === 'artist' ? o.artist : o.title)}</span>
          </button>`).join('')}</div>`;

    root.innerHTML = `
      <div class="q">
        <div class="q-top">
          <span>Question ${game.index + 1} / ${ROUND}</span>
          <span>Score ${game.score}</span>
        </div>
        <div class="q-progress" aria-hidden="true"><span style="width:${(game.index / ROUND) * 100}%"></span></div>
        <p class="kicker">${p.kicker}</p>
        ${p.html}
        ${q.type === 'name' ? `<button type="button" class="snippet-btn" data-action="snippet">${Icons.play}<span>Play snippet</span></button>` : ''}
        ${options}
        <p class="q-feedback" role="status" aria-live="polite"></p>
        <button type="button" class="pill-btn q-next" data-action="next" hidden>${game.index + 1 === ROUND ? 'See my score' : 'Next question'}</button>
      </div>`;

    /* Hide the Spotify embed's title while you guess (see player.js). */
    Player.setVeil(q.type === 'name');
    if (q.type === 'name' && autoplay) playSnippet();
    const focusTarget = root.querySelector('.snippet-btn') || root.querySelector('.opt');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  /* Play ~6 seconds from a random point in the first 20 seconds. */
  function playSnippet() {
    const q = game.questions[game.index];
    Player.play(q.answer, 'quiz', { start: 3 + Math.random() * 17, duration: 6 });
  }

  function syncSnippetButton() {
    const btn = root && root.querySelector('.snippet-btn');
    if (!btn) return;
    const playing = Player.isPlaying() && Player.owner() === 'quiz';
    btn.innerHTML = playing ? `${Icons.pause}<span>Playing…</span>` : `${Icons.replay}<span>Play snippet</span>`;
    btn.classList.toggle('is-playing', playing);
  }

  function answer(btn) {
    if (game.answered) return;
    game.answered = true;
    const q = game.questions[game.index];
    const right = btn.dataset.id === String(q.answer.id);
    if (right) game.score++;

    $$('.opt', root).forEach((o) => {
      o.disabled = true;
      if (o.dataset.id === String(q.answer.id)) o.classList.add('is-correct');
    });
    if (!right) btn.classList.add('is-wrong');
    Player.setVeil(false);

    const reveal = `“${q.answer.title}” by ${q.answer.artist}`;
    $('.q-feedback', root).textContent = right ? `Correct! ${reveal}.` : `Not quite. It was ${reveal}.`;
    $('.q-top span:last-child', root).textContent = `Score ${game.score}`;
    const next = $('.q-next', root);
    next.hidden = false;
    next.focus();
  }

  function renderResult() {
    Player.setVeil(false);
    const best = Store.get('quizBest', null);
    const isNewBest = game.newBest;
    const verdict = game.score === 10 ? 'Perfect pitch.'
      : game.score >= 8 ? 'Serious ears.'
      : game.score >= 5 ? 'Solid listening.'
      : 'Keep the feed rolling.';
    root.innerHTML = `
      <div class="result">
        <p class="kicker">Final score</p>
        <p class="result-score">${game.score}<span>/10</span></p>
        <p class="result-verdict">${verdict}</p>
        <p class="best">${isNewBest ? '<strong>New best score!</strong>' : `Best score <strong>${best ? best.score : game.score}/10</strong>`}</p>
        <button type="button" class="pill-btn pill-btn-big" data-action="start">Play again</button>
      </div>`;
    root.querySelector('[data-action="start"]').focus({ preventScroll: true });
  }

  /* ---------------- flow ---------------- */

  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'retry') { renderIntro(); return; }
    if (action === 'start') {
      const questions = source ? buildRound(source) : null;
      if (!questions) {
        toast('Not enough variety in your songs for a full round yet.');
        return;
      }
      game = { questions, index: 0, score: 0, answered: false, finished: false };
      renderQuestion(true);
    } else if (action === 'snippet') {
      if (Player.isPlaying() && Player.owner() === 'quiz') Player.pause(); else playSnippet();
    } else if (action === 'answer') {
      answer(btn);
    } else if (action === 'next') {
      if (Player.owner() === 'quiz') Player.pause();
      game.index++;
      game.answered = false;
      if (game.index >= ROUND) finish();
      else renderQuestion(true);
    }
  }

  function finish() {
    game.finished = true;
    const best = Store.get('quizBest', null);
    game.newBest = !best || game.score > best.score;
    if (game.newBest) Store.set('quizBest', { score: game.score, date: Date.now() });
    renderResult();
    game = { ...game }; // keep showing the result if you leave and come back
  }

  /* Leaving the page mid-question: stop the snippet. */
  function onHide() {
    loadId++; // a load still in flight shouldn't draw over another page
    if (Player.owner() === 'quiz') Player.pause();
    Player.setVeil(false);
    if (game && game.finished) game = null; // next visit shows the intro again
  }

  return { init, render, onHide };
})();
