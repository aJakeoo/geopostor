// ============================================================
//  GEOPOSTOR — APP LOGIC + FIREBASE SYNC
//  Map-based social deduction. Keys go in firebase-config.js.
// ============================================================

import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, setDoc, updateDoc, onSnapshot, runTransaction,
  getDoc, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ============================================================
//  OPTIONAL — GOOGLE STREET VIEW for pin previews.
//  Leave '' to use the free satellite preview (no setup).
//  To enable true 360 Street View, paste a Google Maps Platform
//  API key with the "Maps Embed API" enabled. See SETUP.md.
// ============================================================
const MAPS_EMBED_KEY = '';

// ---------- Word bank: broad CATEGORIES, each with several specific
// pinnable WORDS. Everyone sees the category; only innocents see the
// word. The imposter knows the theme but must guess which specific
// thing everyone pinned — so they bluff a plausible location. ----------
const CATEGORIES = {
  'Car':   ['Dealership', 'Speedway', 'Highway', 'Repair Shop', 'Highway to ****'],
  'Sports':           ['Surfing', 'Skiing', 'Football', 'Golf', 'Motorsport', 'Climbing', 'Sailing', 'Marathon'],
  'Food & Drink':     ['Pizza', 'Wine', 'Coffee', 'BBQ', 'Sushi', 'Cheese', 'Tequila', 'Chocolate'],
  'Industry':         ['Oil', 'Tech', 'Automobiles', 'Coal', 'Fishing', 'Shipbuilding', 'Steel', 'Diamonds'],
  'Nature':           ['Volcanoes', 'Glaciers', 'Deserts', 'Rainforest', 'Waterfalls', 'Canyons', 'Reefs', 'Geysers'],
  'Animals':          ['Penguins', 'Sharks', 'Kangaroos', 'Pandas', 'Lions', 'Polar Bears', 'Camels', 'Elephants'],
  'Weather':          ['Hurricanes', 'Monsoons', 'Snow', 'Drought', 'Tornadoes', 'Fog'],
  'Music':            ['Jazz', 'Country', 'Reggae', 'K-Pop', 'Techno', 'Salsa', 'Opera'],
  'History':          ['Pyramids', 'Castles', 'Vikings', 'Gladiators', 'Samurai', 'Pharaohs', 'Revolution'],
  'Entertainment':    ['Movies', 'Casinos', 'Theme Parks', 'Theater', 'Carnival', 'Circus'],
  'Science & Space':  ['Rockets', 'Telescopes', 'Particle Physics', 'Robotics', 'Nuclear Power'],
  'Landmarks':        ['Skyscrapers', 'Bridges', 'Lighthouses', 'Statues', 'Temples', 'Stadiums'],
  'US Culture':       ['College Football', 'Route 66', 'Hollywood', 'Country Fair', 'Rodeo', 'Diners'],
  'Outdoors':         ['Camping', 'Hiking', 'Kayaking', 'Hunting', 'Hot Springs', 'National Parks'],
  'Fashion':          ['Haute Couture', 'Denim', 'Sneakers', 'Silk', 'Leather'],
  'Beverages':        ['Beer', 'Whiskey', 'Champagne', 'Rum', 'Sake'],
};
// Flattened {word, category} list for exclusion tracking.
const WORD_BANK = Object.entries(CATEGORIES).flatMap(
  ([category, words]) => words.map(word => ({ word, category }))
);

const ROUNDS_PER_SESSION = 3;

// ---------- Local state ----------
const state = {
  roomCode: null,
  playerId: null,
  playerName: null,
  isHost: false,
  unsub: null,
  room: null,
  imposters: 1,
  testMode: false,
  lastRoundSeen: 0,        // for resetting per-round local UI
  lastPhaseSeen: null,
  myPin: null,
};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];

function show(screenId) {
  screens.forEach(s => s.classList.toggle('active', s.id === screenId));
}
function isOn(id) { return $(id).classList.contains('active'); }

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O
  let c = '';
  for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}
function makeId() { return 'p_' + Math.random().toString(36).slice(2, 10); }

// ---------- Session persistence (per-tab, survives refresh + mobile backgrounding) ----------
const SESSION_KEY = 'geopostor.session.v1';
function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      roomCode: state.roomCode,
      playerId: state.playerId,
      playerName: state.playerName,
      isHost: state.isHost,
    }));
  } catch (e) { /* private mode, etc — ignore */ }
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}
function pickWord(excludeWords = []) {
  // Pick a category at random, then a specific word inside it. This is
  // what makes the category a CLUE rather than a near-giveaway: the
  // imposter knows the theme but not which word everyone actually got.
  const cats = Object.keys(CATEGORIES);
  const category = cats[Math.floor(Math.random() * cats.length)];
  const fresh = CATEGORIES[category].filter(w => !excludeWords.includes(w));
  const pool = fresh.length ? fresh : CATEGORIES[category];
  const word = pool[Math.floor(Math.random() * pool.length)];
  return { word, category };
}

