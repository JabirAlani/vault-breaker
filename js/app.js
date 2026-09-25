/* Vault Breaker: page logic.
 * Wires the DOM in index.html to the simulated assistant in engine.js and the
 * level definitions in levels.js. All progress and chat history is kept in
 * localStorage so a reload doesn't lose anything.
 */
(function () {
  "use strict";

  const LEVELS = window.VAULT_LEVELS;
  const Engine = window.VaultEngine;
  const STORAGE_KEY = "vault-breaker-state-v1";

  const SAMPLE_STATEMENT =
    "02 Sep  Tesco Stores        £42.18\n" +
    "03 Sep  TfL Travel          £8.40\n" +
    "05 Sep  Salary Northbridge  £2,450.00";

  // ---------- state ----------
  function freshLevelState() {
    return {
      solved: false,
      prompts: 0,
      blocked: 0,
      hintsShown: 0,
      chat: [], // { who: 'bot' | 'user' | 'event', text, layer, detail }
      engine: { lastSecret: false, suspicion: 0 },
      doc: SAMPLE_STATEMENT
    };
  }

  function freshState() {
    const levels = {};
    for (const L of LEVELS) levels[L.id] = freshLevelState();
    return { current: 1, levels };
  }

  function load() {
    let s = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) s = JSON.parse(raw);
    } catch (e) {
      s = null;
    }
    if (!s || !s.levels) s = freshState();
    // Fill in any levels missing from a saved state (e.g. after an update).
    for (const L of LEVELS) if (!s.levels[L.id]) s.levels[L.id] = freshLevelState();
    return s;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable; progress just won't persist */
    }
  }

  let state = load();

  // ---------- element refs ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    progressCount: $("progress-count"),
    vaultList: $("vault-list"),
    resetBtn: $("reset-btn"),
    resetConfirm: $("reset-confirm"),
    resetYes: $("reset-yes"),
    resetNo: $("reset-no"),
    eyebrow: $("level-eyebrow"),
    name: $("level-name"),
    chips: $("level-chips"),
    chat: $("chat"),
    attach: $("attach"),
    docInput: $("doc-input"),
    composer: $("composer"),
    promptInput: $("prompt-input"),
    guessForm: $("guess-form"),
    guessInput: $("guess-input"),
    guessFeedback: $("guess-feedback"),
    hintList: $("hint-list"),
    hintBtn: $("hint-btn"),
    statPrompts: $("stat-prompts"),
    statBlocked: $("stat-blocked"),
    dial: $("dial"),
    debrief: $("debrief"),
    debriefEyebrow: $("debrief-eyebrow"),
    debriefTitle: $("debrief-title"),
    dDefence: $("d-defence"),
    dBeat: $("d-beat"),
    dControl: $("d-control"),
    dSlide: $("d-slide"),
    nextBtn: $("next-btn"),
    stayBtn: $("stay-btn"),
    finale: $("finale"),
    resultsBody: $("results-body"),
    copyBtn: $("copy-btn"),
    finaleClose: $("finale-close"),
    copyFallback: $("copy-fallback")
  };

  function levelById(id) {
    return LEVELS.find((L) => L.id === id);
  }

  function solvedCount() {
    return LEVELS.filter((L) => state.levels[L.id].solved).length;
  }

  // ---------- rendering ----------
  function renderProgress() {
    el.progressCount.textContent = `${solvedCount()} / ${LEVELS.length}`;
  }

  function renderVaultList() {
    el.vaultList.innerHTML = "";
    for (const L of LEVELS) {
      const ls = state.levels[L.id];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vault-btn" + (ls.solved ? " solved" : "");
      btn.setAttribute("aria-current", String(L.id === state.current));
      btn.innerHTML =
        `<span class="vault-num">${ls.solved ? "✓" : L.id}</span>` +
        `<span><span class="vault-name">${escapeHtml(L.name)}</span>` +
        `<span class="vault-sub">${escapeHtml(L.defence)}</span></span>` +
        `<span class="vault-state">${ls.solved ? "✓" : ""}</span>`;
      btn.addEventListener("click", () => selectLevel(L.id));
      li.appendChild(btn);
      el.vaultList.appendChild(li);
    }
  }

  function renderChips(level) {
    el.chips.innerHTML = "";
    if (!level.chips.length) {
      const li = document.createElement("li");
      li.className = "chip none";
      li.textContent = "None";
      el.chips.appendChild(li);
      return;
    }
    for (const c of level.chips) {
      const li = document.createElement("li");
      li.className = "chip";
      li.textContent = c;
      el.chips.appendChild(li);
    }
  }

  function bubbleFor(msg) {
    if (msg.who === "event") {
      const div = document.createElement("div");
      div.className = "event";
      div.innerHTML = `<span><b>${escapeHtml(msg.layer)}:</b> ${escapeHtml(msg.detail)}</span>`;
      return div;
    }
    const wrap = document.createElement("div");
    wrap.className = "msg " + (msg.who === "user" ? "user" : "bot");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = msg.who === "user" ? "You" : "Sentinel";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    wrap.appendChild(who);
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderChat(level, ls) {
    el.chat.innerHTML = "";
    if (!ls.chat.length) {
      ls.chat.push({ who: "bot", text: level.greeting });
    }
    for (const msg of ls.chat) el.chat.appendChild(bubbleFor(msg));
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function renderHints(level, ls) {
    el.hintList.innerHTML = "";
    for (let i = 0; i < ls.hintsShown; i++) {
      const li = document.createElement("li");
      li.textContent = level.hints[i];
      el.hintList.appendChild(li);
    }
    el.hintBtn.disabled = ls.hintsShown >= level.hints.length;
    el.hintBtn.textContent = ls.hintsShown >= level.hints.length ? "No more hints" : "Show a hint";
  }

  function renderStats(ls) {
    el.statPrompts.textContent = String(ls.prompts);
    el.statBlocked.textContent = String(ls.blocked);
  }

  function renderLevel() {
    const level = levelById(state.current);
    const ls = state.levels[level.id];

    el.eyebrow.textContent = `Vault ${level.id} of ${LEVELS.length}`;
    el.name.textContent = level.name;
    renderChips(level);
    renderChat(level, ls);
    renderHints(level, ls);
    renderStats(ls);

    el.attach.hidden = !level.config.doc;
    el.docInput.value = ls.doc;

    el.guessInput.value = "";
    el.guessFeedback.textContent = "";
    el.guessFeedback.className = "guess-feedback";

    el.dial.classList.toggle("open", ls.solved);

    renderVaultList();
    renderProgress();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- actions ----------
  function selectLevel(id) {
    state.current = id;
    save();
    renderLevel();
  }

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const level = levelById(state.current);
    const ls = state.levels[level.id];
    const text = el.promptInput.value.trim();
    if (!text) return;

    ls.chat.push({ who: "user", text });
    ls.prompts++;

    const result = Engine.respond(level, text, { doc: el.docInput.value, state: ls.engine });
    ls.doc = el.docInput.value;

    if (result.blocked) {
      ls.blocked++;
      ls.chat.push({ who: "event", layer: result.blocked.layer, detail: result.blocked.detail });
      ls.chat.push({ who: "bot", text: result.reply });
    } else {
      ls.chat.push({ who: "bot", text: result.reply });
    }

    el.promptInput.value = "";
    save();
    renderChat(level, ls);
    renderStats(ls);
  });

  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.composer.requestSubmit ? el.composer.requestSubmit() : el.composer.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  el.guessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const level = levelById(state.current);
    const ls = state.levels[level.id];
    const guess = el.guessInput.value;
    if (!guess.trim()) return;

    if (Engine.checkGuess(level, guess)) {
      ls.solved = true;
      save();
      renderVaultList();
      renderProgress();
      el.dial.classList.add("open");
      el.guessFeedback.textContent = "Vault open!";
      el.guessFeedback.className = "guess-feedback good";
      showDebrief(level);
    } else {
      el.guessFeedback.textContent = "Not quite. Keep talking to Sentinel.";
      el.guessFeedback.className = "guess-feedback bad";
    }
  });

  el.hintBtn.addEventListener("click", () => {
    const level = levelById(state.current);
    const ls = state.levels[level.id];
    if (ls.hintsShown >= level.hints.length) return;
    ls.hintsShown++;
    save();
    renderHints(level, ls);
  });

  el.resetBtn.addEventListener("click", () => {
    el.resetConfirm.hidden = false;
  });
  el.resetNo.addEventListener("click", () => {
    el.resetConfirm.hidden = true;
  });
  el.resetYes.addEventListener("click", () => {
    state = freshState();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
    el.resetConfirm.hidden = true;
    renderLevel();
  });

  // ---------- debrief ----------
  function showDebrief(level) {
    el.debriefEyebrow.textContent = "Vault opened";
    el.debriefTitle.textContent = level.name;
    el.dDefence.textContent = level.debrief.defence;
    el.dBeat.textContent = level.debrief.beat;
    el.dControl.textContent = level.debrief.control;
    el.dSlide.textContent = level.debrief.slide;
    el.nextBtn.textContent = level.id < LEVELS.length ? "Next vault" : "See results";
    el.debrief.hidden = false;
  }

  el.stayBtn.addEventListener("click", () => {
    el.debrief.hidden = true;
  });

  el.nextBtn.addEventListener("click", () => {
    el.debrief.hidden = true;
    const level = levelById(state.current);
    if (level.id < LEVELS.length) {
      selectLevel(level.id + 1);
    } else if (solvedCount() === LEVELS.length) {
      showFinale();
    } else {
      renderLevel();
    }
  });

  // ---------- finale ----------
  function showFinale() {
    el.resultsBody.innerHTML = "";
    for (const L of LEVELS) {
      const ls = state.levels[L.id];
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(L.name)}</td><td>${escapeHtml(L.defence)}</td><td class="num">${ls.prompts}</td>`;
      el.resultsBody.appendChild(tr);
    }
    el.copyFallback.hidden = true;
    el.finale.hidden = false;
  }

  el.finaleClose.addEventListener("click", () => {
    el.finale.hidden = true;
  });

  el.copyBtn.addEventListener("click", async () => {
    const lines = ["Vault Breaker results", ""];
    for (const L of LEVELS) {
      const ls = state.levels[L.id];
      lines.push(`${L.id}. ${L.name} (${L.defence}) — ${ls.prompts} prompt${ls.prompts === 1 ? "" : "s"}`);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      el.copyFallback.hidden = true;
    } catch (e) {
      el.copyFallback.hidden = false;
      el.copyFallback.value = text;
      el.copyFallback.focus();
      el.copyFallback.select();
    }
  });

  // ---------- init ----------
  if (!LEVELS.find((L) => L.id === state.current)) state.current = LEVELS[0].id;
  renderLevel();
})();
