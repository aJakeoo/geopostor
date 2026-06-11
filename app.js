// ============================================================
//  PHOTOSTOR — APP LOGIC + FIREBASE SYNC (v2)
//  You shouldn't need to edit this file. Keys go in firebase-config.js.
// ============================================================

import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, setDoc, updateDoc, onSnapshot, runTransaction,
  getDoc, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- Random word bank (never shown to host) ----------
const WORD_BANK = [
  'Volcano','Library','Carnival','Submarine','Desert','Thunderstorm',
  'Greenhouse','Lighthouse','Subway','Bakery','Glacier','Arcade',
  'Vineyard','Junkyard','Aquarium','Observatory','Campfire','Harbor',
  'Waterfall','Cathedral','Laboratory','Marketplace','Tundra','Festival',
  'Skatepark','Bookstore','Diner','Cabin','Pier','Treehouse',
  'Castle','Greenhouse','Stadium','Museum','Theater','Bridge',
  'Tunnel','Quarry','Orchard','Reef','Canyon','Meadow',
  'Workshop','Pharmacy','Florist','Tavern','Studio','Lighthouse'
];

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
  myVoteCast: false,
  lastRoundSeen: 0,        // for resetting per-round local UI
  lastPhaseSeen: null,
  pendingImage: null,
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
const SESSION_KEY = 'photostor.session.v1';
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
function pickWord(exclude = []) {
  const choices = WORD_BANK.filter(w => !exclude.includes(w));
  return choices[Math.floor(Math.random() * choices.length)];
}
function roomRef(code) { return doc(db, 'rooms', code); }

// ---------- Image compression ----------
function compressImage(file, maxDim = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = height * maxDim / width; width = maxDim; }
        else if (height > maxDim) { width = width * maxDim / height; height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

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

  const firstWord = pickWord();

  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'reveal',
      round: 1,
      currentWord: firstWord,
      usedWords: [firstWord],
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
};

// ============================================================
//  SUBMIT IMAGE (with playtest fix for placeholder bleed)
// ============================================================
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await compressImage(file);
    state.pendingImage = dataUrl;
    const prev = $('upload-preview');
    prev.src = dataUrl;
    prev.hidden = false;
    $('upload-zone').classList.add('has-image'); // hides placeholder via CSS
    $('btn-submit-image').disabled = false;
  } catch (err) {
    console.error(err);
    alert('Could not load that image. Try another.');
  }
});

$('btn-submit-image').onclick = async () => {
  if (!state.pendingImage) return;
  $('btn-submit-image').disabled = true;
  try {
    await updateDoc(roomRef(state.roomCode), {
      [`submissions.${state.playerId}`]: { img: state.pendingImage, name: state.playerName }
    });
    $('submit-waiting').hidden = false;
  } catch (e) {
    console.error(e);
    alert('Submit failed — the image may be too large. Try a different photo.');
    $('btn-submit-image').disabled = false;
  }
};

// ============================================================
//  SHOWCASE → host opens vote
// ============================================================
$('btn-open-vote').onclick = async () => {
  await updateDoc(roomRef(state.roomCode), { phase: 'vote' });
};

// ============================================================
//  VOTING (self-voting allowed)
// ============================================================
async function castVote(targetId) {
  if (state.myVoteCast) return;
  state.myVoteCast = true;
  try {
    await updateDoc(roomRef(state.roomCode), {
      [`votes.${state.playerId}`]: targetId
    });
    $('vote-waiting').hidden = false;
  } catch (e) {
    console.error(e);
    state.myVoteCast = false;
    alert('Vote failed — try again.');
  }
}

// ============================================================
//  ROUND RESULT actions
// ============================================================
$('btn-next-round').onclick = async () => {
  // Host advances to the next round
  const r = state.room;
  const nextRound = r.round + 1;
  const nextWord = pickWord(r.usedWords || []);
  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'reveal',
      round: nextRound,
      currentWord: nextWord,
      usedWords: [...(r.usedWords || []), nextWord],
      submissions: {},
      votes: {},
      lastRoundResult: null
    });
  } catch (e) { console.error(e); }
};

$('btn-end-session').onclick = async () => {
  // Test-mode manual end
  try {
    await updateDoc(roomRef(state.roomCode), {
      phase: 'results',
      sessionWinner: 'ended',
    });
  } catch (e) { console.error(e); }
};

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
  state.myVoteCast = false;
  state.pendingImage = null;
  $('upload-preview').hidden = true;
  $('upload-preview').src = '';
  $('upload-zone').classList.remove('has-image');
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
  const ids = Object.keys(players);
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
        renderShowcase(r);
        if (!isOn('screen-showcase')) show('screen-showcase');
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
  if (myRole === 'imposter') {
    card.classList.add('imposter');
    $('reveal-eyebrow').textContent = 'YOU ARE THE';
    $('reveal-word').textContent = 'IMPOSTER';
    $('reveal-instruction').textContent =
      "You don't know the word. Find an image that could plausibly fit — then bluff your way through the discussion.";
  } else {
    card.classList.remove('imposter');
    $('reveal-eyebrow').textContent = 'YOUR WORD';
    $('reveal-word').textContent = r.currentWord || '—';
    $('reveal-instruction').textContent =
      "Find an image online that connects to this word — but don't be too obvious, or you'll out yourself.";
  }
}

function renderSubmitProgress(r) {
  // Visual progress only — actual screen control happens in phase routing above
}

function renderShowcase(r) {
  const subs = r.submissions || {};
  const g = $('gallery');
  g.innerHTML = '';
  Object.entries(subs).forEach(([id, s]) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${s.img}" alt="" /><div class="who">${s.name}</div>`;
    g.appendChild(div);
  });
  $('btn-open-vote').hidden = !state.isHost;
  $('discuss-waiting').hidden = state.isHost;
}

function renderVote(r) {
  const list = $('vote-list');
  list.innerHTML = '';
  const players = r.players || {};
  const votes = r.votes || {};
  const iAlreadyVoted = !!votes[state.playerId];
  if (iAlreadyVoted) state.myVoteCast = true;

  Object.entries(players).forEach(([id, p]) => {
    if (p.eliminated) return; // can't vote for eliminated players
    const li = document.createElement('li');
    if (id === state.playerId) li.classList.add('self');
    if (votes[state.playerId] === id) li.classList.add('selected');
    li.innerHTML = `<span class="player-dot"></span>${p.name}${id === state.playerId ? ' (you)' : ''}`;
    li.onclick = () => {
      if (state.myVoteCast) return;
      [...list.children].forEach(c => c.classList.remove('selected'));
      li.classList.add('selected');
      castVote(id);
    };
    list.appendChild(li);
  });

  if (iAlreadyVoted) $('vote-waiting').hidden = false;
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

  // Mirror the current gallery if we're in showcase/vote/result
  const subs = r.submissions || {};
  const g = $('spec-gallery');
  g.innerHTML = '';
  Object.entries(subs).forEach(([id, s]) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${s.img}" alt="" /><div class="who">${s.name}</div>`;
    g.appendChild(div);
  });

  if (!isOn('screen-spectator')) show('screen-spectator');
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

