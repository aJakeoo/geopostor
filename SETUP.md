# GEOPOSTOR — Setup Guide

Photostor's sibling: a **map-based** social deduction game. Everyone drops a pin somewhere on Earth associated with a secret word — except the imposter, who only knows the category and has to bluff with a plausible pin. GeoGuessr meets Among Us.

---

## The map works out of the box

Geopostor uses **Leaflet + OpenStreetMap**, which is completely free and needs **no API key and no setup**. Map tiles load straight from the CDN. When you deploy and open the app, the map just works. There is nothing you have to configure for basic play.

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
  }
}
```

(If you're still on open test-mode rules, it works until they expire — but switch to the above before then.)

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

— built for Jake
