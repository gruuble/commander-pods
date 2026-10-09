/* ==========================================================================
   Commander Pods — app.js
   Static, dependency-free vanilla JavaScript (ES2020+).

   Storage (localStorage key "commander-pods:v1"):
     {
       version: 1,
       players:  [{ id, name, createdAt, out? }],
       settings: { durationMinutes, soundEnabled },
       history:  [{ at, podSizes, pods, durationMinutes }]   // max 20
       roundNumber: 1,    // next round to record; reset by "Reset day"
       results:  [{ round, at, pods: [{ players, winner }], satOut, durationMinutes }]
     }
   The current pods and any "sitting out" player are session-only and are
   intentionally NOT part of the stored document (per the v1 data contract).
   ========================================================================== */

'use strict';

(() => {
  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------
  const STORAGE_KEY = 'commander-pods:v1';
  const SCHEMA_VERSION = 1;
  const MAX_NAME_LEN = 24;
  const MAX_HISTORY = 20;
  const UNDO_TOAST_MS = 5000;
  const GENERIC_TOAST_MS = 3000;
  const ALARM_MAX_MS = 60000;    // alarm sound loops for at most 60 s
  const TICK_MS = 250;           // render cadence; remaining time is recomputed from a timestamp
  const WARN_MS = 5 * 60 * 1000; // amber zone
  const DANGER_MS = 60 * 1000;   // red pulsing zone
  const DEFAULTS = Object.freeze({ durationMinutes: 75, soundEnabled: true });
  const TAB_NAMES = ['roster', 'pods', 'timer', 'results'];

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------
  const state = {
    players: [],    // [{ id, name, createdAt }]
    settings: { durationMinutes: DEFAULTS.durationMinutes, soundEnabled: DEFAULTS.soundEnabled },
    history: [],    // [{ at, podSizes, pods, durationMinutes }]
    pods: [],       // current split as arrays of player ids (session-only)
    sittingOut: [], // player ids sitting out (session-only, from the 5-player choice)
    winnerPicks: {},// pod index -> picked winner player id (session-only, follows the pods)
    roundNumber: 1, // next round to record; Reset day puts it back to 1
    results: [],    // recorded rounds: [{ round, at, pods: [{players, winner}], satOut, durationMinutes }]
  };

  let storageOk = true;
  let saveTimerId = null;
  let editingId = null;          // player id currently being renamed inline
  let fiveChoicePending = false; // the 5-player choice panel is being shown
  let pendingUndo = null;        // { player, index, timeoutId, toastEl }

  const timer = {
    status: 'idle',              // 'idle' | 'running' | 'paused' | 'finished'
    durationMs: DEFAULTS.durationMinutes * 60000,
    endAt: 0,                    // absolute wall-clock end (Date.now() based)
    remainingMs: DEFAULTS.durationMinutes * 60000,
    tickId: null,
  };

  const alarm = {
    active: false,
    startedAt: 0,
    soundRunning: false,
    timeouts: [],
    masterGain: null,
    titleFlashId: null,
    flashOn: false,
    originalTitle: 'Commander Pods',
  };

  let audioCtx = null;

  // --------------------------------------------------------------------------
  // Small utilities
  // --------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** Fisher–Yates shuffle (unbiased). Returns a new array; input is untouched. */
  function shuffle(input) {
    const a = input.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  /** MM:SS, switching to H:MM:SS above 99:59. */
  function formatClock(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return totalSeconds > 99 * 60 + 59 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function timeOfDay(timestamp) {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** "2026-10-09 21:35" (local time) — used in results and the CSV export. */
  function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // --------------------------------------------------------------------------
  // Pod-size algorithm (pure function; spec sections 4.2 / 4.3)
  // --------------------------------------------------------------------------
  /**
   * Returns the pod sizes for n players:
   *   n < 3  -> []     (generation impossible)
   *   n = 5  -> null   (special case: caller must offer explicit choices)
   *   else   -> array of 3s and 4s, as many 4s as the math allows
   */
  function computePodSizes(n) {
    if (!Number.isInteger(n) || n < 3) return [];
    if (n === 5) return null;
    const fours = Math.floor(n / 4);
    const rem = n % 4;
    if (rem === 0) return new Array(fours).fill(4);
    if (rem === 3) return new Array(fours).fill(4).concat([3]);
    if (rem === 2) return new Array(fours - 1).fill(4).concat([3, 3]);
    return new Array(fours - 2).fill(4).concat([3, 3, 3]); // rem === 1
  }

  // --------------------------------------------------------------------------
  // Self-test
  // --------------------------------------------------------------------------
  /** Hidden self-test: index.html?selftest=1 — asserts every row of the 4.3 table. */
  function runSelfTest() {
    const cases = [
      [0, []], [1, []], [2, []],
      [3, [3]], [4, [4]], [5, null], [6, [3, 3]], [7, [4, 3]], [8, [4, 4]],
      [9, [3, 3, 3]], [10, [4, 3, 3]], [11, [4, 4, 3]], [12, [4, 4, 4]],
      [13, [4, 3, 3, 3]], [14, [4, 4, 3, 3]], [15, [4, 4, 4, 3]], [16, [4, 4, 4, 4]],
      [17, [4, 4, 3, 3, 3]],
      // extra sanity rows beyond the required table
      [18, [4, 4, 4, 3, 3]], [19, [4, 4, 4, 4, 3]], [20, [4, 4, 4, 4, 4]], [21, [4, 4, 4, 3, 3, 3]],
    ];
    const rows = [];
    let failures = 0;
    for (const [n, expected] of cases) {
      const actual = computePodSizes(n);
      const sumsCorrect =
        !Array.isArray(actual) || actual.length === 0 || actual.reduce((a, b) => a + b, 0) === n;
      const sizesValid = !Array.isArray(actual) || actual.every((s) => s === 3 || s === 4);
      const ok = JSON.stringify(actual) === JSON.stringify(expected) && sumsCorrect && sizesValid;
      if (!ok) failures += 1;
      rows.push({
        players: n,
        expected: JSON.stringify(expected),
        actual: JSON.stringify(actual),
        result: ok ? 'PASS' : 'FAIL',
      });
    }
    console.table(rows);
    console.log(
      `[Commander Pods self-test] ${cases.length - failures}/${cases.length} passed — ` +
        `${failures === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'}`
    );
    return failures === 0;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------
  function storageAvailable() {
    try {
      const probe = '__commander_pods_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  function readStoredDoc() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      return doc && doc.version === SCHEMA_VERSION ? doc : null;
    } catch {
      return null;
    }
  }

  function persistNow() {
    if (!storageOk) return;
    try {
      const doc = {
        version: SCHEMA_VERSION,
        players: state.players.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, out: p.out === true })),
        settings: {
          durationMinutes: state.settings.durationMinutes,
          soundEnabled: state.settings.soundEnabled,
        },
        history: state.history,
        roundNumber: state.roundNumber,
        results: state.results,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      storageOk = false;
      showStorageNotice();
    }
  }

  function scheduleSave() {
    if (saveTimerId) clearTimeout(saveTimerId);
    saveTimerId = setTimeout(() => {
      saveTimerId = null;
      persistNow();
    }, 150);
  }

  function hydrate(doc) {
    if (Array.isArray(doc.players)) {
      state.players = doc.players
        .filter((p) => p && typeof p.name === 'string')
        .map((p) => ({
          id: typeof p.id === 'string' && p.id ? p.id : makeId(),
          name: p.name.trim().slice(0, MAX_NAME_LEN) || 'Player',
          createdAt: Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
          out: p.out === true,
        }));
    }
    const s = doc.settings || {};
    const dur = Number(s.durationMinutes);
    state.settings.durationMinutes =
      Number.isInteger(dur) && dur >= 1 && dur <= 600 ? dur : DEFAULTS.durationMinutes;
    state.settings.soundEnabled =
      typeof s.soundEnabled === 'boolean' ? s.soundEnabled : DEFAULTS.soundEnabled;
    if (Array.isArray(doc.history)) {
      state.history = doc.history
        .filter((h) => h && Array.isArray(h.podSizes) && Array.isArray(h.pods))
        .slice(0, MAX_HISTORY)
        .map((h) => ({
          at: Number(h.at) || Date.now(),
          podSizes: h.podSizes.map(Number),
          pods: h.pods.map((pod) => (Array.isArray(pod) ? pod.map(String) : [])),
          durationMinutes: Number(h.durationMinutes) || DEFAULTS.durationMinutes,
        }));
    }
    state.roundNumber =
      Number.isInteger(doc.roundNumber) && doc.roundNumber >= 1 ? doc.roundNumber : 1;
    if (Array.isArray(doc.results)) {
      state.results = doc.results
        .filter((r) => r && Number.isInteger(r.round) && Array.isArray(r.pods))
        .map((r) => ({
          round: r.round,
          at: Number(r.at) || Date.now(),
          pods: r.pods
            .filter((p) => p && Array.isArray(p.players))
            .map((p) => ({
              players: p.players.map(String),
              winner: typeof p.winner === 'string' ? p.winner : '',
            })),
          satOut: Array.isArray(r.satOut) ? r.satOut.map(String) : [],
          durationMinutes: Number(r.durationMinutes) || DEFAULTS.durationMinutes,
        }));
    }
  }

  function showStorageNotice() {
    const notice = $('storageNotice');
    if (notice) notice.hidden = false;
  }

  // --------------------------------------------------------------------------
  // Toasts (never alert/confirm/prompt)
  // --------------------------------------------------------------------------
  function toast(message) {
    const region = $('toastRegion');
    const node = el('div', 'toast');
    node.append(el('span', 'toast__msg', message));
    region.append(node);
    requestAnimationFrame(() => node.classList.add('toast--in'));
    setTimeout(() => dismissToast(node), GENERIC_TOAST_MS);
    const genericToasts = Array.from(region.children).filter((c) => !c.classList.contains('toast--undo'));
    if (genericToasts.length > 2) dismissToast(genericToasts[0]);
  }

  function dismissToast(node) {
    node.classList.remove('toast--in');
    setTimeout(() => node.remove(), 180);
  }

  function showUndoToast(player, index) {
    const region = $('toastRegion');
    const node = el('div', 'toast toast--undo');
    const undoBtn = el('button', 'toast__btn', 'Undo');
    undoBtn.type = 'button';
    undoBtn.setAttribute('aria-label', `Undo removal of ${player.name}`);
    node.append(el('span', 'toast__msg', `Removed ${player.name}`), undoBtn);
    region.append(node);
    requestAnimationFrame(() => node.classList.add('toast--in'));
    const entry = { player, index, timeoutId: null, toastEl: node };
    entry.timeoutId = setTimeout(() => {
      if (pendingUndo === entry) pendingUndo = null;
      dismissToast(node);
    }, UNDO_TOAST_MS);
    pendingUndo = entry;
    undoBtn.addEventListener('click', () => undoRemove(entry));
  }

  function clearPendingUndo() {
    if (!pendingUndo) return;
    clearTimeout(pendingUndo.timeoutId);
    dismissToast(pendingUndo.toastEl);
    pendingUndo = null;
  }

  /** Restores the removed player exactly once (the toast is gone afterwards). */
  function undoRemove(entry) {
    if (!pendingUndo || pendingUndo !== entry) return;
    clearTimeout(entry.timeoutId);
    dismissToast(entry.toastEl);
    pendingUndo = null;
    const nameTaken = state.players.some((p) => p.name.toLowerCase() === entry.player.name.toLowerCase());
    if (nameTaken) {
      toast(`Couldn't undo — "${entry.player.name}" is already on the roster.`);
      return;
    }
    state.players.splice(Math.min(entry.index, state.players.length), 0, entry.player);
    toast(`${entry.player.name} restored.`);
    renderRoster();
    renderPodsView();
    scheduleSave();
  }

  // --------------------------------------------------------------------------
  // Roster
  // --------------------------------------------------------------------------
  /** Players actually in the rotation (not marked as sitting out). */
  function activePlayers() {
    return state.players.filter((p) => !p.out);
  }

  function activePlayerCount() {
    return activePlayers().length;
  }

  /** Everyone not playing this split: the 5-player sit-out choice + roster sit-outs. */
  function currentSitterIds() {
    return [
      ...new Set([
        ...state.sittingOut,
        ...state.players.filter((p) => p.out).map((p) => p.id),
      ]),
    ].filter((id) => state.players.some((p) => p.id === id));
  }

  function validateName(rawName, excludeId) {
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name) return { ok: false, error: 'Enter a player name.' };
    if (name.length > MAX_NAME_LEN) {
      return { ok: false, error: `Names are limited to ${MAX_NAME_LEN} characters.` };
    }
    const duplicate = state.players.some(
      (p) => p.id !== excludeId && p.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) return { ok: false, error: `"${name}" is already on the roster.` };
    return { ok: true, name };
  }

  function showAddError(message) {
    const err = $('nameError');
    err.textContent = message;
    err.hidden = false;
    $('playerNameInput').setAttribute('aria-invalid', 'true');
  }

  function hideAddError() {
    const err = $('nameError');
    err.hidden = true;
    $('playerNameInput').removeAttribute('aria-invalid');
  }

  function addPlayer(rawName) {
    const result = validateName(rawName, null);
    if (!result.ok) {
      showAddError(result.error);
      return false;
    }
    state.players.push({ id: makeId(), name: result.name, createdAt: Date.now(), out: false });
    hideAddError();
    renderRoster();
    renderPodsView();
    scheduleSave();
    return true;
  }

  function removePlayer(id) {
    const index = state.players.findIndex((p) => p.id === id);
    if (index === -1) return;
    if (editingId === id) editingId = null;
    const removed = state.players.splice(index, 1)[0];
    clearPendingUndo();
    showUndoToast(removed, index);
    renderRoster();
    renderPodsView();
    scheduleSave();
  }

  /** Toggles a player between the rotation and sitting out (persists until undone). */
  function toggleSitOut(id) {
    const player = state.players.find((p) => p.id === id);
    if (!player) return;
    player.out = !player.out;
    renderRoster();
    renderPodsView(); // counts, helpers, stale banner, winner picker
    scheduleSave();
  }

  function startRename(id) {
    editingId = id;
    hideAddError();
    renderRoster();
    const input = document.querySelector('.player-row--editing .rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function cancelRename() {
    editingId = null;
    renderRoster();
  }

  function commitRename(id, rawValue, viaBlur) {
    if (editingId !== id) return; // already committed or cancelled
    const result = validateName(rawValue, id);
    if (!result.ok) {
      if (viaBlur) {
        editingId = null;
        renderRoster();
        toast(`Name unchanged — ${result.error}`);
      } else {
        showRenameError(result.error);
      }
      return;
    }
    const player = state.players.find((p) => p.id === id);
    if (player) player.name = result.name;
    editingId = null;
    renderRoster();
    renderPods(); // pod cards display live names
    scheduleSave();
  }

  function showRenameError(message) {
    const err = document.querySelector('.player-row--editing .field-error');
    if (err) {
      err.textContent = message;
      err.hidden = false;
    }
  }

  function renderRosterHint() {
    const hint = $('rosterHint');
    const total = state.players.length;
    const active = activePlayerCount();
    const out = total - active;
    if (total === 0) {
      hint.textContent = 'Add everyone who is here, then split into pods on the Pods tab.';
    } else if (active < 3) {
      hint.textContent =
        out > 0
          ? `Only ${active} active — bring players back in or add more (need at least 3).`
          : 'Add at least 3 players to form pods.';
    } else {
      hint.textContent =
        `Ready — ${active} active${out > 0 ? `, ${out} sitting out` : ''}. Open the Pods tab and press Generate groups.`;
    }
    hint.hidden = false;
  }

  function renderRoster() {
    const list = $('playerList');
    list.textContent = '';
    for (const player of state.players) {
      const row = el('li', 'player-row');
      row.dataset.id = player.id;
      if (editingId === player.id) {
        row.classList.add('player-row--editing');
        const wrap = el('div', 'rename-wrap');
        const input = el('input', 'rename-input');
        input.type = 'text';
        input.value = player.name;
        input.maxLength = MAX_NAME_LEN;
        input.autocomplete = 'off';
        input.id = `rename-${player.id}`;
        input.setAttribute('aria-label', `Rename ${player.name}`);
        const err = el('p', 'field-error');
        err.id = `rename-error-${player.id}`;
        err.hidden = true;
        input.setAttribute('aria-describedby', err.id);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename(player.id, input.value, false);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
          }
        });
        input.addEventListener('blur', () => commitRename(player.id, input.value, true));
        wrap.append(input, err);
        row.append(wrap);
      } else {
        const isOut = player.out === true;
        if (isOut) row.classList.add('player-row--out');
        const nameBtn = el('button', 'player-name', player.name);
        nameBtn.type = 'button';
        nameBtn.title = 'Tap to rename';
        nameBtn.setAttribute('aria-label', `Rename ${player.name}`);
        nameBtn.addEventListener('click', () => startRename(player.id));
        row.append(nameBtn);
        if (isOut) row.append(el('span', 'player-out-badge', 'Sitting out'));
        const sitBtn = el(
          'button',
          'player-sitout' + (isOut ? ' player-sitout--on' : ''),
          isOut ? 'Bring in' : 'Sit out'
        );
        sitBtn.type = 'button';
        sitBtn.setAttribute('aria-pressed', String(isOut));
        sitBtn.setAttribute(
          'aria-label',
          isOut ? `Bring ${player.name} back into the rotation` : `Mark ${player.name} as sitting out`
        );
        sitBtn.addEventListener('click', () => toggleSitOut(player.id));
        const removeBtn = el('button', 'player-remove', '×');
        removeBtn.type = 'button';
        removeBtn.setAttribute('aria-label', `Remove ${player.name}`);
        removeBtn.addEventListener('click', () => removePlayer(player.id));
        row.append(sitBtn, removeBtn);
      }
      list.append(row);
    }
    const total = state.players.length;
    const active = activePlayerCount();
    $('playerCount').textContent =
      `${active} player${active === 1 ? '' : 's'}` +
      (total - active > 0 ? ` · ${total - active} sitting out` : '');
    renderRosterHint();
  }

  // --------------------------------------------------------------------------
  // Pods
  // --------------------------------------------------------------------------
  function nameOf(id) {
    const player = state.players.find((p) => p.id === id);
    return player ? player.name : '(removed)';
  }

  function pushHistory(sizes) {
    state.history.unshift({
      at: Date.now(),
      podSizes: sizes.slice(),
      pods: state.pods.map((pod) => pod.map(nameOf)),
      durationMinutes: state.settings.durationMinutes,
    });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  }

  function dealIntoPods(ids, sizes) {
    const queue = shuffle(ids); // Fisher–Yates; never sort-with-random
    const pods = [];
    let cursor = 0;
    for (const size of sizes) {
      pods.push(queue.slice(cursor, cursor + size));
      cursor += size;
    }
    state.pods = pods;
    state.sittingOut = [];
    state.winnerPicks = {}; // fresh split, fresh picks
    pushHistory(sizes);
  }

  function generatePods() {
    const n = activePlayerCount();
    if (n < 3) return; // button is disabled; defensive no-op
    if (n === 5) {
      fiveChoicePending = true; // never silently produce an invalid pod
      renderPodsView();
      return;
    }
    fiveChoicePending = false;
    const sizes = computePodSizes(n);
    if (!sizes || sizes.length === 0) return;
    dealIntoPods(activePlayers().map((p) => p.id), sizes);
    renderPodsView();
    scheduleSave(); // history is persisted
  }

  function applyFiveChoice(houseRules) {
    if (activePlayerCount() !== 5) {
      fiveChoicePending = false;
      renderPodsView();
      return;
    }
    const ids = activePlayers().map((p) => p.id);
    fiveChoicePending = false;
    if (houseRules) {
      state.pods = [ids.slice()];
      state.sittingOut = [];
      pushHistory([5]);
    } else {
      const shuffled = shuffle(ids);
      state.pods = [shuffled.slice(0, 4)];
      state.sittingOut = [shuffled[4]];
      pushHistory([4]);
    }
    renderPodsView();
    scheduleSave();
  }

  function usedPodIds() {
    const ids = new Set();
    for (const pod of state.pods) for (const id of pod) ids.add(id);
    for (const id of state.sittingOut) ids.add(id);
    return ids;
  }

  function podsAreStale() {
    if (state.pods.length === 0) return false;
    const used = usedPodIds();
    const roster = new Set(activePlayers().map((p) => p.id));
    if (used.size !== roster.size) return true;
    for (const id of roster) {
      if (!used.has(id)) return true;
    }
    return false;
  }

  function renderGenerateControls() {
    const n = activePlayerCount();
    const out = state.players.length - n;
    const genBtn = $('generateBtn');
    const helper = $('generateHelper');
    if (n < 3) {
      genBtn.disabled = true;
      genBtn.textContent = 'Generate groups';
      helper.textContent =
        out > 0 ? `Need at least 3 active players (${out} sitting out)` : 'Need at least 3 players';
      helper.hidden = false;
    } else if (n === 5) {
      genBtn.disabled = false;
      genBtn.textContent = state.pods.length ? 'Regenerate / reshuffle' : 'Generate groups';
      helper.textContent = '5 active players need a choice — pick an option below.';
      helper.hidden = false;
    } else {
      genBtn.disabled = false;
      genBtn.textContent = state.pods.length ? 'Regenerate / reshuffle' : 'Generate groups';
      helper.textContent =
        `${n} active → ${computePodSizes(n).join(' + ')}` + (out > 0 ? ` · ${out} sitting out` : '');
      helper.hidden = false;
    }
    $('copyPodsBtn').disabled = state.pods.length === 0;
  }

  function renderStaleBanner() {
    const stale = podsAreStale();
    $('staleBanner').hidden = !stale;
    if (stale) $('staleRegenBtn').disabled = activePlayerCount() < 3;
  }

  function renderFivePanel() {
    $('fivePanel').hidden = !(activePlayerCount() === 5 && fiveChoicePending);
  }

  function renderPods() {
    const grid = $('podCards');
    grid.textContent = '';
    if (state.pods.length === 0) {
      grid.append(
        el('p', 'empty-note', 'No groups yet. Add players on the Roster tab, then press "Generate groups".')
      );
    } else {
      state.pods.forEach((pod, index) => {
        const card = el('article', 'pod-card');
        card.dataset.podIndex = String(index);
        const head = el('div', 'pod-card__head');
        head.append(el('h3', 'pod-card__title', `Pod ${index + 1}`));
        const badge = el('span', 'pod-badge', String(pod.length));
        badge.setAttribute('aria-label', `${pod.length} players`);
        head.append(badge);
        card.append(head);
        card.append(buildWinnerPicker(index, pod));
        grid.append(card);
      });
    }
    const sitterIds = currentSitterIds();
    if (sitterIds.length > 0) {
      const card = el('article', 'pod-card pod-card--sitout');
      const head = el('div', 'pod-card__head');
      head.append(el('h3', 'pod-card__title', 'Sitting out'));
      head.append(el('span', 'pod-badge', String(sitterIds.length)));
      const names = el('ul', 'pod-names');
      for (const id of sitterIds) names.append(el('li', null, nameOf(id)));
      card.append(head, names);
      grid.append(card);
    }
  }

  /** One radio per player still on the roster — tapping marks that pod's winner. */
  function buildWinnerPicker(podIndex, pod) {
    const fieldset = el('fieldset', 'pod-picker');
    const legend = el('legend', 'visually-hidden', `Pod ${podIndex + 1} — tap the winner`);
    const list = el('ul', 'pod-card__players');
    const pickedId = state.winnerPicks[podIndex];
    for (const id of pod) {
      const player = state.players.find((p) => p.id === id);
      if (!player || player.out) continue; // gone or sitting out — cannot win
      const li = el('li');
      const label = el('label', 'pod-player' + (pickedId === id ? ' pod-player--winner' : ''));
      const input = el('input');
      input.type = 'radio';
      input.name = `pod-${podIndex}-winner`;
      input.value = id;
      input.checked = pickedId === id;
      input.addEventListener('change', () => onWinnerPick(podIndex, id));
      label.append(input, el('span', null, player.name));
      li.append(label);
      list.append(li);
    }
    fieldset.append(legend, list);
    return fieldset;
  }

  function onWinnerPick(podIndex, playerId) {
    state.winnerPicks[podIndex] = playerId;
    const card = document.querySelector(`.pod-card[data-pod-index="${podIndex}"]`);
    if (card) {
      card.querySelectorAll('.pod-player').forEach((label) => {
        const input = label.querySelector('input[type="radio"]');
        label.classList.toggle('pod-player--winner', !!input && input.value === playerId);
      });
    }
    renderSubmitControls();
  }

  /** A pick only counts while the chosen player is still on the roster and in the pod. */
  function pickIsValid(podIndex) {
    const id = state.winnerPicks[podIndex];
    if (!id) return false;
    const pod = state.pods[podIndex];
    if (!pod || !pod.includes(id)) return false;
    return state.players.some((p) => p.id === id && !p.out);
  }

  function renderPodsView() {
    renderGenerateControls();
    renderStaleBanner();
    renderFivePanel();
    renderPods();
    renderSubmitControls();
  }

  function renderSubmitControls() {
    const btn = $('submitRoundBtn');
    const helper = $('submitHelper');
    btn.textContent = `Submit round ${state.roundNumber}`;
    const n = state.pods.length;
    if (n === 0) {
      btn.disabled = true;
      helper.textContent = 'Generate groups first, then tap a winner in each pod.';
      helper.hidden = false;
      return;
    }
    const done = state.pods.reduce((acc, _pod, i) => acc + (pickIsValid(i) ? 1 : 0), 0);
    if (done === n) {
      btn.disabled = false;
      helper.hidden = true;
    } else {
      btn.disabled = true;
      helper.textContent = `Tap a winner in every pod — ${done} of ${n} selected.`;
      helper.hidden = false;
    }
  }

  function submitRound() {
    if (state.pods.length === 0) return;
    for (let i = 0; i < state.pods.length; i++) {
      if (!pickIsValid(i)) {
        toast('Tap a winner in every pod before submitting.');
        return;
      }
    }
    const recorded = state.roundNumber;
    state.results.push({
      round: recorded,
      at: Date.now(),
      pods: state.pods.map((pod, i) => ({
        players: pod.filter((id) => state.players.some((p) => p.id === id && !p.out)).map(nameOf),
        winner: nameOf(state.winnerPicks[i]),
      })),
      satOut: currentSitterIds().map(nameOf),
      durationMinutes: state.settings.durationMinutes,
    });
    state.roundNumber += 1;
    state.winnerPicks = {};
    renderPods(); // radios back to unchecked
    renderSubmitControls();
    renderResults();
    scheduleSave();
    toast(`Round ${recorded} recorded.`);
  }

  // --------------------------------------------------------------------------
  // Results (a day's recorded rounds + CSV export)
  // --------------------------------------------------------------------------
  function renderResults() {
    const list = $('resultsList');
    list.textContent = '';
    const count = state.results.length;
    $('resultsSummary').textContent = count === 1 ? '1 round' : `${count} rounds`;
    $('downloadCsvBtn').disabled = count === 0;
    if (count === 0) {
      list.append(
        el('p', 'empty-note', 'No rounds recorded yet. Generate pods, tap a winner in each pod, then press "Submit round".')
      );
      return;
    }
    for (const result of state.results) {
      const card = el('article', 'result-card');
      const head = el('div', 'result-card__head');
      head.append(el('h3', 'result-card__title', `Round ${result.round}`));
      head.append(el('span', 'result-card__time', formatDateTime(result.at)));
      card.append(head);
      const podsList = el('ul', 'result-card__pods');
      result.pods.forEach((pod, i) => {
        const li = el('li', 'result-round__pod');
        li.append(el('span', 'result-round__label', `Pod ${i + 1}`));
        li.append(el('span', 'result-round__players', pod.players.join(', ')));
        if (pod.winner) li.append(el('span', 'result-round__winner', `🏆 ${pod.winner}`));
        podsList.append(li);
      });
      if (result.satOut.length > 0) {
        const li = el('li', 'result-round__pod result-round__pod--sitout');
        li.append(el('span', 'result-round__label', 'Sitting out'));
        li.append(el('span', 'result-round__players', result.satOut.join(', ')));
        podsList.append(li);
      }
      card.append(podsList);
      list.append(card);
    }
  }

  function csvEscape(value) {
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Pure CSV builder (exported for the Node test harness). CRLF for spreadsheets. */
  function buildResultsCsv(results) {
    const lines = ['Round,Recorded At,Pod,Players,Winner'];
    for (const result of results) {
      const when = csvEscape(formatDateTime(result.at));
      result.pods.forEach((pod, i) => {
        lines.push(
          [result.round, when, i + 1, csvEscape(pod.players.join(', ')), csvEscape(pod.winner)].join(',')
        );
      });
      if (result.satOut.length > 0) {
        lines.push(
          [result.round, when, csvEscape('Sitting out'), csvEscape(result.satOut.join(', ')), ''].join(',')
        );
      }
    }
    return lines.join('\r\n');
  }

  function resultsCsv() {
    return buildResultsCsv(state.results);
  }

  function downloadResultsCsv() {
    if (state.results.length === 0) return;
    try {
      const blob = new Blob([resultsCsv()], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const d = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      link.href = url;
      link.download = `commander-pods-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('CSV downloaded.');
    } catch {
      toast('Download failed — your browser blocked it.');
    }
  }

  function podsPlainText() {
    const lines = state.pods.map((pod, index) => `Pod ${index + 1}: ${pod.map(nameOf).join(', ')}`);
    if (state.sittingOut.length > 0) {
      lines.push(`Sitting out: ${state.sittingOut.map(nameOf).join(', ')}`);
    }
    return lines.join('\n');
  }

  async function copyPods() {
    const text = podsPlainText();
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.left = '-9999px';
        document.body.append(helper);
        helper.select();
        copied = document.execCommand('copy');
        helper.remove();
      } catch {
        copied = false;
      }
    }
    toast(copied ? 'Pods copied to clipboard' : 'Copy failed — select the pod text above to copy manually');
  }

  // --------------------------------------------------------------------------
  // Round timer (timestamp-based: no setInterval drift)
  // --------------------------------------------------------------------------
  function startTicking() {
    stopTicking();
    timer.tickId = setInterval(tick, TICK_MS);
    tick();
  }

  function stopTicking() {
    if (timer.tickId !== null) {
      clearInterval(timer.tickId);
      timer.tickId = null;
    }
  }

  function startTimer() {
    ensureAudio(); // user gesture — unlock Web Audio for the alarm
    timer.durationMs = state.settings.durationMinutes * 60000;
    timer.endAt = Date.now() + timer.durationMs; // absolute timestamp
    timer.remainingMs = timer.durationMs;
    timer.status = 'running';
    startTicking();
    renderTimer();
  }

  function pauseTimer() {
    if (timer.status !== 'running') return;
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    timer.status = 'paused';
    stopTicking();
    renderTimer();
  }

  function resumeTimer() {
    if (timer.status !== 'paused') return;
    ensureAudio();
    timer.endAt = Date.now() + Math.max(0, timer.remainingMs); // re-anchor: no drift
    timer.status = 'running';
    startTicking();
    renderTimer();
  }

  function resetTimer() {
    stopAlarm();
    stopTicking();
    timer.status = 'idle';
    timer.endAt = 0;
    timer.remainingMs = state.settings.durationMinutes * 60000;
    renderTimer();
  }

  function tick() {
    if (timer.status !== 'running') return;
    const remaining = timer.endAt - Date.now();
    if (remaining <= 0) {
      timer.remainingMs = 0;
      timer.status = 'finished';
      stopTicking();
      renderTimer();
      fireAlarm();
    } else {
      timer.remainingMs = remaining;
      renderTimer();
    }
  }

  function renderTimer() {
    if (timer.status === 'idle') {
      timer.durationMs = state.settings.durationMinutes * 60000;
      timer.remainingMs = timer.durationMs;
    }
    const display = $('timerDisplay');
    const shown = timer.status === 'idle' ? timer.durationMs : timer.remainingMs;
    display.textContent = formatClock(shown);

    const counting = timer.status === 'running' || timer.status === 'paused';
    display.classList.toggle('timer-display--warn', counting && shown <= WARN_MS && shown > DANGER_MS);
    display.classList.toggle(
      'timer-display--danger',
      (counting && shown <= DANGER_MS) || timer.status === 'finished'
    );
    display.classList.toggle('timer-display--paused', timer.status === 'paused');

    const endsAt = $('endsAt');
    if (timer.status === 'running') endsAt.textContent = `Ends ${timeOfDay(timer.endAt)}`;
    else if (timer.status === 'paused') endsAt.textContent = 'Paused';
    else if (timer.status === 'finished') endsAt.textContent = 'Round complete';
    else endsAt.textContent = 'Not started';

    $('startBtn').hidden = !(timer.status === 'idle' || timer.status === 'finished');
    $('pauseBtn').hidden = timer.status !== 'running';
    $('resumeBtn').hidden = timer.status !== 'paused';
    $('resetTimerBtn').disabled = timer.status === 'idle';
  }

  function renderPresets() {
    document.querySelectorAll('.preset').forEach((btn) => {
      const minutes = Number(btn.dataset.minutes);
      btn.setAttribute('aria-pressed', String(minutes === state.settings.durationMinutes));
    });
  }

  function setDuration(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return;
    state.settings.durationMinutes = minutes;
    hideCustomError();
    renderPresets();
    renderTimer(); // running/paused timers are untouched until the next Start
    scheduleSave();
  }

  function showCustomError(message) {
    const err = $('customError');
    err.textContent = message;
    err.hidden = false;
    $('customMinutes').setAttribute('aria-invalid', 'true');
  }

  function hideCustomError() {
    const err = $('customError');
    if (err) err.hidden = true;
    const input = $('customMinutes');
    if (input) input.removeAttribute('aria-invalid');
  }

  function applyCustomMinutes() {
    const raw = $('customMinutes').value.trim();
    const value = Number(raw);
    const valid = raw !== '' && Number.isInteger(value) && value >= 1 && value <= 600;
    if (!valid) {
      showCustomError('Enter a whole number of minutes between 1 and 600.');
      return;
    }
    $('customMinutes').value = '';
    setDuration(value);
  }

  // --------------------------------------------------------------------------
  // Alarm (Web Audio oscillators, overlay, flashing title)
  // --------------------------------------------------------------------------
  function ensureAudio() {
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    } catch {
      return null;
    }
  }

  function scheduleBeepGroup(ctx, output) {
    const t0 = ctx.currentTime + 0.05;
    [880, 660, 880].forEach((freq, i) => {
      const start = t0 + i * 0.24;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.21);
      osc.connect(gain);
      gain.connect(output);
      osc.start(start);
      osc.stop(start + 0.26);
    });
  }

  function startAlarmSound() {
    if (alarm.soundRunning || !state.settings.soundEnabled) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    alarm.masterGain = master;
    alarm.soundRunning = true;
    const loop = () => {
      if (!alarm.active || !alarm.soundRunning) return;
      if (Date.now() - alarm.startedAt >= ALARM_MAX_MS) {
        stopAlarmSound(); // 60 s cap; the overlay stays until acknowledged
        return;
      }
      scheduleBeepGroup(ctx, master);
      alarm.timeouts.push(setTimeout(loop, 1100));
    };
    loop();
  }

  function stopAlarmSound() {
    alarm.soundRunning = false;
    for (const id of alarm.timeouts) clearTimeout(id);
    alarm.timeouts = [];
    if (alarm.masterGain) {
      try {
        alarm.masterGain.disconnect();
      } catch {
        /* ignore */
      }
      alarm.masterGain = null;
    }
  }

  function fireAlarm() {
    if (alarm.active) return; // never double-fire
    alarm.active = true;
    alarm.startedAt = Date.now();
    $('alarmOverlay').hidden = false;
    $('stopAlarmBtn').focus();
    startAlarmSound();
    alarm.flashOn = false;
    alarm.titleFlashId = setInterval(() => {
      alarm.flashOn = !alarm.flashOn;
      document.title = alarm.flashOn ? '⏰ TIME — Commander Pods' : alarm.originalTitle;
    }, 900);
  }

  function stopAlarm() {
    if (!alarm.active) return;
    alarm.active = false;
    stopAlarmSound();
    if (alarm.titleFlashId !== null) {
      clearInterval(alarm.titleFlashId);
      alarm.titleFlashId = null;
    }
    document.title = alarm.originalTitle;
    $('alarmOverlay').hidden = true;
  }

  // --------------------------------------------------------------------------
  // Sound toggle
  // --------------------------------------------------------------------------
  function renderSound() {
    const btn = $('muteBtn');
    const on = state.settings.soundEnabled;
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '🔊 Sound on' : '🔇 Muted';
  }

  function toggleSound() {
    state.settings.soundEnabled = !state.settings.soundEnabled;
    renderSound();
    if (alarm.active) {
      if (state.settings.soundEnabled) startAlarmSound();
      else stopAlarmSound();
    }
    scheduleSave();
  }

  // --------------------------------------------------------------------------
  // Reset day (start-of-day data wipe, two-step inline confirm)
  // --------------------------------------------------------------------------
  function setResetConfirm(show) {
    $('resetBtn').hidden = show;
    $('resetConfirm').hidden = !show;
    if (show) $('resetYes').focus();
    else $('resetBtn').focus();
  }

  function doResetDay() {
    stopAlarm();
    stopTicking();
    timer.status = 'idle';
    timer.endAt = 0;
    clearPendingUndo();
    if (saveTimerId) {
      clearTimeout(saveTimerId); // never let a pending write resurrect the data
      saveTimerId = null;
    }
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable — nothing stored anyway */
    }
    state.players = [];
    state.pods = [];
    state.sittingOut = [];
    state.history = [];
    state.winnerPicks = {};
    state.roundNumber = 1;
    state.results = [];
    state.settings = { durationMinutes: DEFAULTS.durationMinutes, soundEnabled: DEFAULTS.soundEnabled };
    fiveChoicePending = false;
    editingId = null;
    hideAddError();
    hideCustomError();
    renderAll();
    toast('All data cleared — fresh start.');
  }

  // --------------------------------------------------------------------------
  // Tabs
  // --------------------------------------------------------------------------
  function selectTab(name, moveFocus) {
    for (const tabName of TAB_NAMES) {
      const tab = $(`tab-${tabName}`);
      const panel = $(`panel-${tabName}`);
      const selected = tabName === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
    if (moveFocus) $(`tab-${name}`).focus();
  }

  function handleTabKeydown(event, current) {
    const idx = TAB_NAMES.indexOf(current);
    let target = null;
    if (event.key === 'ArrowRight') target = TAB_NAMES[(idx + 1) % TAB_NAMES.length];
    else if (event.key === 'ArrowLeft') target = TAB_NAMES[(idx - 1 + TAB_NAMES.length) % TAB_NAMES.length];
    else if (event.key === 'Home') target = TAB_NAMES[0];
    else if (event.key === 'End') target = TAB_NAMES[TAB_NAMES.length - 1];
    if (target) {
      event.preventDefault();
      selectTab(target, true);
    }
  }

  // --------------------------------------------------------------------------
  // Events & init
  // --------------------------------------------------------------------------
  function bindEvents() {
    // Roster
    $('addPlayerForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('playerNameInput');
      if (addPlayer(input.value)) {
        input.value = '';
        input.focus();
      }
    });

    // Pods
    $('generateBtn').addEventListener('click', generatePods);
    $('staleRegenBtn').addEventListener('click', generatePods);
    $('fiveHouseBtn').addEventListener('click', () => applyFiveChoice(true));
    $('fiveSitOutBtn').addEventListener('click', () => applyFiveChoice(false));
    $('copyPodsBtn').addEventListener('click', copyPods);
    $('submitRoundBtn').addEventListener('click', submitRound);
    $('downloadCsvBtn').addEventListener('click', downloadResultsCsv);

    // Timer
    $('startBtn').addEventListener('click', startTimer);
    $('pauseBtn').addEventListener('click', pauseTimer);
    $('resumeBtn').addEventListener('click', resumeTimer);
    $('resetTimerBtn').addEventListener('click', resetTimer);
    document.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => setDuration(Number(btn.dataset.minutes)));
    });
    $('customForm').addEventListener('submit', (event) => {
      event.preventDefault();
      applyCustomMinutes();
    });
    $('muteBtn').addEventListener('click', toggleSound);

    // Alarm overlay
    $('stopAlarmBtn').addEventListener('click', stopAlarm);
    $('alarmOverlay').addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        $('stopAlarmBtn').focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        stopAlarm();
      }
    });

    // Reset day
    $('resetBtn').addEventListener('click', () => setResetConfirm(true));
    $('resetYes').addEventListener('click', () => {
      doResetDay();
      setResetConfirm(false);
    });
    $('resetNo').addEventListener('click', () => setResetConfirm(false));

    // Storage notice
    $('storageNoticeClose').addEventListener('click', () => {
      $('storageNotice').hidden = true;
    });

    // Tabs
    for (const name of TAB_NAMES) {
      const tab = $(`tab-${name}`);
      tab.addEventListener('click', () => selectTab(name, false));
      tab.addEventListener('keydown', (event) => handleTabKeydown(event, name));
    }

    // Flush any pending debounced write before the page goes away
    window.addEventListener('pagehide', () => {
      if (saveTimerId) {
        clearTimeout(saveTimerId);
        saveTimerId = null;
        persistNow();
      }
    });

    // Catch up immediately when the tab becomes visible again
    // (background throttling / device sleep — the timestamp math stays correct)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && timer.status === 'running') tick();
    });
  }

  function renderAll() {
    renderRoster();
    renderPodsView();
    renderResults();
    renderPresets();
    renderTimer();
    renderSound();
  }

  function init() {
    if (typeof document === 'undefined') return; // non-browser context (e.g. node)
    alarm.originalTitle = document.title;
    storageOk = storageAvailable();
    if (storageOk) {
      const doc = readStoredDoc();
      if (doc) hydrate(doc);
    } else {
      showStorageNotice(); // private mode / blocked storage: run in memory
    }
    bindEvents();
    renderAll();
    selectTab('roster', false);
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('selftest') === '1') runSelfTest();
    } catch {
      /* ignore */
    }
  }

  init();

  // Exposed for the hidden self-test mode and manual QA. Harmless in production.
  globalThis.CommanderPods = { computePodSizes, runSelfTest, buildResultsCsv };
})();
