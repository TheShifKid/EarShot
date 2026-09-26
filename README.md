# Earshot

**A TikTok-style music discovery feed, powered by Spotify.** Swipe (or press ↓) through full-screen song cards; each one starts playing when it snaps into view. Heart the ones you like, and the site keeps a listening history that powers stats and a quiz about the music you've actually heard.

It's plain HTML, CSS and vanilla JavaScript: no framework, no build step, no backend. It runs free on GitHub Pages.

## Features

- **Feed**: full-screen scroll-snap cards with the cover art blurred into each card's background. Auto-play and pause via IntersectionObserver. Stations (Mix, Pop, Hip-hop, Rock, Indie, Electronic, R&B, Chill) plus search. Infinite loading with duplicate filtering. Keyboard: ↑/↓ (or J/K) to move, Space to play/pause.
- **Library**: your saved songs. Play one, open it in Spotify, or remove it.
- **Stats**: songs heard, total listens, top artists, top genres, recently heard. A song counts as "heard" after 5 seconds of playback.
- **Quiz**: 10 questions built from your history: *Name that song* (hear a snippet), *Who's the artist?*, and *Which album cover?*. Needs at least 4 heard songs. Your best score is saved.
- All your data (library, history, scores, login) stays in your browser's `localStorage`. There's no account and no server.

## How it uses Spotify (and its limits)

- **Login:** each visitor connects their own Spotify account using the *Authorization Code with PKCE* flow. That flow is designed for sites that can't keep a secret, so the only thing in the code is your app's public **Client ID**.
- **Search:** the Spotify Web API finds the songs for each station.
- **Playback:** Spotify no longer gives new apps raw 30-second preview files. Songs play through **Spotify's official embedded player** (the small player docked above the tab bar), controlled with Spotify's iFrame API. Visitors logged in to Spotify in the same browser may hear full tracks; everyone else hears 30-second previews.
- **Development mode:** new Spotify apps start in *development mode*. Only Spotify accounts you add by hand under **User Management** can log in, and Spotify caps that list at a small number of users. Opening the site to everyone requires applying for an extended quota in the Spotify dashboard.
- **Autoplay:** browsers only allow sound after a tap, hence the "Tap to start" screen. Safari on iPhone is the strictest: if a song doesn't start by itself, the site asks for another tap. You can also press play in the embed.

## Spotify setup (one time, about 5 minutes)

1. Go to <https://developer.spotify.com/dashboard> and log in with your Spotify account.
2. Click **Create app**. Give it any name and description (e.g. "Earshot").
3. Under **Redirect URIs**, add the address(es) the site will run from, **exactly**, including the trailing slash:
   - GitHub Pages: `https://YOUR-USERNAME.github.io/YOUR-REPO/`
   - Local testing (optional): `http://127.0.0.1:5500/` (Spotify doesn't accept `localhost`, so use `127.0.0.1`.)
4. Under **Which API/SDKs are you planning to use?**, tick **Web API** (and **Web Playback SDK** if it's offered; harmless). Save.
5. Open the app's **Settings** and copy the **Client ID** (32 letters and numbers). Don't copy the Client *Secret*: it's never needed, and it must never go into this repo.
6. Open **User Management** and add the Spotify email address of everyone who should be able to log in, including yourself.
7. Put the Client ID in `js/config.js`:

   ```js
   window.EARSHOT_CONFIG = {
     spotifyClientId: 'paste-your-client-id-here',
   };
   ```

   (You can also leave it empty. The site then asks for the ID on screen and remembers it in that browser only.)

## Publish on GitHub Pages, step by step

1. **Create the repository.** On github.com, click **+ → New repository**. Name it (e.g. `earshot`), make it **Public**, and *don't* add a README (this folder already has one). Click **Create repository**.
2. **Push this folder.** In a terminal inside this folder (this project already has a first commit):

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/earshot.git
   ```

   ```bash
   git branch -M main
   ```

   ```bash
   git push -u origin main
   ```

3. **Turn on Pages.** In the repo on GitHub, go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, set **Branch** to `main`, and set the folder to `/ (root)`. Click **Save**.
4. **Wait a minute**, then refresh that Settings page. It shows your site's address, e.g. `https://YOUR-USERNAME.github.io/earshot/`.
5. **Check the redirect URI.** Make sure that exact address (with the trailing slash) is in your Spotify app's Redirect URIs (Setup step 3).
6. Open the address, press **Connect Spotify**, and start swiping.

To update the site later, commit and `git push`. GitHub Pages redeploys automatically.

## Running it locally

The Spotify login needs a proper web address, so opening the file directly (`file://`) won't work. Start a tiny server in this folder:

```bash
python -m http.server 5500 --bind 127.0.0.1
```

Then open <http://127.0.0.1:5500/>. Make sure `http://127.0.0.1:5500/` is in your Spotify app's Redirect URIs.

## Files

| File | What it does |
| --- | --- |
| `index.html` | App shell: the four views, the setup/login/"Tap to start" gate, the Spotify dock, the tab bar |
| `style.css` | The whole design: tokens, scroll-snap feed, cards, pages, reduced-motion rules |
| `js/config.js` | **Your Spotify Client ID goes here** |
| `js/util.js` | Small helpers: HTML escaping, shuffle, toasts, icons |
| `js/storage.js` | localStorage wrapper that never throws, plus saved songs, history and song pool |
| `js/spotify.js` | PKCE login, token refresh, Web API search, artist genres |
| `js/player.js` | The single Spotify embed: play/pause, listen counting, quiz snippets |
| `js/feed.js` | The feed: stations, infinite loading, de-duplication, IntersectionObserver autoplay, keyboard |
| `js/library.js`, `js/stats.js`, `js/quiz.js` | The other three views |
| `js/app.js` | Boot and hash-based routing between views |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is (skip its Jekyll processing) |

The **Stats** page also has a "How this site works" panel explaining the main techniques in plain language.

## Troubleshooting

- **"INVALID_CLIENT: Invalid redirect URI"** on the Spotify page: the address in your browser doesn't exactly match a Redirect URI in the dashboard. Check the trailing slash and `http` vs `https`.
- **403 errors / "Spotify refused the request"**: the Spotify account you logged in with isn't in the app's **User Management** list.
- **Songs don't start by themselves** (often on iPhone): tap play once, either on the card or in the Spotify player.
- **Some songs get skipped**: the site skips tracks that won't play in your country.
