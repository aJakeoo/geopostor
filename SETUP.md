# GEOPOSTOR — Setup Guide

Photostor's sibling: a **map-based** social deduction game. Everyone drops a pin somewhere on Earth associated with a secret word — except the imposter, who only knows the category and has to bluff with a plausible pin. GeoGuessr meets Among Us.

---

## The map works out of the box

Geopostor uses **Leaflet + CartoDB Dark Matter** tiles, which are completely free and need **no API key and no setup**. The dark tiles match the Field Atlas theme. Map tiles load straight from the CDN. When you deploy and open the app, the map just works. There is nothing you have to configure for basic play.

If you ever want to switch tile providers, edit `makeBaseMap()` in `app.js` — it's a single `L.tileLayer(...)` call.

The pin previews (the image shown when you place or inspect a pin) also work with zero setup — they default to a free **satellite view** (Esri World Imagery). Aerial, not street-level, but global and instant.

---

## Optional: true 360° Street View previews

If you want real Google **Street View** panoramas instead of the satellite fallback, here's the full process. Budget ~10 minutes. It's free to run, but Google requires a billing account on file (they won't charge for Embed API usage).

**Step 1 — Create a Google Cloud project**
1. Go to https://console.cloud.google.com
2. Sign in with a Google account.
3. Top bar, click the project dropdown → **New Project**. Name it "Geopostor". Create.
4. Make sure that new project is selected in the top bar.

**Step 2 — Enable billing** (required to issue Maps keys; Embed API itself is free)
1. Left menu (☰) → **Billing**.
2. **Link a billing account** → add a credit card if you don't have one. You will not be charged for Embed API usage — it's free and unmetered.

**Step 3 — Enable the Maps Embed API**
1. Left menu → **APIs & Services → Library**.
2. Search **"Maps Embed API"** → click it → **Enable**.

**Step 4 — Create an API key**
1. Left menu → **APIs & Services → Credentials**.
2. **Create Credentials → API key**.
3. Copy the key it gives you.

**Step 5 — (Recommended) restrict the key** so nobody else can use it
1. On the key you just made, click **Edit**.
2. Under **API restrictions** → choose **Restrict key** → check only **Maps Embed API**.
3. Under **Application restrictions** → **Websites** → add your GitHub Pages URL (e.g. `https://YOURNAME.github.io/*`). Save.

**Step 6 — Paste the key into Geopostor**
1. Open `app.js`.
2. Near the top, find:
   ```js
   const MAPS_EMBED_KEY = '';
   ```
3. Put your key between the quotes:
   ```js
   const MAPS_EMBED_KEY = 'AIza...your key...';
   ```
4. Save, push to GitHub. Pin previews now show true Street View.

> ⚠️ Like the Firebase key, this key will be visible in your public repo. The restrictions in Step 5 are what keep it safe — restrict it to the Embed API and your domain so it can't be abused.

---

## Firebase — no new setup

Geopostor reuses your existing `firebase-config.js` (same project as Photostor). It stores rooms in a separate **`georooms`** collection, so the two games never collide.

### Firestore rules

If you tightened your rules to only allow `/rooms/`, you must add `georooms` or Geopostor will be blocked. In Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, write: if roomId.matches('^[A-Z]{4}$');
    }
    match /georooms/{roomId} {
      allow read, write: if roomId.matches('^[A-Z]{4}$');
    }
    match /imposter_wins/{playerKey} {
      allow read, write: if true;
    }
  }
}
```

(If you're still on open test-mode rules, it works until they expire — but switch to the above before then.)

### Leaderboard collection: `imposter_wins`

A new top-level collection, `imposter_wins`, stores a running win count per
player name (no login). Each document is keyed by the player's name, lowercase
and trimmed, with `{ name, wins }`. When a session ends with an imposter win
(and `testMode` is off), every winning imposter's count is incremented by 1.
The home screen reads this collection live to show the "TOP IMPOSTERS" top-5
leaderboard and a personal "YOUR WINS" count for the last name you played
under (read from this browser tab's session storage).

---

## Deploy to its own GitHub Pages site

1. New GitHub repo, e.g. `geopostor`, **Public**.
2. Upload all files in this folder.
3. Settings → Pages → Deploy from branch → `main` / `root`.
4. Live at `https://YOURNAME.github.io/geopostor/`.
5. On phones: open the URL → Add to Home Screen.

---

## How to play