// Pick a word AND generate 2 decoy words from the same category.
// The imposter sees all three (shuffled) — they know the theme and
// have real candidates to reason from, but don't know which is real.
// This is the main imposter balance fix.
function pickWordWithDecoys(excludeWords = []) {
  const { word, category } = pickWord(excludeWords);
  const siblings = CATEGORIES[category].filter(w => w !== word);
  // Shuffle siblings and take up to 2 as decoys
  const shuffled = siblings.sort(() => Math.random() - 0.5);
  const decoys = shuffled.slice(0, Math.min(2, shuffled.length));
  // Mix real word + decoys, shuffle so imposter can't guess by position
  const candidates = [word, ...decoys].sort(() => Math.random() - 0.5);
  return { word, category, candidates };
}
// Separate collection so Geopostor and Photostor never collide.
function roomRef(code) { return doc(db, 'georooms', code); }

// ---------- Stable ordering ----------
// Object key iteration order isn't guaranteed identical across devices,
// so we always sort players by join time (then id as tiebreaker). This
// makes vote-list order, the lobby player list, etc. identical for
// everyone and stops names from jumping around between renders.
function orderedPlayerIds(players) {
  return Object.keys(players || {}).sort((a, b) => {
    const ja = players[a]?.joinedAt ?? 0;
    const jb = players[b]?.joinedAt ?? 0;
    if (ja !== jb) return ja - jb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ---------- Seeded shuffle ----------
// For the showcase gallery we want a randomized order per round, but
// the order must be IDENTICAL on every device (otherwise people lose
// track of which image is being discussed). Solution: every client
// computes the same shuffle locally using a seed derived from the room
// code and round number — values everyone already shares via Firestore.
// No extra Firestore writes, perfect agreement across devices, fresh
// order each round.
function seededHash(str) {
  let h = 2166136261; // FNV-1a basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleSeeded(arr, seedString) {
  const out = arr.slice();
  const rand = mulberry32(seededHash(seedString));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============================================================
//  MAPS — Leaflet instances. Lazy-initialized because Leaflet
//  renders broken inside display:none containers; we init on first
//  show and invalidateSize() on each re-show.
// ============================================================
let submitMap = null, submitMarker = null;
let showcaseMap = null, showcaseMarkers = [];
let specMap = null, specMarkers = [];

function makeBaseMap(elId) {
  const m = L.map(elId, { worldCopyJump: true, zoomControl: true }).setView([25, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '(c) OpenStreetMap'
  }).addTo(m);
  return m;
}
function ensureSubmitMap() {
  if (!submitMap) {
    submitMap = makeBaseMap('submit-map');
    submitMap.on('click', (e) => placeMyPin(e.latlng));
    submitMap.on('click', hideSearchResults);
  }
  setTimeout(() => submitMap.invalidateSize(), 80);
}
function ensureShowcaseMap() {
  if (!showcaseMap) showcaseMap = makeBaseMap('showcase-map');
  setTimeout(() => showcaseMap.invalidateSize(), 80);
}
function ensureSpecMap() {
  if (!specMap) specMap = makeBaseMap('spec-map');
  setTimeout(() => specMap.invalidateSize(), 80);
}
function placeMyPin(latlng) {
  state.myPin = { lat: latlng.lat, lng: latlng.lng };
  if (!submitMarker) {
    submitMarker = L.marker(latlng, { draggable: true }).addTo(submitMap);
    submitMarker.on('dragend', () => placeMyPin(submitMarker.getLatLng()));
  } else {
    submitMarker.setLatLng(latlng);
  }
  $('btn-submit-image').disabled = false;
  renderPinPreview('submit-preview', latlng.lat, latlng.lng, 'Your pin');
}
// Street View (if MAPS_EMBED_KEY set) or free Esri satellite fallback.
function renderPinPreview(containerId, lat, lng, label) {
  const el = $(containerId);
  if (!el) return;
  el.hidden = false;
  const title = label ? `<div class="preview-label">${label}</div>` : '';
  if (MAPS_EMBED_KEY) {
    el.innerHTML = `${title}<iframe class="preview-frame" loading="lazy"
      referrerpolicy="no-referrer-when-downgrade" allowfullscreen
      src="https://www.google.com/maps/embed/v1/streetview?key=${MAPS_EMBED_KEY}&location=${lat.toFixed(6)},${lng.toFixed(6)}&fov=90"></iframe>`;
  } else {
    const d = 0.004;
    el.innerHTML = `${title}<img class="preview-frame" alt="satellite preview"
      src="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lng-d},${lat-d*0.7},${lng+d},${lat+d*0.7}&bboxSR=4326&size=640,440&format=jpg&f=image" />`;
  }
}

// ============================================================
//  PLACE SEARCH — optional Nominatim lookup so players can jump
//  the map to a region before tapping their exact pin location.
// ============================================================
let searchDebounce = null;

function hideSearchResults() {
  const list = $('submit-search-results');
  list.hidden = true;
  list.innerHTML = '';
}

async function runPlaceSearch(query) {
  const list = $('submit-search-results');
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`,
      { headers: { 'User-Agent': 'Geopostor/1.0' } }
    );
    const places = await res.json();
    list.innerHTML = '';
    if (!places.length) { hideSearchResults(); return; }
    places.forEach(place => {
      const li = document.createElement('li');
      li.textContent = place.display_name;
      li.onclick = () => {
        submitMap.setView([parseFloat(place.lat), parseFloat(place.lon)], 10);
        hideSearchResults();
        $('submit-search').blur();
      };
      list.appendChild(li);
    });
    list.hidden = false;
  } catch (e) {
    hideSearchResults();
  }
}

$('submit-search').addEventListener('input', (e) => {
  const query = e.target.value.trim();
  clearTimeout(searchDebounce);
  if (!query) { hideSearchResults(); return; }
  searchDebounce = setTimeout(() => runPlaceSearch(query), 350);
});

// ============================================================
//  HOME NAVIGATION
// ============================================================
$('btn-create').onclick = () => show('screen-create');
$('btn-join').onclick   = () => show('screen-join');
document.querySelectorAll('[data-back]').forEach(b => {
  b.onclick = () => show(b.dataset.back);
});

// ============================================================
//  CREATE ROOM
// ============================================================
$('btn-do-create').onclick = async () => {
  const name = $('input-name-create').value.trim();
  if (!name) { $('create-error').textContent = 'Enter your name first.'; return; }

  const code = makeCode();
  state.roomCode = code;
  state.playerId = makeId();
  state.playerName = name;
  state.isHost = true;

  const initial = {
    code,
    hostId: state.playerId,
    phase: 'lobby',
    imposters: 1,
    testMode: false,
    round: 0,
    roundsPerSession: ROUNDS_PER_SESSION,
    usedWords: [],
    createdAt: serverTimestamp(),
    players: {
      [state.playerId]: { name, joinedAt: Date.now(), eliminated: false }
    }
  };

  try {
    await setDoc(roomRef(code), initial);
    saveSession();
    subscribeRoom(code);
    show('screen-lobby');
  } catch (e) {
    $('create-error').textContent = 'Could not create room. Check Firebase setup.';
    console.error(e);
  }
};

// ============================================================
//  JOIN ROOM
// ============================================================
$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('btn-do-join').onclick = async () => {
  const code = $('input-code').value.trim().toUpperCase();
  const name = $('input-name-join').value.trim();
  $('join-error').textContent = '';

  if (code.length !== 4) { $('join-error').textContent = 'Room code is 4 letters.'; return; }
  if (!name) { $('join-error').textContent = 'Enter your name.'; return; }

  try {
    const snap = await getDoc(roomRef(code));
    if (!snap.exists()) { $('join-error').textContent = 'No room with that code.'; return; }
    if (snap.data().phase !== 'lobby') { $('join-error').textContent = 'That game already started.'; return; }

    state.roomCode = code;
    state.playerId = makeId();
    state.playerName = name;
    state.isHost = false;

    await updateDoc(roomRef(code), {
      [`players.${state.playerId}`]: { name, joinedAt: Date.now(), eliminated: false }
    });

    saveSession();
    subscribeRoom(code);
    show('screen-lobby');
  } catch (e) {
    $('join-error').textContent = 'Could not join. Check your connection.';
    console.error(e);
  }
};

// ============================================================
//  LIVE SUBSCRIPTION
// ============================================================
function subscribeRoom(code) {
  if (state.unsub) state.unsub();
  state.unsub = onSnapshot(roomRef(code), (snap) => {
    if (!snap.exists()) {
      clearSession();
      alert('The room was closed.');
      location.reload();
      return;
    }
    state.room = snap.data();
    render();
    // Any client tries to advance the game when conditions are met.
    // The transaction ensures only one actually wins.
    tryAdvancePhase().catch(err => console.warn('advance attempt:', err));
  });
}

// ============================================================
//  HOST SETTINGS
// ============================================================
$('imposter-seg').addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || !state.isHost) return;
  const n = parseInt(btn.dataset.imp, 10);
  state.imposters = n;
  [...$('imposter-seg').children].forEach(b => b.classList.toggle('active', b === btn));
  // Sync to room so joiners see it
  try { await updateDoc(roomRef(state.roomCode), { imposters: n }); } catch (e) { /* ignore */ }
});

$('input-test-mode').addEventListener('change', async (e) => {
  if (!state.isHost) return;
  state.testMode = e.target.checked;
  try { await updateDoc(roomRef(state.roomCode), { testMode: state.testMode }); } catch (e) { /* ignore */ }
});

$('btn-start').onclick = async () => {
  $('lobby-error').textContent = '';
  const playerIds = Object.keys(state.room.players || {});
  const minPlayers = state.testMode ? 2 : 3;

  if (playerIds.length < minPlayers) {
    $('lobby-error').textContent = `Need at least ${minPlayers} players${state.testMode ? ' (test mode)' : ''}.`;
    return;
  }
  if (state.imposters >= playerIds.length) {
    $('lobby-error').textContent = 'Too many imposters for this group.';
    return;
  }

  // Randomly assign imposters (sticky for the whole session)
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const imposterIds = shuffled.slice(0, state.imposters);

  const roles = {};
  playerIds.forEach(id => { roles[id] = imposterIds.includes(id) ? 'imposter' : 'innocent'; });

  // Reset eliminated flag for all players (new session)
  const playersUpdate = {};
  playerIds.forEach(id => {
    playersUpdate[`players.${id}.eliminated`] = false;
  });

  const first = pickWordWithDecoys();

  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'reveal',
      round: 1,
      currentWord: first.word,
      currentCategory: first.category,
      currentCandidates: first.candidates,
      usedWords: [first.word],
      roles,
      submissions: {},
      votes: {},
      lastRoundResult: null,
      ...playersUpdate
    });
  } catch (e) {
    $('lobby-error').textContent = 'Could not start.';
    console.error(e);
  }
};

// ============================================================
//  REVEAL → SUBMIT
// ============================================================
$('btn-to-submit').onclick = () => {
  show('screen-submit');
  ensureSubmitMap();
};

// ============================================================
//  SUBMIT IMAGE (with playtest fix for placeholder bleed)
// ============================================================
// ============================================================
//  SUBMIT PIN
// ============================================================
$('btn-submit-image').onclick = async () => {
  if (!state.myPin) return;
  $('btn-submit-image').disabled = true;
  try {
    await updateDoc(roomRef(state.roomCode), {
      [`submissions.${state.playerId}`]: {
        lat: state.myPin.lat, lng: state.myPin.lng, name: state.playerName
      }
    });
    $('submit-waiting').hidden = false;
  } catch (e) {
    console.error(e);
    alert('Submit failed - try again.');
    $('btn-submit-image').disabled = false;
  }
};

// ============================================================
//  SHOWCASE → host opens vote
// ============================================================
async function hostOpenVote() {
  await updateDoc(roomRef(state.roomCode), { phase: 'vote' });
}
$('btn-open-vote').onclick = hostOpenVote;
$('btn-spec-open-vote').onclick = hostOpenVote;

// ============================================================
//  VOTING — players can change or clear their vote until
//  everyone has voted (then the round auto-advances).
// ============================================================
async function castVote(targetId) {
  try {
    await updateDoc(roomRef(state.roomCode), {
      [`votes.${state.playerId}`]: targetId
    });
  } catch (e) {
    console.error(e);
    alert('Vote failed — try again.');
  }
}

async function clearMyVote() {
  try {
    await updateDoc(roomRef(state.roomCode), {
      [`votes.${state.playerId}`]: deleteField()
    });
  } catch (e) {
    console.error(e);
  }
}

// ============================================================
//  ROUND RESULT actions
// ============================================================
async function hostNextRound() {
  const r = state.room;
  const nextRound = r.round + 1;
  const next = pickWordWithDecoys(r.usedWords || []);
  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'reveal',
      round: nextRound,
      currentWord: next.word,
      currentCategory: next.category,
      currentCandidates: next.candidates,
      usedWords: [...(r.usedWords || []), next.word],
      submissions: {},
      votes: {},
      lastRoundResult: null
    });
  } catch (e) { console.error(e); }
}
$('btn-next-round').onclick = hostNextRound;
$('btn-spec-next-round').onclick = hostNextRound;

async function hostEndSession() {
  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'results',
      sessionWinner: 'ended',
    });
  } catch (e) { console.error(e); }
}
$('btn-end-session').onclick = hostEndSession;
$('btn-spec-end-session').onclick = hostEndSession;

// ============================================================
//  NEW SESSION (from final results screen)
// ============================================================
$('btn-play-again').onclick = async () => {
  // Wipe session-specific state; keep room + players
  try {
    const playersUpdate = {};
    Object.keys(state.room.players || {}).forEach(id => {
      playersUpdate[`players.${id}.eliminated`] = false;
    });
    await updateDoc(roomRef(state.roomCode), {
      phase: 'lobby',
      round: 0,
      currentWord: deleteField(),
      currentCategory: deleteField(),
      currentCandidates: deleteField(),
      usedWords: [],
      roles: deleteField(),
      submissions: deleteField(),
      votes: deleteField(),
      lastRoundResult: deleteField(),
      sessionWinner: deleteField(),
      ...playersUpdate
    });
  } catch (e) { console.error(e); }
  resetLocalUI();
};

function resetLocalUI() {
  state.myPin = null;
  if (submitMarker) { submitMarker.remove(); submitMarker = null; }
  const sp = $('submit-preview'); if (sp) { sp.hidden = true; sp.innerHTML = ''; }
  const shp = $('showcase-preview'); if (shp) { shp.hidden = true; shp.innerHTML = ''; }
  $('submit-waiting').hidden = true;
  $('btn-submit-image').disabled = true;
  $('vote-waiting').hidden = true;
}

// ============================================================
//  LEAVE
// ============================================================
async function leaveRoom() {
  clearSession();
  try {
    if (state.roomCode && state.playerId) {
      await updateDoc(roomRef(state.roomCode), {
        [`players.${state.playerId}`]: deleteField()
      });
    }
  } catch (e) { /* ignore */ }
  if (state.unsub) state.unsub();
  location.reload();
}
$('btn-leave').onclick = leaveRoom;
$('btn-leave-results').onclick = leaveRoom;

// ============================================================
//  TRANSACTION-BASED PHASE ADVANCE
//  This is the critical fix for the vote-freeze bug.
//  Any client can trigger an advance; the transaction guarantees
//  only one wins, no matter how many fire at once.
// ============================================================
async function tryAdvancePhase() {
  if (!state.roomCode || !state.room) return;
  const r = state.room;

  // Phase-specific advance triggers, evaluated locally then
  // re-checked inside the transaction for safety.
  const wantsAdvance =
    (r.phase === 'reveal' || r.phase === 'submit') ? checkSubmissionsComplete(r)
    : (r.phase === 'vote')                          ? checkVotesComplete(r)
    : false;

  if (!wantsAdvance) return;

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef(state.roomCode));
      if (!snap.exists()) return;
      const fresh = snap.data();

      // Re-verify inside the transaction
      if (fresh.phase === 'reveal' || fresh.phase === 'submit') {
        if (!checkSubmissionsComplete(fresh)) return;
        tx.update(roomRef(state.roomCode), { phase: 'showcase' });
        return;
      }
      if (fresh.phase === 'vote') {
        if (!checkVotesComplete(fresh)) return;
        const result = computeRoundResult(fresh);
        const update = {
          phase: 'roundResult',
          lastRoundResult: result,
        };
        // Apply elimination if someone was voted off
        if (result.eliminatedId) {
          update[`players.${result.eliminatedId}.eliminated`] = true;
        }
        // Determine if session is over (unless test mode)
        if (!fresh.testMode) {
          const eliminatedIds = new Set();
          Object.entries(fresh.players || {}).forEach(([id, p]) => {
            if (p.eliminated) eliminatedIds.add(id);
          });
          if (result.eliminatedId) eliminatedIds.add(result.eliminatedId);

          const aliveImposters = Object.entries(fresh.roles || {})
            .filter(([id, role]) => role === 'imposter' && !eliminatedIds.has(id));

          if (aliveImposters.length === 0) {
            update.sessionWinner = 'innocents';
            update.phase = 'results';
          } else if (fresh.round >= (fresh.roundsPerSession || ROUNDS_PER_SESSION)) {
            update.sessionWinner = 'imposters';
            update.phase = 'results';
          }
        }
        tx.update(roomRef(state.roomCode), update);
      }
    });
  } catch (e) {
    // Transaction conflicts are normal when multiple clients race; ignore.
    if (!String(e).includes('aborted')) console.warn(e);
  }
}

// Submissions are complete when every non-eliminated player has submitted.
function checkSubmissionsComplete(r) {
  const subs = r.submissions || {};
  const activePlayers = Object.entries(r.players || {})
    .filter(([id, p]) => !p.eliminated)
    .map(([id]) => id);
  return activePlayers.length > 0 && activePlayers.every(id => subs[id]);
}

// Votes are complete when every non-eliminated player has voted.
function checkVotesComplete(r) {
  const votes = r.votes || {};
  const activePlayers = Object.entries(r.players || {})
    .filter(([id, p]) => !p.eliminated)
    .map(([id]) => id);
  return activePlayers.length > 0 && activePlayers.every(id => votes[id]);
}

// Tally votes → who got the most? Return tie info if relevant.
function computeRoundResult(r) {
  const votes = r.votes || {};
  const tally = {};
  Object.values(votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });

  let topN = -1;
  let topIds = [];
  Object.entries(tally).forEach(([id, n]) => {
    if (n > topN) { topN = n; topIds = [id]; }
    else if (n === topN) { topIds.push(id); }
  });

  const tied = topIds.length > 1;
  const eliminatedId = tied ? null : topIds[0];
  const wasImposter = eliminatedId ? (r.roles?.[eliminatedId] === 'imposter') : false;

  return {
    tally,
    tied,
    eliminatedId,
    eliminatedName: eliminatedId ? (r.players?.[eliminatedId]?.name || '???') : null,
    wasImposter,
    word: r.currentWord || '',
  };
}

// ============================================================
//  RENDER — reacts to every room snapshot
// ============================================================
function render() {
  const r = state.room;
  if (!r) return;

  // ----- Lobby content (always populated) -----
  $('lobby-code').textContent = r.code;
  const players = r.players || {};
  const ids = orderedPlayerIds(players);
  $('player-count').textContent = `${ids.length} player${ids.length === 1 ? '' : 's'}`;

  const list = $('player-list');
  list.innerHTML = '';
  ids.forEach(id => {
    const li = document.createElement('li');
    const isH = id === r.hostId;
    const elim = players[id]?.eliminated;
    if (elim) li.classList.add('eliminated');
    li.innerHTML = `<span class="player-dot"></span>${players[id]?.name || '???'}` +
      (isH ? `<span class="host-tag">HOST</span>` : '') +
      (elim ? `<span class="elim-tag">OUT</span>` : '');
    list.appendChild(li);
  });

  $('host-settings').hidden = !state.isHost;
  $('joiner-settings').hidden = state.isHost;
  $('ro-imposters').textContent = r.imposters || 1;
  $('ro-testmode-row').hidden = !r.testMode;

  // Round badges everywhere they appear
  const total = r.roundsPerSession || ROUNDS_PER_SESSION;
  const badgeText = r.testMode ? `ROUND ${r.round || 1} · TEST` : `ROUND ${r.round || 1} / ${total}`;
  ['round-badge','round-badge-submit','round-badge-showcase','round-badge-vote','round-badge-result','round-badge-spec']
    .forEach(id => { const el = $(id); if (el) el.textContent = badgeText; });

  // Category chips (everyone sees these, all round long)
  const catText = `CATEGORY: ${r.currentCategory || '—'}`;
  ['submit-category','showcase-category'].forEach(id => {
    const el = $(id); if (el) el.textContent = catText;
  });

  // Detect round transition → reset per-round local UI
  if (r.round !== state.lastRoundSeen) {
    state.lastRoundSeen = r.round;
    resetLocalUI();
  }
  state.lastPhaseSeen = r.phase;

  // Am I eliminated? Spectator screen handles everything for me.
  const me = players[state.playerId];
  const iAmEliminated = me?.eliminated === true;

  // ----- Phase routing -----
  switch (r.phase) {
    case 'lobby':
      if (!['screen-lobby','screen-create','screen-join','screen-home'].some(isOn)) {
        show('screen-lobby');
      } else if (isOn('screen-results') || isOn('screen-round-result') || isOn('screen-spectator')) {
        show('screen-lobby');
      }
      break;

    case 'reveal':
      if (iAmEliminated) { showSpectator(); break; }
      renderReveal(r);
      if (!isOn('screen-submit')) show('screen-reveal');
      break;

    case 'submit':
    case 'showcase':
      if (iAmEliminated) { showSpectator(); break; }
      if (r.phase === 'showcase') {
        if (!isOn('screen-showcase')) show('screen-showcase');
        renderShowcase(r);
      } else {
        renderSubmitProgress(r);
      }
      break;

    case 'vote':
      if (iAmEliminated) { showSpectator(); break; }
      renderVote(r);
      if (!isOn('screen-vote')) show('screen-vote');
      break;

    case 'roundResult':
      if (iAmEliminated && !justEliminatedMe(r)) {
        showSpectator();
        break;
      }
      renderRoundResult(r);
      show('screen-round-result');
      break;

    case 'results':
      renderFinalResults(r);
      show('screen-results');
      break;
  }

  // Submission progress visible during reveal/submit
  if ((r.phase === 'reveal' || r.phase === 'submit') && !iAmEliminated) {
    const subs = r.submissions || {};
    const activeIds = Object.entries(players).filter(([id,p])=>!p.eliminated).map(([id])=>id);
    $('submit-progress').hidden = false;
    $('submit-progress').textContent = `${Object.keys(subs).length} / ${activeIds.length} submitted`;
  }
}

function justEliminatedMe(r) {
  return r.lastRoundResult && r.lastRoundResult.eliminatedId === state.playerId;
}

function renderReveal(r) {
  const myRole = (r.roles || {})[state.playerId];
  const card = $('reveal-card');
  const category = r.currentCategory || '—';
  $('reveal-category').textContent = `CATEGORY: ${category}`;
  if (myRole === 'imposter') {
    card.classList.add('imposter');
    $('reveal-eyebrow').textContent = 'YOU ARE THE';
    $('reveal-word').textContent = 'IMPOSTER';
    // Show candidate words so the imposter has real options to reason from.
    // One of these is the real word — they just don't know which.
    const candidates = r.currentCandidates || [];
    const hint = candidates.length
      ? `You don't know the exact word — but it's one of these: ${candidates.join(', ')}. Drop a pin that could fit any of them.`
      : `You don't know the exact word — but you know the category. Drop a pin that fits the theme and bluff convincingly.`;
    $('reveal-instruction').textContent = hint;
  } else {
    card.classList.remove('imposter');
    $('reveal-eyebrow').textContent = 'YOUR WORD';
    $('reveal-word').textContent = r.currentWord || '—';
    $('reveal-instruction').textContent =
      "Drop a pin somewhere on Earth associated with this word — but don't be too obvious, or you'll out yourself.";
  }
}

function renderSubmitProgress(r) {
  // Visual progress only — actual screen control happens in phase routing above
}

function renderShowcase(r) {
  ensureShowcaseMap();
  showcaseMarkers.forEach(m => m.remove());
  showcaseMarkers = [];

  const subs = r.submissions || {};
  const players = r.players || {};
  // Seeded shuffle: same discussion order on every device, fresh each round.
  // Seed includes player IDs so the order is unique per group — fixes the
  // bug where code+round alone produced the same order every time.
  const baseOrder = orderedPlayerIds(players);
  const seed = `${r.code}:${r.round || 0}:${baseOrder.join(',')}`;
  const shuffled = shuffleSeeded(baseOrder, seed);

  const legend = $('pin-legend');
  legend.innerHTML = '';
  const bounds = [];
  let idx = 0;

  shuffled.forEach(id => {
    const s = subs[id];
    if (!s) return;
    const name = players[id]?.name || s.name || '???';
    idx += 1;
    const mk = L.marker([s.lat, s.lng]).addTo(showcaseMap)
      .bindTooltip(name, { permanent: true, direction: 'top' });
    mk.on('click', () => renderPinPreview('showcase-preview', s.lat, s.lng, name));
    showcaseMarkers.push(mk);
    bounds.push([s.lat, s.lng]);

    const li = document.createElement('li');
    li.textContent = `${idx}. ${name}`;
    li.onclick = () => {
      showcaseMap.setView([s.lat, s.lng], Math.max(showcaseMap.getZoom(), 6));
      renderPinPreview('showcase-preview', s.lat, s.lng, name);
    };
    legend.appendChild(li);
  });

  if (bounds.length) showcaseMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });

  $('btn-open-vote').hidden = !state.isHost;
  $('discuss-waiting').hidden = state.isHost;
}

function renderVote(r) {
  const list = $('vote-list');
  list.innerHTML = '';
  const players = r.players || {};
  const votes = r.votes || {};
  const myVote = votes[state.playerId];

  // Stable order so names never jump around between renders or across devices.
  orderedPlayerIds(players).forEach(id => {
    const p = players[id];
    if (p.eliminated) return; // can't vote for eliminated players
    const li = document.createElement('li');
    if (id === state.playerId) li.classList.add('self');
    if (myVote === id) li.classList.add('selected');
    li.innerHTML = `<span class="player-dot"></span>${p.name}${id === state.playerId ? ' (you)' : ''}`;
    li.onclick = () => {
      if (myVote === id) {
        // Tapping your current pick clears the vote
        clearMyVote();
      } else {
        // Switch (or cast for the first time)
        castVote(id);
      }
    };
    list.appendChild(li);
  });

  // Live progress + change-your-mind hint
  const activeIds = orderedPlayerIds(players).filter(id => !players[id].eliminated);
  const voteCount = activeIds.filter(id => votes[id]).length;
  const waiting = $('vote-waiting');
  if (myVote) {
    waiting.hidden = false;
    waiting.textContent = `vote locked in — you can still change it · ${voteCount} / ${activeIds.length}`;
  } else if (voteCount > 0) {
    waiting.hidden = false;
    waiting.textContent = `${voteCount} / ${activeIds.length} voted`;
  } else {
    waiting.hidden = true;
  }
}

function renderRoundResult(r) {
  const result = r.lastRoundResult;
  const block = $('round-result-block');
  block.innerHTML = '';

  const headline = document.createElement('div');
  if (result.tied) {
    headline.className = 'result-headline tied';
    headline.textContent = 'THE VOTE WAS TIED';
    block.appendChild(headline);
    const sub = document.createElement('div');
    sub.className = 'result-row';
    sub.innerHTML = `<span class="label">Outcome</span>No one was voted off.`;
    block.appendChild(sub);
  } else {
    headline.className = 'result-headline ' + (result.wasImposter ? 'caught' : 'escaped');
    headline.textContent = result.wasImposter ? 'IMPOSTER OUT' : 'WRONG TARGET';
    block.appendChild(headline);

    const sub = document.createElement('div');
    sub.className = 'result-row';
    sub.innerHTML = `<span class="label">Voted off</span><span class="${result.wasImposter ? 'imposter-name' : ''}">${result.eliminatedName}</span> · ${result.wasImposter ? 'was the imposter' : 'was innocent'}`;
    block.appendChild(sub);
  }

  // Show the word so the imposter learns what they were bluffing against
  const wordRow = document.createElement('div');
  wordRow.className = 'result-row';
  wordRow.innerHTML = `<span class="label">The word this round was</span><span class="word-name">${result.word}</span>`;
  block.appendChild(wordRow);

  // Host controls: next round or end session
  if (state.isHost) {
    if (r.testMode) {
      // Test mode: host always sees both buttons, no auto-end
      $('btn-next-round').hidden = false;
      $('btn-end-session').hidden = false;
    } else {
      // Normal: just next round (session-end is handled by transaction → 'results' phase)
      $('btn-next-round').hidden = false;
      $('btn-end-session').hidden = true;
    }
    $('round-result-waiting').hidden = true;
  } else {
    $('btn-next-round').hidden = true;
    $('btn-end-session').hidden = true;
    $('round-result-waiting').hidden = false;
  }
}

function renderFinalResults(r) {
  const block = $('results-block');
  block.innerHTML = '';
  const players = r.players || {};
  const roles = r.roles || {};

  const headline = document.createElement('div');
  headline.className = 'result-headline ' + (r.sessionWinner === 'innocents' ? 'caught' : r.sessionWinner === 'imposters' ? 'escaped' : 'tied');
  headline.textContent =
    r.sessionWinner === 'innocents' ? 'INNOCENTS WIN' :
    r.sessionWinner === 'imposters' ? 'IMPOSTERS WIN' :
    'SESSION ENDED';
  block.appendChild(headline);

  // Reveal imposters
  const imposterNames = Object.entries(roles)
    .filter(([id, role]) => role === 'imposter')
    .map(([id]) => players[id]?.name || '???')
    .join(', ');

  const impRow = document.createElement('div');
  impRow.className = 'result-row';
  impRow.innerHTML = `<span class="label">The imposter${Object.values(roles).filter(x=>x==='imposter').length > 1 ? 's were' : ' was'}</span><span class="imposter-name">${imposterNames || '—'}</span>`;
  block.appendChild(impRow);

  $('btn-play-again').hidden = !state.isHost;
  $('results-waiting').hidden = state.isHost;
}

function showSpectator() {
  const r = state.room;
  const players = r.players || {};
  const roles = r.roles || {};
  const imposterNames = Object.entries(roles)
    .filter(([id, role]) => role === 'imposter')
    .map(([id]) => players[id]?.name || '???')
    .join(', ');
  $('spec-imposter-reveal').textContent = `Imposter: ${imposterNames}`;
  // Word reveal — out of play, so spectators get the full picture
  $('spec-word-reveal').textContent = r.currentWord ? `Word: ${r.currentWord}` : '';

  // Host controls — visible only if the spectator IS the host
  // (so a voted-out host can still drive the game forward)
  $('spec-host-controls').hidden = !state.isHost;
  if (state.isHost) {
    // Mirror the same per-phase visibility logic used in the main views
    const phase = r.phase;
    $('btn-spec-open-vote').hidden     = !(phase === 'showcase');
    $('btn-spec-next-round').hidden    = !(phase === 'roundResult');
    // End-session only shows in test mode (matches the main host UI)
    $('btn-spec-end-session').hidden   = !(r.testMode && phase === 'roundResult');
  }

  // Mirror the current pins on the spectator map.
  const wasOnSpectator = isOn('screen-spectator');
  if (!wasOnSpectator) show('screen-spectator');
  ensureSpecMap();
  specMarkers.forEach(m => m.remove());
  specMarkers = [];
  const subs = r.submissions || {};
  const bounds = [];
  orderedPlayerIds(players).forEach(id => {
    const s = subs[id];
    if (!s) return;
    const name = players[id]?.name || s.name || '???';
    const mk = L.marker([s.lat, s.lng]).addTo(specMap)
      .bindTooltip(name, { permanent: true, direction: 'top' });
    specMarkers.push(mk);
    bounds.push([s.lat, s.lng]);
  });
  if (bounds.length) specMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
}


// ============================================================
//  REJOIN LOGIC (used by both silent auto-rejoin and the
//  manual "REJOIN ROOM" button on the home screen)
// ============================================================

let rejoinInFlight = false;

// Attempts to put the player back into their saved room.
// Returns true on success, false if rejoin wasn't possible.
async function attemptRejoin({ silent = true } = {}) {
  if (rejoinInFlight) return false;
  const saved = loadSession();
  if (!saved || !saved.roomCode || !saved.playerId) return false;
  rejoinInFlight = true;

  let hint;
  if (silent) {
    // small amber pill for auto-rejoin
    hint = document.createElement('div');
    hint.id = 'reconnect-hint';
    hint.textContent = `reconnecting to room ${saved.roomCode}…`;
    hint.style.cssText = `
      position: fixed; top: max(20px, env(safe-area-inset-top)); left: 50%;
      transform: translateX(-50%); z-index: 100;
      background: rgba(13,15,14,0.85); border: 1px solid var(--amber, #ffc24b);
      color: var(--amber, #ffc24b); padding: 8px 14px; border-radius: 999px;
      font-family: 'Space Mono', monospace; font-size: 12px;
      backdrop-filter: blur(8px);
    `;
    document.body.appendChild(hint);
  } else {
    // manual rejoin: temporarily disable the button so users don't double-tap
    $('btn-rejoin').disabled = true;
    $('btn-rejoin').style.opacity = '0.5';
  }

  try {
    const snap = await getDoc(roomRef(saved.roomCode));
    if (!snap.exists()) {
      clearSession();
      hint?.remove();
      return false;
    }
    const room = snap.data();
    if (!room.players || !room.players[saved.playerId]) {
      clearSession();
      hint?.remove();
      return false;
    }

    // Restore state and subscribe
    state.roomCode = saved.roomCode;
    state.playerId = saved.playerId;
    state.playerName = saved.playerName;
    state.isHost = room.hostId === saved.playerId;
    state.imposters = room.imposters || 1;
    state.testMode = !!room.testMode;
    if (state.isHost) {
      [...$('imposter-seg').children].forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.imp, 10) === state.imposters)
      );
      $('input-test-mode').checked = state.testMode;
    }

    subscribeRoom(saved.roomCode);
    hint?.remove();
    return true;
  } catch (e) {
    console.warn('rejoin failed:', e);
    if (hint) {
      hint.textContent = 'could not reconnect — start fresh';
      hint.style.borderColor = 'var(--red, #ff4d4d)';
      hint.style.color = 'var(--red, #ff4d4d)';
      setTimeout(() => hint.remove(), 2500);
    } else {
      // manual rejoin failure: brief inline error
      const err = $('btn-rejoin');
      err.textContent = 'COULD NOT REJOIN';
      setTimeout(() => refreshRejoinButton(), 2000);
    }
    clearSession();
    return false;
  } finally {
    rejoinInFlight = false;
    // Always restore the button (no-op if it wasn't disabled)
    const btn = $('btn-rejoin');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    // Refresh button visibility (will hide it if session was cleared)
    refreshRejoinButton();
  }
}

// Show/hide the manual rejoin button based on saved session.
function refreshRejoinButton() {
  const saved = loadSession();
  const btn = $('btn-rejoin');
  if (!btn) return;
  if (saved && saved.roomCode && saved.playerId) {
    btn.hidden = false;
    btn.innerHTML = `REJOIN ROOM <span id="btn-rejoin-code">${saved.roomCode}</span>`;
  } else {
    btn.hidden = true;
  }
}

// Wire the manual rejoin button
$('btn-rejoin').onclick = () => attemptRejoin({ silent: false });

// Show the button on first paint if a session exists
refreshRejoinButton();

// Kick off silent auto-rejoin (existing behavior preserved)
attemptRejoin({ silent: true });

