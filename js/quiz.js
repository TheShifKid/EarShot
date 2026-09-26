/* ------------------------------------------------------------------
   quiz.js — ten questions built from YOUR listening history.

   Question types:
     name   → hear a snippet, pick the title
     artist → see a title, pick the artist
     cover  → see a title, pick the album art
   Wrong options ("distractors") come from your history first, then from
   songs the feed showed you (Pool), then from your saved songs.
   ------------------------------------------------------------------ */

const QuizView = (() => {
  const ROUND = 10;
  const MIN_HISTORY = 4;
  const TYPES = ['name', 'artist', 'cover'];

  /* What makes two options "the same" for each question type. Two songs by
     the same artist would make two identical artist buttons, so we compare
     on this key rather than on track id. */
  const KEY = {
    name: (t) => normalizeTitle(t.title),
    artist: (t) => String(t.artist).toLowerCase().trim(),
    cover: (t) => t.artwork || '',
  };

  let root;
  let game = null; // { questions, index, score, answered }

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

  function buildRound() {
    const history = Listens.all().filter((t) => t.uri);
    const historyIds = new Set(history.map((t) => t.id));
    const others = uniqueById([Pool.all(), Saved.all()]).filter((t) => !historyIds.has(t.id));

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

  function renderIntro() {
    const heard = Listens.all().length;
    const best = Store.get('quizBest', null);
    if (heard < MIN_HISTORY) {
      const need = MIN_HISTORY - heard;
      root.innerHTML = `
        <div class="empty">
          <p class="empty-big">Your ears need a warm-up.</p>
          <p>The quiz is built from songs you've actually listened to. Let ${need} more song${need === 1 ? '' : 's'} play for at least 5 seconds each, then come back.</p>
          <div class="meter" aria-hidden="true">${Array.from({ length: MIN_HISTORY }, (_, i) => `<span class="${i < heard ? 'on' : ''}"></span>`).join('')}</div>
          <p class="muted small">${heard} of ${MIN_HISTORY} heard</p>
          <a class="pill-btn" href="#feed">Go listen</a>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="quiz-intro">
        <p class="lede">Ten questions pulled from the ${heard} song${heard === 1 ? '' : 's'} you've heard. Name that tune, match the artist, spot the cover.</p>
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

    if (action === 'start') {
      const questions = buildRound();
      if (!questions) {
        toast('Not enough variety yet. Scroll the feed a bit more first.');
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
    if (Player.owner() === 'quiz') Player.pause();
    Player.setVeil(false);
    if (game && game.finished) game = null; // next visit shows the intro again
  }

  return { init, render, onHide };
})();