1. Host creates a room; everyone joins with the 4-letter code (min 3 players, or 2 in test mode).
2. Reveal: innocents see the **word + category**; the imposter sees only the **category**.
3. Everyone taps the map to drop a pin somewhere *associated* with the word. The word "Pizza" → pin Naples, NYC, Chicago. The word "Surfing" → Hawaii, Australia. Drag to fine-tune, then **SUBMIT PIN**.
4. All pins appear on a shared map with names, in a randomized discussion order. Tap any pin or name to inspect that spot (Street View or satellite).
5. Host opens the vote. Vote (changeable until everyone locks in). Eliminations, spectators, win conditions all work exactly like Photostor.

## How prompts work

Categories are broad themes; each holds several specific words. A round picks a category, then a random word inside it. Example categories: Transportation, Sports, Food & Drink, Industry, Nature, Animals, Weather, Music, History, Entertainment, Science & Space, Landmarks, US Culture, Outdoors, Fashion, Beverages. The imposter knowing "Transportation" still has to guess whether everyone got Subway, Airport, Ferry, etc. — that's the bluff.

---

## Host settings: imposters, timers & test mode

The host configures these in the lobby; everyone else sees a read-only mirror that updates live.

- **Imposters**: 1, 2, or 3 (default 1).
- **Discussion time**: 15 / 30 / 45 / 60 seconds (default **30s**). Once everyone submits a pin, this is how long the group has to talk it out before the host can open the vote — the **OPEN THE VOTE** button stays disabled and shows a countdown until it expires.
- **Vote time**: 30 / 60 / 90 / 120 seconds (default **60s**). A countdown badge in the top-right shows everyone how long the vote stays open. Voting closes automatically when the timer hits zero, or as soon as everyone has voted — whichever comes first. If the timer runs out with no votes cast, the round result shows "TIME'S UP — NO ONE VOTED" and no one is eliminated.
- **Test mode**: bypasses the 3-player minimum (2 players OK) and disables win conditions — useful for trying things out. The host ends the session manually with **END SESSION**.

All settings can be changed any time before **START SESSION** is pressed.

---

## CrazyGames interstitial ads (optional)

Geopostor ships with placeholder ad plumbing, off by default (`CRAZY_GAMES_ENABLED = false` in `app.js`). A full-screen "Advertisement" overlay with a spinner is wired up at three points — after creating/joining a room, when leaving a room, and when the host starts a new session — but it just shows briefly and disappears until you enable real ads. The overlay never blocks game state: the lobby/game keeps running underneath, it just visually and interactively blocks the player until the ad finishes.

To wire up real CrazyGames ads once you're ready to publish there:

**Step 1 — Add the SDK script tag**
1. Sign in to your CrazyGames developer account and open your game's dashboard to get the SDK `<script>` tag (e.g. `https://sdk.crazygames.com/crazygames-sdk-v3.js`).
2. Add it to `index.html`, just before `<script type="module" src="app.js">`.

**Step 2 — Initialize the SDK**
Per CrazyGames' docs, call their init function (typically `window.CrazyGames.SDK.init()`) early — e.g. at the top of `app.js` — and make sure it resolves before the game starts showing ads.

**Step 3 — Replace the placeholder in `showInterstitialAd()`**
In `app.js`, find:
```js
function showInterstitialAd(adFree) {
  return new Promise(resolve => {
    if (adFree || !CRAZY_GAMES_ENABLED) { resolve(); return; }
    const overlay = $('ad-overlay');
    overlay.hidden = false;
    // TODO: once the CrazyGames SDK is loaded ...
    setTimeout(() => { overlay.hidden = true; resolve(); }, 1200);
  });
}
```
Replace the `setTimeout(...)` line with the real ad request:
```js
window.CrazyGames.SDK.ad.requestAd('midgame', {
  adFinished: () => { overlay.hidden = true; resolve(); },
  adError:    () => { overlay.hidden = true; resolve(); },
  adStarted:  () => {},
});
```

**Step 4 — Flip the flag**
Near the top of `app.js`:
```js
const CRAZY_GAMES_ENABLED = false;
```
Change to `true`. Ads now show at all three trigger points for any room that isn't ad-free.

---

## Ad-free code (optional)

Set a secret code that makes a room permanently ad-free for everyone in it, for the room's entire lifetime:

1. Open `app.js`, find:
   ```js
   const AD_FREE_CODE = '';
   ```
2. Set it to any string, e.g. `const AD_FREE_CODE = 'mysecretcode';`.
3. On the **CREATE A ROOM** screen there's an optional "Ad-free code" field. If the host enters a value matching `AD_FREE_CODE` exactly, the room is created with `adFree: true` — no one in that room (host included) ever sees an interstitial ad, regardless of `CRAZY_GAMES_ENABLED`. The lobby shows an "Ads: off" / "Ad-free code: accepted" indicator so the host can confirm it worked.
4. Leave `AD_FREE_CODE` set to `''` to disable this feature entirely — the field has no effect either way.

— built for Jake
