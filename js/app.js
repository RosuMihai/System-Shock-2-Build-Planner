/* ==========================================================================
   System Shock 2 Build Planner
   Plain JavaScript; all game data is loaded from the JSON files in /data.

   The build keeps what was *bought* with Cyber Modules separate from what the
   chosen career grants for free. A skill's level = minimum + career bonus +
   bought levels, and only the bought levels cost modules.
   ========================================================================== */
(() => {
  "use strict";

  const STORAGE_KEY = "ss2-build-planner-v2";
  const GROUPS = ["attributes", "weapons", "tech"];
  const PANELS = ["attributes", "weapons", "tech", "psi", "os"];
  const ROW_TOP = 44, ROW_STEP = 68;
  const PSI_COLS = [31, 171], PSI_ROW_TOP = 67, PSI_ROW_STEP = 62;
  const OS_COLS = [29, 99, 169, 239], OS_ROWS = [152, 220, 288, 356];

  let DB = null;           // { costs, disciplines, psi, items, decks, careers, os }
  let state = null;        // the build
  const ui = { help: {}, reset: {}, rows: {} };
  let psiTab = 0;

  /* ------------------------------------------------------------------ data */

  async function loadData() {
    const files = ["costs", "disciplines", "psi", "items", "decks", "careers", "os-upgrades"];
    const results = await Promise.all(files.map(async f => {
      const res = await fetch(`data/${f}.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`data/${f}.json: HTTP ${res.status}`);
      return res.json();
    }));
    const db = {};
    files.forEach((f, i) => { db[f] = results[i]; });

    db.psiFlat = [];
    db.psiById = {};
    db.psi.tiers.forEach((t, ti) => {
      const cap = { ...t.capacity, tier: ti, isCap: true };
      db.psiFlat.push(cap);
      db.psiById[cap.id] = cap;
      t.powers.forEach(p => {
        const pw = { ...p, tier: ti, isCap: false };
        db.psiFlat.push(pw);
        db.psiById[pw.id] = pw;
      });
    });
    let cum = 0;
    db.decks.decks.forEach(d => { cum += d.modules; d.cumulative = cum; });
    db.maxModules = db.costs.maxModules;

    db.os = db["os-upgrades"];
    db.osById = {};
    db.os.upgrades.forEach((u, i) => { u.index = i; db.osById[u.id] = u; });
    db.os.stations.forEach(st => { st.deckIndex = db.decks.decks.findIndex(d => d.id === st.deck); });

    db.itemById = {};
    db.items.categories.forEach(c => c.items.forEach(it => { db.itemById[it.id] = it; }));
    db.implantList = Object.values(db.itemById).filter(it => it.implant);
    return db;
  }

  /* ----------------------------------------------------------------- state */

  function freshState(difficulty) {
    const s = {
      difficulty: difficulty || DB.costs.defaultDifficulty,
      career: null,                         // { branch: "marine", picks: [0, 2, 1] }
      bought: {},                           // bought[group][id] = levels bought with modules
      psiTiers: [false, false, false, false, false], // tiers bought with modules
      psiPowers: {},                        // disciplines bought with modules
      os: [],                               // O/S upgrade ids, in the order the stations were used
      implants: []                          // equipped implant item ids (1 slot, 2 with Cybernetically Enhanced)
    };
    GROUPS.forEach(g => {
      s.bought[g] = {};
      DB.disciplines[g].entries.forEach(e => { s.bought[g][e.id] = 0; });
    });
    return s;
  }

  function validCareer(c) {
    if (!c || typeof c !== "object") return null;
    const b = DB.careers.branches.find(x => x.id === c.branch);
    if (!b || !Array.isArray(c.picks) || c.picks.length !== b.years.length) return null;
    if (!c.picks.every((p, y) => Number.isInteger(p) && p >= 0 && p < b.years[y].length)) return null;
    return { branch: b.id, picks: c.picks.slice() };
  }

  // Drops anything that is impossible for the current career (over-max levels,
  // duplicate psi purchases, disciplines without a tier).
  function normalize(s) {
    const prev = state;
    state = s;
    GROUPS.forEach(g => {
      const def = DB.disciplines[g];
      def.entries.forEach(e => {
        const room = def.max - baseLevel(g, e.id);
        s.bought[g][e.id] = Math.max(0, Math.min(room, s.bought[g][e.id] | 0));
      });
    });
    const granted = careerGrants().psi;
    DB.psiFlat.forEach(p => {
      if (p.isCap && granted.has(p.id)) s.psiTiers[p.tier] = false;
      if (!p.isCap && s.psiPowers[p.id] && (granted.has(p.id) || !tierOwned(p.tier))) delete s.psiPowers[p.id];
    });
    pruneImplants();
    state = prev;
    return s;
  }

  function sanitize(raw) {
    const s = freshState();
    if (!raw || typeof raw !== "object") return s;
    if (DB.costs.tables[raw.difficulty]) s.difficulty = raw.difficulty;
    s.career = validCareer(raw.career);
    GROUPS.forEach(g => {
      DB.disciplines[g].entries.forEach(e => {
        const v = raw.bought && raw.bought[g] && Number(raw.bought[g][e.id]);
        if (Number.isInteger(v) && v > 0) s.bought[g][e.id] = v;
      });
    });
    if (Array.isArray(raw.psiTiers)) s.psiTiers = s.psiTiers.map((_, i) => !!raw.psiTiers[i]);
    if (raw.psiPowers && typeof raw.psiPowers === "object") {
      DB.psiFlat.forEach(p => { if (!p.isCap && raw.psiPowers[p.id]) s.psiPowers[p.id] = true; });
    }
    if (Array.isArray(raw.os)) {
      s.os = [...new Set(raw.os.filter(id => DB.osById[id]))].slice(0, DB.os.points);
    }
    if (Array.isArray(raw.implants)) {
      s.implants = [...new Set(raw.implants.filter(id => DB.itemById[id] && DB.itemById[id].implant))];
    }
    s.implants = s.implants.slice(0, implantSlots(s));
    return normalize(s);
  }

  // Share code kept in the URL hash:
  // <diff>.<career>.<bought digits>.<tier bits>.<power bits, base 36>.<O/S picks, one base-36 digit each>
  // .<equipped implants, one base-36 digit each>
  function encodeBuild(s) {
    const diff = DB.costs.difficulties.findIndex(d => d.id === s.difficulty);
    const career = s.career
      ? DB.careers.branches.findIndex(b => b.id === s.career.branch) + s.career.picks.join("")
      : "x";
    const lv = GROUPS.map(g => DB.disciplines[g].entries.map(e => s.bought[g][e.id]).join("")).join("");
    const tiers = s.psiTiers.map(b => (b ? 1 : 0)).join("");
    const powers = DB.psiFlat.filter(p => !p.isCap).map(p => (s.psiPowers[p.id] ? 1 : 0)).join("");
    const os = (s.os || []).map(id => DB.osById[id].index.toString(36)).join("") || "x";
    const imp = (s.implants || []).map(id => DB.implantList.indexOf(DB.itemById[id]).toString(36)).join("") || "x";
    return `${diff}.${career}.${lv}.${tiers}.${BigInt("0b" + powers).toString(36)}.${os}.${imp}`;
  }

  function decodeBuild(code) {
    try {
      const [d, c, lv, tiers, powers, os, imp] = code.split(".");
      if (powers === undefined) return null;
      const s = { difficulty: DB.costs.difficulties[Number(d)].id, career: null, bought: {}, psiTiers: [], psiPowers: {}, os: [], implants: [] };
      if (imp && imp !== "x") {
        s.implants = imp.split("").map(ch => DB.implantList[parseInt(ch, 36)]).filter(Boolean).map(it => it.id);
      }
      if (os && os !== "x") {
        s.os = os.split("").map(ch => DB.os.upgrades[parseInt(ch, 36)]).filter(Boolean).map(u => u.id);
      }
      if (c !== "x") {
        const b = DB.careers.branches[Number(c[0])];
        s.career = b ? { branch: b.id, picks: c.slice(1).split("").map(Number) } : null;
      }
      let i = 0;
      GROUPS.forEach(g => {
        s.bought[g] = {};
        DB.disciplines[g].entries.forEach(e => { s.bought[g][e.id] = Number(lv[i++]) || 0; });
      });
      s.psiTiers = tiers.split("").map(ch => ch === "1");
      const list = DB.psiFlat.filter(p => !p.isCap);
      let n = 0n;
      for (const ch of powers) n = n * 36n + BigInt(parseInt(ch, 36));
      const bits = n.toString(2).padStart(list.length, "0");
      list.forEach((p, k) => { if (bits[k] === "1") s.psiPowers[p.id] = true; });
      return s;
    } catch (_) {
      return null;
    }
  }

  // True while the page shows a build that came from a link and differs from the
  // visitor's own saved build. The saved build is left alone until they choose.
  let shared = false;

  function save() {
    if (!shared) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* storage unavailable */ }
    }
    try { window.history.replaceState(null, "", "#" + encodeBuild(state)); } catch (_) { /* ignore */ }
  }

  // The build in the URL hash, or null if there is none or it can't be read.
  function hashBuild() {
    let code = location.hash.slice(1);
    if (!code) return null;
    try { code = decodeURIComponent(code); } catch (_) { return null; }
    const decoded = decodeBuild(code);
    return decoded ? sanitize(decoded) : null;
  }

  function storedBuild() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitize(JSON.parse(raw)) : null;
    } catch (_) {
      return null;
    }
  }

  // Whether showing `build` would hide a saved build worth keeping.
  function hidesSavedBuild(build) {
    const own = storedBuild();
    if (!own) return false;
    const code = encodeBuild(own);
    return code !== encodeBuild(freshState(own.difficulty)) && code !== encodeBuild(build);
  }

  function restore() {
    const fromHash = hashBuild();
    if (fromHash) {
      shared = hidesSavedBuild(fromHash);
      return fromHash;
    }
    return storedBuild() || freshState();
  }

  // Swaps in a different build (from a pasted link, or the saved one).
  function adoptBuild(build) {
    state = build;
    hideTooltip();
    if (career.open) closeCareer();
    commit();
    PANELS.forEach(p => setHelp(p, idleHelp(p)));
    if (!state.career) openCareer(false);
  }

  // A build link pasted into a tab that already has the planner open.
  function onHashChange() {
    const next = hashBuild();
    if (!next) { save(); return; }          // unreadable: put the current build's link back
    if (encodeBuild(next) === encodeBuild(state)) return;
    shared = shared || hidesSavedBuild(next);
    adoptBuild(next);
  }

  function buildShareNote() {
    document.getElementById("shareKeep").addEventListener("click", () => {
      shared = false;
      commit();
    });
    document.getElementById("shareRestore").addEventListener("click", () => {
      shared = false;
      adoptBuild(storedBuild() || freshState());
    });
  }

  /* ---------------------------------------------------------------- career */

  let grantCache = { key: null, val: null };

  // Everything the chosen career path gives for free.
  function careerGrants(career = state.career) {
    const key = JSON.stringify(career);
    if (career === state.career && grantCache.key === key) return grantCache.val;
    const val = { lv: {}, psi: new Set(), steps: [] };
    if (career) {
      const b = DB.careers.branches.find(x => x.id === career.branch);
      const steps = [b.basic, ...b.years.map((opts, y) => opts[career.picks[y]])].filter(Boolean);
      steps.forEach(st => {
        Object.entries(st.grants || {}).forEach(([k, v]) => { val.lv[k] = (val.lv[k] || 0) + v; });
        (st.psi || []).forEach(id => val.psi.add(id));
        val.steps.push(st);
      });
    }
    if (career === state.career) grantCache = { key, val };
    return val;
  }

  const branchOf = career => career && DB.careers.branches.find(b => b.id === career.branch);

  function grantLabels(st) {
    const out = Object.entries(st.grants || {}).map(([k, v]) => `+${v} ${reqLabel(k)}`);
    (st.psi || []).forEach(id => out.push(DB.psiById[id].name));
    return out;
  }

  /* ---------------------------------------------------------------- levels */

  const bonus = (g, id) => careerGrants().lv[`${g}.${id}`] || 0;
  const baseLevel = (g, id) => DB.disciplines[g].min + bonus(g, id);
  const level = (g, id) => baseLevel(g, id) + state.bought[g][id];

  const psiGranted = id => careerGrants().psi.has(id);
  const tierCapId = t => DB.psi.tiers[t].capacity.id;
  const tierOwned = t => state.psiTiers[t] || psiGranted(tierCapId(t));
  const psiOwned = p => (p.isCap ? tierOwned(p.tier) : !!state.psiPowers[p.id] || psiGranted(p.id));

  /* ----------------------------------------------------------------- costs */

  const table = () => DB.costs.tables[state.difficulty];

  function levelCost(group, lvl) {
    const def = DB.disciplines[group];
    const t = table()[def.costKey];
    return t[def.costKey === "stat" ? lvl - 2 : lvl - 1];
  }

  function groupSpent(group) {
    let sum = 0;
    DB.disciplines[group].entries.forEach(e => {
      for (let l = baseLevel(group, e.id) + 1; l <= level(group, e.id); l++) sum += levelCost(group, l);
    });
    return sum;
  }

  const psiCost = p => (p.isCap ? table().psiTier[p.tier] : table().psiPower[p.tier]);

  // What one career step's free bonuses would cost in Cyber Modules on the
  // current difficulty. `got` holds the levels earlier steps already gave (each
  // level costs more than the last), and this step's levels are added to it.
  function stepValue(st, got = {}) {
    let sum = 0;
    Object.entries(st.grants || {}).forEach(([k, v]) => {
      const g = k.split(".")[0];
      const from = DB.disciplines[g].min + (got[k] || 0);
      for (let l = from + 1; l <= from + v; l++) sum += levelCost(g, l) || 0;
      got[k] = (got[k] || 0) + v;
    });
    (st.psi || []).forEach(id => { sum += psiCost(DB.psiById[id]); });
    return sum;
  }

  // The module value of each step of a career path, in order, and their total.
  function careerValue(career = state.career) {
    const got = {};
    const steps = career ? careerGrants(career).steps.map(st => stepValue(st, got)) : [];
    return { steps, total: steps.reduce((a, v) => a + v, 0) };
  }

  function psiSpent() {
    let sum = 0;
    DB.psiFlat.forEach(p => {
      if (p.isCap ? state.psiTiers[p.tier] : state.psiPowers[p.id]) sum += psiCost(p);
    });
    return sum;
  }

  const totalSpent = () => GROUPS.reduce((a, g) => a + groupSpent(g), 0) + psiSpent();

  /* ------------------------------------------------------------ O/S upgrades */

  // Sum of one effect over the installed O/S upgrades (e.g. "maxModules", "maxHp").
  const osEffect = key => state.os.reduce((a, id) => a + ((DB.osById[id].effect || {})[key] || 0), 0);

  /* --------------------------------------------------------------- implants */

  // One implant slot, plus any granted by O/S upgrades (Cybernetically Enhanced).
  function implantSlots(s = state) {
    return 1 + s.os.reduce((a, id) => a + ((DB.osById[id].effect || {}).implantSlots || 0), 0);
  }

  // Bonus that equipped implants add to a level ("attributes.str", "tech.research"...)
  // when checking item requirements. ExperTech's bonus doesn't count.
  function implantReqBonus(key) {
    return state.implants.reduce((a, id) => {
      const it = DB.itemById[id];
      return a + (it.bonusIgnoredForReq ? 0 : (it.bonus || {})[key] || 0);
    }, 0);
  }

  // Equips or removes an implant. Clicks that can't equip (not researched, or no
  // free slot) do nothing; the tooltip already explains why.
  function toggleImplant(item) {
    const k = state.implants.indexOf(item.id);
    if (k >= 0) state.implants.splice(k, 1);
    else {
      if (!itemUsable(item)) return;
      if (state.implants.length >= implantSlots()) return;
      state.implants.push(item.id);
    }
    commit();
  }
  // Takes out implants the build can no longer hold: more than the slots allow
  // (Cybernetically Enhanced removed) or requirements no longer met (Research
  // refunded, or the implant whose bonus met them removed).
  function pruneImplants() {
    const slots = implantSlots();
    if (state.implants.length > slots) state.implants.length = slots;
    for (;;) {
      const bad = state.implants.findIndex(id => !itemUsable(DB.itemById[id]));
      if (bad < 0) break;
      state.implants.splice(bad, 1);
    }
  }

  const osStation = id => DB.os.stations[state.os.indexOf(id)];

  // The module cap: the 882 found in the game plus Naturally Able's bonus.
  const capModules = () => DB.maxModules + osEffect("maxModules");
  const remaining = () => capModules() - totalSpent();

  // Modules available by the end of each level. A Naturally Able bonus counts
  // from the level whose O/S station installed it.
  function deckTotals() {
    return DB.decks.decks.map((d, i) => {
      let extra = 0;
      state.os.forEach((id, k) => {
        const add = (DB.osById[id].effect || {}).maxModules || 0;
        if (add && DB.os.stations[k] && DB.os.stations[k].deckIndex <= i) extra += add;
      });
      return d.cumulative + extra;
    });
  }

  /* --------------------------------------------------------------- actions */

  // Whether a unit has anything its RESET button could clear.
  function panelHasPurchases(panel) {
    if (panel === "os") return state.os.length > 0;
    if (panel === "psi") return state.psiTiers.some(Boolean) || Object.keys(state.psiPowers).length > 0;
    return DB.disciplines[panel].entries.some(e => state.bought[panel][e.id] > 0);
  }

  // RESET: refunds everything bought at one unit (career bonuses stay).
  function resetPanel(panel) {
    if (!panelHasPurchases(panel)) return;
    if (panel === "os") state.os = [];
    else if (panel === "psi") {
      state.psiTiers = [false, false, false, false, false];
      state.psiPowers = {};
    } else {
      DB.disciplines[panel].entries.forEach(e => { state.bought[panel][e.id] = 0; });
    }
    commit();
    setHelp(panel, idleHelp(panel));
  }

  function buyLevel(group, id, rowEl) {
    const def = DB.disciplines[group];
    const cur = level(group, id);
    if (cur >= def.max) return;
    const c = levelCost(group, cur + 1);
    if (c > remaining()) { deny(group, rowEl, c); return; }
    state.bought[group][id] += 1;
    commit();
    setHelp(group, helpRow(group, ui.rows[group][id].entry));
  }

  function refundLevel(group, id) {
    if (state.bought[group][id] <= 0) {
      if (bonus(group, id) > 0) setHelp(group, `<span class="h-title">${esc(ui.rows[group][id].entry.name)}</span><span class="h-warn">The remaining levels come from your career and can't be refunded.</span>`);
      return;
    }
    state.bought[group][id] -= 1;
    commit();
    setHelp(group, helpRow(group, ui.rows[group][id].entry));
  }

  function buyPsi(p, el) {
    if (psiOwned(p)) return;
    if (!p.isCap && !tierOwned(p.tier)) {
      setHelp("psi", helpPsi(p, `You must first purchase the Tier ${p.tier + 1} Neural Capacity.`));
      flash(el);
      return;
    }
    const c = psiCost(p);
    if (c > remaining()) { deny("psi", el, c, p); return; }
    if (p.isCap) state.psiTiers[p.tier] = true; else state.psiPowers[p.id] = true;
    commit();
    setHelp("psi", helpPsi(p));
  }

  function refundPsi(p) {
    if (psiGranted(p.id)) { setHelp("psi", helpPsi(p, "Granted by your career; it can't be refunded.")); return; }
    if (p.isCap) {
      if (!state.psiTiers[p.tier]) return;
      state.psiTiers[p.tier] = false;
      DB.psi.tiers[p.tier].powers.forEach(pw => { delete state.psiPowers[pw.id]; });
    } else {
      if (!state.psiPowers[p.id]) return;
      delete state.psiPowers[p.id];
    }
    commit();
    setHelp("psi", helpPsi(p));
  }

  function deny(panel, el, cost, psiEntry) {
    const msg = `Insufficient Cyber Modules: needs ${cost}, only ${Math.max(0, remaining())} of ${capModules()} left.`;
    if (panel === "psi") setHelp("psi", helpPsi(psiEntry, msg));
    else setHelp(panel, `<span class="h-warn">${msg}</span>`);
    flash(el);
  }

  function flash(node) {
    if (!node) return;
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }

  function commit() {
    pruneImplants();
    save();
    renderAll();
  }

  /* ----------------------------------------------------------------- input */

  // Touch screens have no hover and no right-click, so the wording and the
  // refund gesture change with the device.
  const touchUi = () => window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const say = () => (touchUi()
    ? { click: "Tap", alt: "Press and hold", altLc: "press and hold" }
    : { click: "Click", alt: "Right-click", altLc: "right-click" });

  // One handler for buying and refunding, so each physical press does exactly
  // one thing whatever events the browser makes of it:
  //   mouse:  click = tap(), right-click = hold()
  //   touch:  lifting the finger = tap(), a long press = hold() (iOS never fires
  //           contextmenu). The clicks a browser synthesizes after a touch are
  //           ignored: some send more than one for a quick double tap, which
  //           bought three levels for two taps.
  const HOLD_MS = 450, GHOST_MS = 700;
  function onPress(node, tap, hold) {
    let timer = null, armed = false, touching = false, held = false;
    let touchEndAt = 0, x0 = 0, y0 = 0;
    const disarm = () => { armed = false; clearTimeout(timer); timer = null; };
    // A long press counts once, even if both our timer and the browser's own
    // contextmenu fire for it; `held` marks that this touch already refunded.
    const touchHold = () => {
      if (held) return;
      held = true;
      hold();
    };
    node.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      disarm();
      // contextmenu during (or just after) a touch is the long press again;
      // from a mouse it is a right-click, and every right-click refunds.
      if (touching || Date.now() - touchEndAt < GHOST_MS) touchHold();
      else hold();
    });
    node.addEventListener("pointerdown", ev => {
      if (ev.pointerType === "mouse") return;
      disarm();
      touching = true; armed = true; held = false;
      x0 = ev.clientX; y0 = ev.clientY;
      timer = setTimeout(() => { timer = null; armed = false; touchHold(); }, HOLD_MS);
    });
    node.addEventListener("pointermove", ev => {
      if (armed && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) disarm();   // a scroll, not a press
    });
    node.addEventListener("pointerup", ev => {
      if (ev.pointerType === "mouse") return;
      const wasTap = armed;
      disarm();
      touching = false;
      touchEndAt = Date.now();
      if (wasTap) tap();
    });
    ["pointercancel", "pointerleave"].forEach(type => {
      node.addEventListener(type, ev => {
        if (ev.pointerType === "mouse") return;
        if (touching) touchEndAt = Date.now();
        touching = false;
        disarm();
      });
    });
    node.addEventListener("click", ev => {
      if (held || Date.now() - touchEndAt < GHOST_MS) {   // already handled as a touch
        held = false;
        ev.preventDefault();
        return;
      }
      tap();
    });
  }

  // Shows a title + text tooltip on hover, and on tap for touch screens (which
  // never show the browser's own title tooltips). get() returns [title, text].
  function tip(node, get) {
    const show = ev => { const [title, text] = get(); showTextTooltip(title, text, ev); };
    node.setAttribute("data-tip", "");
    node.addEventListener("mouseenter", show);
    node.addEventListener("mousemove", moveTooltip);
    node.addEventListener("mouseleave", hideTooltip);
    node.addEventListener("click", show);
  }

  /* ------------------------------------------------------------- rendering */

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function el(tag, attrs = {}, html = "") {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else n.setAttribute(k, v);
    }
    if (html) n.innerHTML = html;
    return n;
  }

  // Fills a unit's help box; if the text is too long for it, steps the font
  // down until it fits.
  function setHelp(panel, html) {
    const box = ui.help[panel];
    if (!box) return;
    box.innerHTML = html;
    box.classList.remove("fit-1", "fit-2", "fit-3");
    for (const cls of ["fit-1", "fit-2", "fit-3"]) {
      if (box.scrollHeight <= box.clientHeight + 1) break;
      box.classList.remove("fit-1", "fit-2", "fit-3");
      box.classList.add(cls);
    }
  }

  function idleHelp(panel) {
    const touch = touchUi();
    if (panel === "os") {
      return `<span class="h-title">O/S Upgrade Units</span><span class="h-idle">There are four O/S stations, each installing one upgrade. ${touch ? "Tap" : "Left-click"} an upgrade to install it at the next unused station, ${say().altLc} to remove it.</span>`;
    }
    const unit = panel === "psi" ? "Psi Upgrade Unit" : DB.disciplines[panel].unit;
    const how = touch
      ? "Tap an upgrade to buy its next level, press and hold to refund one."
      : "Hover an upgrade for details. Left-click buys the next level, right-click refunds one.";
    return `<span class="h-title">${esc(unit)}</span><span class="h-idle">${how} RESET refunds everything bought at this unit.</span>`;
  }

  /* --- top bar --- */

  function buildControls() {
    const wrap = document.getElementById("difficulty");
    DB.costs.difficulties.forEach(d => {
      const b = el("button", { type: "button", class: "hud-btn", role: "radio", "data-diff": d.id }, esc(d.name));
      b.addEventListener("click", () => {
        if (state.difficulty === d.id) return;
        state.difficulty = d.id;
        commit();
      });
      wrap.appendChild(b);
    });

    document.getElementById("careerBtn").addEventListener("click", () => openCareer(true));

    const reset = document.getElementById("resetAll");
    let armTimer = null;
    const disarm = () => { reset.classList.remove("armed"); reset.textContent = "Reset build"; };
    reset.addEventListener("click", () => {
      if (!reset.classList.contains("armed")) {
        reset.classList.add("armed");
        reset.textContent = "Confirm reset?";
        armTimer = setTimeout(disarm, 3000);
        return;
      }
      clearTimeout(armTimer);
      disarm();
      state = freshState(state.difficulty);
      commit();
      PANELS.forEach(p => setHelp(p, idleHelp(p)));
      openCareer(false);
    });
  }

  function renderControls() {
    document.querySelectorAll("#difficulty [data-diff]").forEach(b => {
      b.setAttribute("aria-checked", String(b.dataset.diff === state.difficulty));
    });
    const b = branchOf(state.career);
    const label = document.getElementById("careerLabel");
    const btn = document.getElementById("careerBtn");
    if (b) {
      label.textContent = b.short;
      const path = careerGrants().steps.slice(1).map(s => s.name).join(" → ");
      btn.title = `${b.name}: ${path}. Click to change your career.`;
    } else {
      label.textContent = "Choose career";
      btn.title = "Choose your service branch and tours of duty";
    }
  }

  /* --- module bar --- */

  function buildModuleBar() {
    const markers = document.getElementById("barMarkers");
    const labels = document.getElementById("barLabels");
    ui.markers = [];
    ui.barLabels = [];
    ui.deckTotals = DB.decks.decks.map(d => d.cumulative);
    ui.labelTips = [];
    ui.osMarkTips = [];
    DB.decks.decks.forEach((d, i) => {
      const m = el("div", { class: "bar-marker" });
      markers.appendChild(m);
      const lab = el("div", { class: "bar-label" }, `<b></b><span class="nm">${esc(d.short)}</span>`);
      labels.appendChild(lab);
      tip(lab, () => ui.labelTips[i]);
      ui.markers.push(m);
      ui.barLabels.push(lab);
    });
    // a small mark for each O/S Upgrade Unit, part-way through its level
    ui.osMarks = DB.os.stations.map((_, k) => {
      const m = el("div", { class: "os-mark" });
      markers.appendChild(m);
      tip(m, () => ui.osMarkTips[k]);
      return m;
    });
    positionBar();
    layoutBarLabels();
    // The track's width changes with the window, but also when a scrollbar comes
    // or goes, so watch the track itself where the browser allows it.
    let t = null;
    const relayout = () => { clearTimeout(t); t = setTimeout(layoutBarLabels, 60); };
    window.addEventListener("resize", relayout);
    if ("ResizeObserver" in window) {
      let lastW = -1;
      new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (w !== lastW) { lastW = w; relayout(); }
      }).observe(document.querySelector("#moduleBar .bar-track"));
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutBarLabels);
  }

  // Puts the level markers, labels and O/S marks where they belong on the current
  // module cap (it grows with Naturally Able).
  function positionBar() {
    const cap = capModules();
    const totals = deckTotals();
    // each level is tagged where it starts: the modules you can have when you arrive
    const starts = totals.map((_, i) => (i > 0 ? totals[i - 1] : 0));
    ui.deckTotals = totals;
    ui.tagPos = starts;
    // the career's free bonuses, priced in modules, ride next to the first tag
    const careerVal = careerValue().total;
    ui.careerVal = careerVal;
    DB.decks.decks.forEach((d, i) => {
      const pct = (starts[i] / cap) * 100;
      ui.markers[i].style.left = pct + "%";
      const lab = ui.barLabels[i];
      lab.style.left = pct + "%";
      lab.classList.toggle("edge-left", pct < 3);
      lab.classList.toggle("edge-right", pct > 97);
      const extra = i === 0 && careerVal > 0;
      lab.firstChild.innerHTML = starts[i] + (extra ? ` <span class="bar-career">(${careerVal})</span>` : "");
      ui.labelTips[i] = [d.name, (d.modules
        ? `Arrive with up to ${starts[i]} modules; ${d.modules} more to find here.`
        : `The final confrontation, with up to ${starts[i]} modules.`)
        + (extra ? ` Your career bonuses are worth ${careerVal} modules on this difficulty.` : "")];
    });
    DB.os.stations.forEach((st, k) => {
      const i = st.deckIndex;
      const start = i > 0 ? totals[i - 1] : 0;
      const pct = ((start + DB.decks.decks[i].modules * st.at) / cap) * 100;
      const mark = ui.osMarks[k];
      const used = state.os[k];
      mark.style.left = pct + "%";
      mark.classList.toggle("used", !!used);
      ui.osMarkTips[k] = [`O/S Upgrade Unit, ${st.name}`, used ? DB.osById[used].name : `${st.where}: not used`];
    });
    document.getElementById("maxValue").textContent = cap;
  }

  // Places level labels above/below the bar so none overlap. A label may slide a
  // little sideways in its row; only if that isn't enough does it get a new row.
  function layoutBarLabels() {
    const bar = document.getElementById("moduleBar");
    const track = bar.querySelector(".bar-track");
    const W = track.clientWidth;
    // a lane is as tall as the labels: two lines normally, one where the level
    // names are hidden (phones, short screens)
    const LANE = Math.max(12, ...ui.barLabels.map(l => l.offsetHeight)) + 4;
    const GAP = 8, TRACK_H = track.offsetHeight, MAX_NUDGE = 36;
    const ends = { up: [], down: [] };
    const placed = [];
    const cap = capModules();
    ui.barLabels.forEach((lab, i) => {
      lab.style.marginLeft = "";
      const x = (ui.tagPos[i] / cap) * W;
      const w = lab.offsetWidth;
      const left = lab.classList.contains("edge-right") ? x - w
        : lab.classList.contains("edge-left") ? x : x - w / 2;
      const pref = i % 2 === 0 ? "down" : "up";
      const other = pref === "up" ? "down" : "up";
      const options = [[pref, 0], [other, 0], [pref, 1], [other, 1]].map(([s, l]) => {
        const shift = Math.max(0, (ends[s][l] ?? -Infinity) + GAP - left);
        return { s, l, shift, fits: shift <= MAX_NUDGE && left + shift + w <= W + 4 };
      });
      // prefer the row next to the bar (sliding if needed), then the outer row
      const best = l => options.filter(o => o.l === l && o.fits).sort((a, b) => a.shift - b.shift)[0];
      const pick = best(0) || best(1) || options[2];
      ends[pick.s][pick.l] = left + pick.shift + w;
      if (pick.shift) lab.style.marginLeft = pick.shift + "px";
      placed.push({ lab, side: pick.s, lane: pick.l });
    });
    const upLanes = Math.max(1, ...placed.filter(p => p.side === "up").map(p => p.lane + 1));
    const downLanes = Math.max(1, ...placed.filter(p => p.side === "down").map(p => p.lane + 1));
    bar.style.paddingTop = upLanes * LANE + 4 + "px";
    bar.style.paddingBottom = downLanes * LANE + 4 + "px";
    placed.forEach(({ lab, side, lane }) => {
      lab.style.top = side === "up"
        ? (upLanes - lane - 1) * LANE + "px"
        : upLanes * LANE + 4 + TRACK_H + 6 + lane * LANE + "px";
    });
  }

  function renderModuleBar() {
    const spent = totalSpent();
    const cap = capModules();
    const over = spent > cap;
    const capChanged = ui.lastCap !== cap || ui.lastOs !== state.os.join();
    ui.lastCap = cap;
    ui.lastOs = state.os.join();
    const lastCareerVal = ui.careerVal;
    positionBar();
    // the first tag gets wider or narrower with the career's value
    if (capChanged || ui.careerVal !== lastCareerVal) layoutBarLabels();

    const fill = document.getElementById("barFill");
    fill.style.width = Math.min(100, (spent / cap) * 100) + "%";
    fill.classList.toggle("over", over);

    const spentEl = document.getElementById("spentValue");
    spentEl.textContent = spent;
    spentEl.classList.toggle("over", over);
    const remainEl = document.getElementById("remainValue");
    remainEl.textContent = Math.max(0, cap - spent);
    remainEl.classList.toggle("over", over);

    const decks = DB.decks.decks;
    // a level tag lights up once the spending has reached its threshold
    decks.forEach((d, i) => {
      const reached = spent > 0 && ui.tagPos[i] <= spent;
      ui.markers[i].classList.toggle("reached", reached);
      ui.barLabels[i].classList.toggle("reached", reached);
    });
    document.getElementById("moduleBar").title = over
      ? `Over the ${cap}-module limit by ${spent - cap}`
      : "";
    renderPools();
  }

  /* --- health / psi pools --- */

  function poolStats() {
    const p = DB.costs.pools[state.difficulty];
    const maxStat = DB.disciplines.attributes.max;
    // equipped implants (EndurBoost, PsiBoost) raise the stat used for the pools
    const implant = key => state.implants.reduce((a, id) => a + ((DB.itemById[id].bonus || {})[key] || 0), 0);
    const bestImplant = key => Math.max(0, ...DB.implantList.map(it => (it.bonus || {})[key] || 0));
    const endImp = implant("attributes.end"), psiImp = implant("attributes.psi");
    const end = level("attributes", "end") + endImp;
    const psi = level("attributes", "psi") + psiImp;
    const tierBonus = DB.psi.tiers.reduce((a, t, i) => a + (tierOwned(i) ? t.maxPsiBonus : 0), 0);
    const allTiers = DB.psi.tiers.reduce((a, t) => a + t.maxPsiBonus, 0);
    const hpBonus = osEffect("maxHp");
    const hpBonusMax = DB.os.upgrades.reduce((a, u) => a + ((u.effect || {}).maxHp || 0), 0);
    const endTop = maxStat + bestImplant("attributes.end");
    const psiTop = maxStat + bestImplant("attributes.psi");
    return {
      p, end, psi, endImp, psiImp, endTop, psiTop, tierBonus, hpBonus,
      hp: p.hpBase + p.hpPerEnd * end + hpBonus,
      hpCap: p.hpBase + p.hpPerEnd * endTop + hpBonusMax,
      pp: p.psiBase + p.psiPerPsi * psi + tierBonus,
      ppCap: p.psiBase + p.psiPerPsi * psiTop + allTiers
    };
  }

  function renderPools() {
    const s = poolStats();
    const diff = diffName();
    document.getElementById("hpValue").textContent = s.hp;
    document.getElementById("psiValue").textContent = s.pp;
    // the fill is clipped rather than resized, so the bar art keeps its end cap
    document.getElementById("hpFill").style.setProperty("--fill", (s.hp / s.hpCap) * 100 + "%");
    document.getElementById("psiFill").style.setProperty("--fill", (s.pp / s.ppCap) * 100 + "%");
    ui.poolTips = {
      hp: [`Maximum hit points: ${s.hp}`,
        `${diff}: ${s.p.hpBase} + ${s.p.hpPerEnd} × END (${s.end}${s.endImp ? `, +${s.endImp} implant` : ""})${s.hpBonus ? ` + ${s.hpBonus} from Tank` : ""}\nUp to ${s.hpCap} with END ${s.endTop} (6 + EndurBoost) and Tank`],
      psi: [`Maximum psi points: ${s.pp}`,
        `${diff}: ${s.p.psiBase} + ${s.p.psiPerPsi} × PSI (${s.psi}${s.psiImp ? `, +${s.psiImp} implant` : ""}) + ${s.tierBonus} from Neural Capacity tiers\nUp to ${s.ppCap} with PSI ${s.psiTop} (6 + PsiBoost) and all five tiers`]
    };
    document.getElementById("hpPool").setAttribute("aria-label", ui.poolTips.hp[0]);
    document.getElementById("psiPool").setAttribute("aria-label", ui.poolTips.psi[0]);
  }

  function buildPools() {
    tip(document.getElementById("hpPool"), () => ui.poolTips.hp);
    tip(document.getElementById("psiPool"), () => ui.poolTips.psi);
  }

  const diffName = () => DB.costs.difficulties.find(d => d.id === state.difficulty).name;

  /* --- training panels (stats / weapons / tech) --- */

  function buildTrainingPanel(group) {
    const def = DB.disciplines[group];
    const host = document.getElementById("station-" + group);
    const head = el("div", { class: "station-title" }, `<h2>${esc(def.title)}</h2>`);
    const mfd = el("div", { class: "mfd", "data-panel": group });
    mfd.addEventListener("contextmenu", e => e.preventDefault());
    mfd.appendChild(el("div", { class: "mfd-head" }, "<span>Upgrade:</span><span>Cost:</span>"));

    ui.rows[group] = {};
    def.entries.forEach((e, i) => {
      const row = el("div", { class: "mfd-row" });
      row.style.top = ROW_TOP + i * ROW_STEP + "px";
      const btn = el("button", { type: "button", class: "up-btn", "data-key": `${group}.${e.id}` });
      const cost = el("div", { class: "cost-cell" }, "<span></span>");
      onPress(btn, () => buyLevel(group, e.id, btn), () => refundLevel(group, e.id));
      const showHelp = () => setHelp(group, helpRow(group, e));
      btn.addEventListener("mouseenter", showHelp);
      btn.addEventListener("focus", showHelp);
      row.append(btn, cost);
      mfd.appendChild(row);
      ui.rows[group][e.id] = { btn, cost, entry: e };
    });

    appendChannel(mfd, group);
    mfd.appendChild(el("div", { class: "mfd-modules" }));
    const help = el("div", { class: "mfd-help", "aria-live": "polite" });
    mfd.appendChild(help);
    ui.help[group] = help;
    mfd.addEventListener("mouseleave", () => setHelp(group, idleHelp(group)));
    setHelp(group, idleHelp(group));

    host.append(head, mfd);
  }

  // The right-hand channel of a unit: the game's close button (decoration only
  // here), the vertical label, and the RESET button.
  function appendChannel(mfd, panel, label = "TRAINING", resetText) {
    const close = el("div", { class: "mfd-close", "aria-hidden": "true" });
    const resetBtn = el("button", { type: "button", class: "mfd-undo", "aria-label": "Reset this upgrade unit" }, "R<br>E<br>S<br>E<br>T");
    resetBtn.addEventListener("click", () => resetPanel(panel));
    const showHelp = () => setHelp(panel, `<span class="h-title">Reset unit</span>${resetText || "Refunds every module spent at this upgrade unit. Career bonuses stay."}`);
    resetBtn.addEventListener("mouseenter", showHelp);
    resetBtn.addEventListener("focus", showHelp);
    mfd.append(close, el("div", { class: "mfd-channel" }, esc(label)), resetBtn);
    ui.reset[panel] = resetBtn;
  }

  function helpRow(group, e) {
    const def = DB.disciplines[group];
    const cur = level(group, e.id);
    const b = bonus(group, e.id);
    // the career bonus rides on the title line so it never adds a row to the help box
    const career = b ? ` <span class="h-career" title="Free levels from your career">(+${b} ${esc(branchOf(state.career).short)})</span>` : "";
    let line;
    if (cur >= def.max) line = `<span class="h-cost">Maximum trainable level (${def.max}) reached.</span>`;
    else {
      const c = levelCost(group, cur + 1);
      line = c > remaining()
        ? `<span class="h-warn">Level ${cur + 1} costs ${c} modules — only ${Math.max(0, remaining())} left.</span>`
        : `<span class="h-cost">Level ${cur + 1} costs ${c} modules.</span>`;
    }
    return `<span class="h-title">${esc(e.name)}: ${cur}${career}</span>${esc(e.desc)}${line}`;
  }

  function renderTrainingPanel(group) {
    const def = DB.disciplines[group];
    const rem = remaining();
    Object.values(ui.rows[group]).forEach(({ btn, cost, entry }) => {
      const cur = level(group, entry.id);
      const isMax = cur >= def.max;
      btn.classList.toggle("max", isMax);
      btn.classList.toggle("career", bonus(group, entry.id) > 0);
      btn.setAttribute("aria-label", isMax
        ? `${entry.name} ${cur}, maximum`
        : `${entry.name} ${cur}, buy level ${cur + 1} for ${levelCost(group, cur + 1)} modules`);
      btn.innerHTML = isMax
        ? `<span class="lbl">${esc(entry.label)}</span><span class="maxtxt">MAX</span>`
        : `<span class="lbl">${esc(entry.label)}</span><span class="cur">${cur}</span><span class="nxt">${cur + 1}</span>`;
      const span = cost.firstChild;
      if (isMax) { span.textContent = ""; cost.classList.remove("cant"); }
      else {
        const c = levelCost(group, cur + 1);
        span.textContent = c;
        cost.classList.toggle("cant", c > rem);
      }
    });
    const mfd = ui.help[group].parentElement;
    mfd.querySelector(".mfd-modules").textContent = `Modules Spent: ${groupSpent(group)}`;
    ui.reset[group].disabled = !panelHasPurchases(group);
  }

  /* --- psi panel --- */

  function buildPsiPanel() {
    const host = document.getElementById("station-psi");
    const head = el("div", { class: "station-title" }, `<h2>Psionics</h2>`);
    const mfd = el("div", { class: "mfd psi", "data-panel": "psi" });
    mfd.addEventListener("contextmenu", e => e.preventDefault());

    const tabs = el("div", { class: "psi-tabs", role: "tablist", "aria-label": "Psi tiers" });
    ui.psiTabs = [];
    for (let t = 0; t < 5; t++) {
      const b = el("button", { type: "button", role: "tab", "aria-label": `Tier ${t + 1}` }, `<span class="own"></span>`);
      b.addEventListener("click", () => { psiTab = t; renderPsiPanel(); });
      b.addEventListener("mouseenter", () => setHelp("psi", `<span class="h-title">Tier ${t + 1}</span>${tierOwned(t) ? "Neural Capacity owned." : "Not yet unlocked. Buy its Neural Capacity first."}`));
      tabs.appendChild(b);
      ui.psiTabs.push(b);
    }
    mfd.appendChild(tabs);

    ui.psiIcons = [];
    for (let i = 0; i < 8; i++) {
      const b = el("button", { type: "button", class: "psi-icon" }, `<span class="pcost"></span>`);
      b.style.left = PSI_COLS[i % 2] + "px";
      b.style.top = PSI_ROW_TOP + Math.floor(i / 2) * PSI_ROW_STEP + "px";
      onPress(b, () => buyPsi(currentPsi(i), b), () => refundPsi(currentPsi(i)));
      const show = () => setHelp("psi", helpPsi(currentPsi(i)));
      b.addEventListener("mouseenter", show);
      b.addEventListener("focus", show);
      mfd.appendChild(b);
      ui.psiIcons.push(b);
    }

    appendChannel(mfd, "psi");
    mfd.appendChild(el("div", { class: "mfd-modules" }));
    const help = el("div", { class: "mfd-help", "aria-live": "polite" });
    mfd.appendChild(help);
    ui.help.psi = help;
    mfd.addEventListener("mouseleave", () => setHelp("psi", idleHelp("psi")));
    setHelp("psi", idleHelp("psi"));
    host.append(head, mfd);
  }

  function currentPsi(slot) {
    const t = DB.psi.tiers[psiTab];
    return DB.psiById[slot === 0 ? t.capacity.id : t.powers[slot - 1].id];
  }

  function helpPsi(p, warn) {
    const c = psiCost(p);
    let line;
    if (psiGranted(p.id)) line = `<span class="h-cost">Granted by your ${esc(branchOf(state.career).short)} career (free).</span>`;
    else if (psiOwned(p)) line = `<span class="h-cost">Purchased (${c} modules). ${say().alt} to refund${p.isCap ? " the tier and its disciplines" : ""}.</span>`;
    else if (!p.isCap && !tierOwned(p.tier)) line = `<span class="h-warn">Requires Tier ${p.tier + 1} Neural Capacity.</span>`;
    else if (c > remaining()) line = `<span class="h-warn">Costs ${c} modules — only ${Math.max(0, remaining())} left.</span>`;
    else line = `<span class="h-cost">Costs ${c} modules.</span>`;
    if (warn) line = `<span class="h-warn">${esc(warn)}</span>`;
    const detail = p.detail ? `<span class="h-detail">${esc(p.detail)}</span>` : "";
    return `<span class="h-title">${esc(p.name)}</span>${esc(p.desc)}${detail}${line}`;
  }

  function renderPsiPanel() {
    const rem = remaining();
    const mfd = ui.help.psi.parentElement;
    mfd.querySelector(".psi-tabs").style.backgroundImage = `url("assets/ui/psi${psiTab + 1}.png")`;
    ui.psiTabs.forEach((b, t) => {
      b.setAttribute("aria-selected", String(t === psiTab));
      b.classList.toggle("owned", tierOwned(t));
    });
    ui.psiIcons.forEach((b, i) => {
      const p = currentPsi(i);
      const owned = psiOwned(p);
      const available = p.isCap || tierOwned(p.tier);
      const c = psiCost(p);
      const variant = owned ? "_2" : available ? "_1" : "_0";
      b.style.backgroundImage = `url("assets/ui/psi/${p.icon}${variant}.png")`;
      b.dataset.key = `psi.${p.id}`;
      b.classList.toggle("career", psiGranted(p.id));
      const costEl = b.firstChild;
      costEl.textContent = owned ? "" : c;
      costEl.classList.toggle("cant", !owned && c > rem);
      b.setAttribute("aria-label", `${p.name}${psiGranted(p.id) ? ", granted by career" : owned ? ", purchased" : `, ${c} modules`}`);
    });
    mfd.querySelector(".mfd-modules").textContent = `Modules Spent: ${psiSpent()}`;
    ui.reset.psi.disabled = !panelHasPurchases("psi");
  }

  /* --- O/S upgrade panel --- */

  function buildOsPanel() {
    const host = document.getElementById("station-os");
    const head = el("div", { class: "station-title" }, `<h2>O/S Upgrades</h2>`);
    const mfd = el("div", { class: "mfd os", "data-panel": "os" });
    mfd.addEventListener("contextmenu", e => e.preventDefault());
    mfd.appendChild(el("div", { class: "os-head" }, `Choose up to ${DB.os.points} upgrades`));

    const status = el("div", { class: "os-status" }, `<div class="os-points"></div><div class="os-stations"></div>`);
    const stationsEl = status.querySelector(".os-stations");
    ui.osChips = DB.os.stations.map((st, k) => {
      const chip = el("span", { class: "os-chip" }, `<i></i>${esc(st.short)}`);
      tip(chip, () => [`${st.name} O/S unit`, state.os[k] ? DB.osById[state.os[k]].name : "Not used"]);
      stationsEl.appendChild(chip);
      return chip;
    });
    mfd.appendChild(status);

    ui.osIcons = DB.os.upgrades.map((u, i) => {
      const b = el("button", { type: "button", class: "os-icon", "data-os": u.id }, `<span class="os-order"></span>`);
      b.style.left = OS_COLS[i % 4] + "px";
      b.style.top = OS_ROWS[Math.floor(i / 4)] + "px";
      b.style.backgroundImage = `url("assets/ui/os/${u.icon}.png")`;
      onPress(b, () => installOs(u, b), () => removeOs(u));
      const show = () => setHelp("os", helpOs(u));
      b.addEventListener("mouseenter", show);
      b.addEventListener("focus", show);
      mfd.appendChild(b);
      return b;
    });

    appendChannel(mfd, "os", "O/S UNITS", "Removes every installed O/S upgrade.");
    const help = el("div", { class: "mfd-help", "aria-live": "polite" });
    mfd.appendChild(help);
    ui.help.os = help;
    mfd.addEventListener("mouseleave", () => setHelp("os", idleHelp("os")));
    setHelp("os", idleHelp("os"));
    host.append(head, mfd);
  }

  function installOs(u, btn) {
    if (state.os.includes(u.id)) return;
    if (state.os.length >= DB.os.points) {
      setHelp("os", helpOs(u, `All ${DB.os.points} O/S stations are used. ${say().alt} an installed upgrade to remove it first.`));
      flash(btn);
      return;
    }
    state.os.push(u.id);
    commit();
    setHelp("os", helpOs(u));
  }

  function removeOs(u) {
    if (!state.os.includes(u.id)) return;
    const freed = capModules() - ((u.effect || {}).maxModules || 0);
    if (totalSpent() > freed) {
      setHelp("os", helpOs(u, `Your build spends ${totalSpent()} modules; without this upgrade the cap would be ${freed}. Refund some upgrades first.`));
      return;
    }
    state.os = state.os.filter(id => id !== u.id);
    commit();
    setHelp("os", helpOs(u));
  }

  function helpOs(u, warn) {
    const st = osStation(u.id);
    let line;
    if (warn) line = `<span class="h-warn">${esc(warn)}</span>`;
    else if (st) line = `<span class="h-cost">Installed at the ${esc(st.name)} O/S unit. ${say().alt} to remove.</span>`;
    else if (state.os.length >= DB.os.points) line = `<span class="h-warn">All ${DB.os.points} O/S stations are used.</span>`;
    else {
      const next = DB.os.stations[state.os.length];
      line = `<span class="h-cost">${say().click} to install at the ${esc(next.name)} O/S unit (${esc(next.where)}).</span>`;
    }
    return `<span class="h-title">${esc(u.name)}</span>${esc(u.desc)}${line}`;
  }

  function renderOsPanel() {
    const full = state.os.length >= DB.os.points;
    ui.osIcons.forEach((b, i) => {
      const u = DB.os.upgrades[i];
      const k = state.os.indexOf(u.id);
      b.classList.toggle("owned", k >= 0);
      b.classList.toggle("unavailable", k < 0 && full);
      b.firstChild.textContent = k >= 0 ? k + 1 : "";
      b.setAttribute("aria-label", `${u.name}${k >= 0 ? `, installed at ${DB.os.stations[k].name}` : ""}`);
    });
    ui.osChips.forEach((c, k) => c.classList.toggle("used", !!state.os[k]));
    ui.help.os.parentElement.querySelector(".os-points").innerHTML =
      `O/S points: <b>${state.os.length}</b> / ${DB.os.points}`;
    ui.reset.os.disabled = !panelHasPurchases("os");
  }

  /* --- inventory --- */

  function reqLabel(key) {
    const [g, id] = key.split(".");
    const e = DB.disciplines[g] && DB.disciplines[g].entries.find(x => x.id === id);
    return e ? e.name : key;
  }
  // The level that counts for an item requirement: trained level plus equipped implant bonuses.
  // (Upgrade costs always use the trained level alone.)
  const reqValue = key => { const [g, id] = key.split("."); return level(g, id) + implantReqBonus(key); };

  function itemReqs(item) {
    const list = item.req.map(r => ({ key: r.key, level: r.level, tag: "" }));
    if (item.research) list.push({ key: "tech.research", level: item.research, tag: "to research first" });
    return list;
  }
  const itemUsable = item => itemReqs(item).every(r => reqValue(r.key) >= r.level);
  const ownedPowerCount = () => DB.psiFlat.filter(p => !p.isCap && psiOwned(p)).length;

  function buildInventory() {
    const inv = document.getElementById("inventory");
    // implants live in their own panel next to the O/S Upgrades unit
    const implantsBox = document.getElementById("implantsBox");
    ui.items = [];
    DB.items.categories.forEach(cat => {
      const isImplants = cat.id === "implants";
      const group = el("div", { class: "inv-group", "data-cat": cat.id });
      group.appendChild(el("h3", {}, isImplants ? "Available" : esc(cat.title)));
      const grid = el("div", { class: "inv-grid" });
      const rows = cat.rows || Math.max(...cat.items.map(i => i.h));
      grid.style.gridTemplateRows = `repeat(${rows}, 68px)`;
      cat.items.forEach(item => {
        const cell = el("div", { class: "inv-item", tabindex: "0", "aria-label": item.name });
        cell.style.gridColumn = `span ${item.w}`;
        cell.style.gridRow = `span ${item.h}`;
        cell.appendChild(el("img", { src: `assets/items/${item.icon}.png`, alt: "", loading: "lazy" }));
        cell.addEventListener("mouseenter", ev => showTooltip(item, ev));
        cell.addEventListener("mousemove", moveTooltip);
        cell.addEventListener("mouseleave", hideTooltip);
        cell.addEventListener("focus", () => showTooltip(item, null, cell));
        cell.addEventListener("blur", hideTooltip);
        if (item.implant) {
          cell.classList.add("equippable");
          cell.setAttribute("role", "button");
          cell.addEventListener("click", () => toggleImplant(item, cell));
          // right-click only ever removes an equipped implant
          cell.addEventListener("contextmenu", ev => {
            ev.preventDefault();
            if (state.implants.includes(item.id)) toggleImplant(item, cell);
          });
          cell.addEventListener("keydown", ev => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleImplant(item, cell); }
          });
          cell.appendChild(el("span", { class: "equip-tag" }, "EQUIPPED"));
        }
        // a tap shows the tooltip where the browser doesn't simulate hover
        cell.addEventListener("click", ev => { if (ui.tipItem !== item) showTooltip(item, ev); });
        grid.appendChild(cell);
        ui.items.push({ item, cell });
      });
      // empty filler cells keep the grid lines continuous when a column isn't full
      const used = cat.items.reduce((a, i) => a + i.w * i.h, 0);
      const cols = Math.ceil(used / rows);
      for (let k = used; k < cols * rows; k++) grid.appendChild(el("div", { class: "cell" }));
      group.appendChild(grid);
      (isImplants ? implantsBox : inv).appendChild(group);
    });
    buildImplantSlots(implantsBox);
  }

  // The EQUIP box: one implant slot, a second one unlocked by Cybernetically Enhanced.
  function buildImplantSlots(host) {
    const group = el("div", { class: "inv-group equip-group" });
    group.appendChild(el("h3", {}, "Equipped"));
    const grid = el("div", { class: "inv-grid equip-grid" });
    grid.style.gridTemplateRows = "repeat(2, 68px)"; // second slot sits below the first
    ui.implantSlots = [0, 1].map(k => {
      const slot = el("div", { class: "inv-item equip-slot", tabindex: "0" });
      const remove = () => {
        const id = state.implants[k];
        if (id) toggleImplant(DB.itemById[id], slot);
      };
      slot.addEventListener("click", remove);
      slot.addEventListener("contextmenu", ev => { ev.preventDefault(); remove(); });
      slot.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); remove(); } });
      slot.addEventListener("mouseenter", ev => {
        const id = state.implants[k];
        if (id) showTooltip(DB.itemById[id], ev);
        else if (k >= implantSlots()) showTextTooltip("Second implant slot", "Install the Cybernetically Enhanced O/S upgrade to use two implants at once.", ev);
        else showTextTooltip("Empty implant slot", `${say().click} an implant in the inventory to equip it.`, ev);
      });
      slot.setAttribute("data-tip", "");
      slot.addEventListener("mousemove", moveTooltip);
      slot.addEventListener("mouseleave", hideTooltip);
      grid.appendChild(slot);
      return slot;
    });
    group.appendChild(grid);
    group.appendChild(el("p", { class: "equip-note" }));
    host.appendChild(group);

    // what the equipped implants do, filling the rest of the panel
    const fx = el("div", { class: "inv-group implant-fx" });
    fx.appendChild(el("h3", {}, "Active effects"));
    ui.implantFx = el("div", { class: "fx-panel", "aria-live": "polite" });
    fx.appendChild(ui.implantFx);
    host.appendChild(fx);
  }

  function renderImplantFx() {
    const rows = state.implants.map(id => {
      const it = DB.itemById[id];
      return `<div class="fx"><div class="fx-name">${esc(it.name)}${it.stats ? `<span>${esc(it.stats)}</span>` : ""}</div><div class="fx-desc">${esc(it.desc)}</div></div>`;
    });
    const hint = implantSlots() < 2
      ? `<p class="fx-hint">The Cybernetically Enhanced O/S upgrade adds a second implant slot.</p>` : "";
    ui.implantFx.innerHTML = rows.length
      ? rows.join("") + hint
      : `<p class="fx-none">No implant equipped. ${say().click} an implant above to equip it.</p>${hint}`;
  }

  function renderImplantSlots() {
    const slots = implantSlots();
    ui.implantSlots.forEach((slot, k) => {
      const id = state.implants[k];
      const locked = k >= slots;
      slot.classList.toggle("slot-locked", locked);
      slot.classList.toggle("filled", !!id);
      slot.innerHTML = id
        ? `<img src="assets/items/${DB.itemById[id].icon}.png" alt="">`
        : `<span class="slot-text">Implant</span>`;
      slot.setAttribute("aria-label", id
        ? `${DB.itemById[id].name} equipped, press to remove`
        : locked ? "Second implant slot, needs the Cybernetically Enhanced O/S upgrade" : "Empty implant slot");
    });
    slot2Note();
    renderImplantFx();
  }

  function slot2Note() {
    const note = document.querySelector(".equip-note");
    if (note) note.textContent = `${state.implants.length} / ${implantSlots()} implant${implantSlots() > 1 ? "s" : ""}`;
  }

  function renderInventory() {
    ui.items.forEach(({ item, cell }) => {
      const ok = itemUsable(item);
      cell.classList.toggle("locked", !ok);
      const equipped = !!item.implant && state.implants.includes(item.id);
      cell.classList.toggle("equipped", equipped);
      cell.setAttribute("aria-label", `${item.name}${ok ? "" : " (requirements not met)"}${equipped ? ", equipped" : ""}`);
    });
    renderImplantSlots();
    if (ui.tipItem) {
      fillTooltip(ui.tipItem);
      // its height changes with the text, so keep it clear of the tapped item
      if (touchUi() && ui.tipAnchor) placeBeside(ui.tipAnchor);
    }
  }

  /* --- tooltip --- */

  function fillTooltip(item) {
    const reqs = itemReqs(item);
    const reqHtml = reqs.length
      ? reqs.map(r => {
          const have = reqValue(r.key);
          const ok = have >= r.level;
          const imp = implantReqBonus(r.key);
          const haveTxt = imp ? `${have} <span class="imp">(+${imp} implant)</span>` : have;
          return `<div class="tt-req ${ok ? "ok" : "no"}"><span>${ok ? "✓" : "✗"} ${esc(reqLabel(r.key))} ${r.level}${r.tag ? ` <span class="tag">(${esc(r.tag)})</span>` : ""}</span><span class="have">${haveTxt}</span></div>`;
        }).join("")
      : `<div class="tt-none">No requirements</div>`;
    let extra = "";
    if (item.needsPsi) {
      const n = ownedPowerCount();
      extra = `<div class="tt-req ${n ? "ok" : "no"}"><span>${n ? "✓" : "•"} At least one psi discipline</span><span class="have">${n}</span></div>`;
    }
    const tech = item.tech
      ? `<div class="tt-sec"><h4>Upkeep skills</h4><div class="tt-tech">Maintain ${item.tech.maintain} · Modify ${esc(item.tech.modify)} · Repair ${item.tech.repair}</div></div>`
      : "";
    let equip = "";
    if (item.implant) {
      const on = state.implants.includes(item.id);
      const slots = implantSlots();
      let line;
      if (on) line = `<span class="ok">Equipped. ${say().click} to remove.</span>`;
      else if (!itemUsable(item)) line = `<span class="no">Research it before it can be equipped.</span>`;
      else if (state.implants.length >= slots) line = `<span class="no">No free implant slot. Remove an equipped implant first.</span>`;
      else line = `${say().click} to equip.`;
      const note = item.bonus
        ? (item.bonusIgnoredForReq
            ? "Its bonus does not count toward item requirements."
            : "Its bonus counts toward other items' requirements while equipped.")
        : "";
      equip = `<div class="tt-sec tt-equip">${line}${note ? `<small>${note}</small>` : ""}</div>`;
    }
    ui.tooltip.innerHTML =
      `<div class="tt-head">${esc(item.name)}</div>` +
      `<div class="tt-type">${esc(item.type)}</div>` +
      `<div class="tt-desc">${esc(item.desc)}</div>` +
      (item.stats ? `<div class="tt-stats">${esc(item.stats)}</div>` : "") +
      `<div class="tt-sec"><h4>Requirements</h4>${reqHtml}${extra}</div>` +
      tech + equip;
  }

  function showTooltip(item, ev, anchor) {
    ui.tipItem = item;
    fillTooltip(item);
    ui.tooltip.hidden = false;
    highlightReqs(item, true);
    if (ev) moveTooltip(ev);
    else if (anchor) {
      ui.tipAnchor = anchor;
      if (touchUi()) placeBeside(anchor);
      else {
        const r = anchor.getBoundingClientRect();
        placeTooltip(r.right + 8, r.top);
      }
    }
  }

  // With a mouse the tooltip follows the pointer. On touch screens it sits
  // above or below the tapped element instead, so a finger-sized tooltip never
  // covers the thing it describes.
  function moveTooltip(ev) {
    if (ev.currentTarget instanceof Element) ui.tipAnchor = ev.currentTarget;
    if (touchUi() && ui.tipAnchor) placeBeside(ui.tipAnchor);
    else placeTooltip(ev.clientX + 18, ev.clientY + 14);
  }

  function placeBeside(node) {
    const tip = ui.tooltip, GAP = 8, EDGE = 8;
    const r = node.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const roomBelow = window.innerHeight - EDGE - (r.bottom + GAP);
    const roomAbove = r.top - GAP - EDGE;
    // below if it fits, else above if it fits, else whichever side has more room
    const below = h <= roomBelow || (h > roomAbove && roomBelow >= roomAbove);
    const y = below ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - h);
    const x = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), Math.max(EDGE, window.innerWidth - w - EDGE));
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function placeTooltip(x, y) {
    const tip = ui.tooltip;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = Math.max(8, x - w - 36);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  // A plain title + text tooltip, in the same style as the item tooltips.
  function showTextTooltip(title, text, ev) {
    hideTooltip();
    ui.tooltip.innerHTML = `<div class="tt-head">${esc(title)}</div><div class="tt-desc">${esc(text)}</div>`;
    ui.tooltip.hidden = false;
    moveTooltip(ev);
  }

  function hideTooltip() {
    if (ui.tipItem) highlightReqs(ui.tipItem, false);
    ui.tipItem = null;
    ui.tipAnchor = null;
    ui.tooltip.hidden = true;
  }

  function highlightReqs(item, on) {
    itemReqs(item).forEach(r => {
      const b = document.querySelector(`.up-btn[data-key="${r.key}"]`);
      if (b) b.classList.toggle("req-hl", on);
    });
  }

  /* ------------------------------------------------------- career modal */

  const career = { open: false, step: 0, branch: null, picks: [], dismissable: false, lastFocus: null };

  function openCareer(dismissable) {
    hideTooltip();
    career.open = true;
    career.dismissable = dismissable && !!state.career;
    if (state.career && dismissable) {
      career.branch = state.career.branch;
      career.picks = state.career.picks.slice();
      career.step = 4;
    } else {
      career.branch = null;
      career.picks = [];
      career.step = 0;
    }
    career.lastFocus = document.activeElement;
    const modal = document.getElementById("careerModal");
    modal.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("careerClose").hidden = !career.dismissable;
    renderCareer(true);
  }

  function closeCareer() {
    career.open = false;
    document.getElementById("careerModal").hidden = true;
    document.body.classList.remove("modal-open");
    if (career.lastFocus && career.lastFocus.focus) career.lastFocus.focus();
  }

  const STEP_NAMES = ["Branch", "Year 1", "Year 2", "Year 3", "Confirm"];

  // Rebuilding a step removes the button that had keyboard focus, so put focus
  // back inside the dialog: on the current pick, else the first choice.
  function focusCareer() {
    const modal = document.getElementById("careerModal");
    const picked = modal.querySelector(".career-card.selected");
    const target = picked || modal.querySelector(".career-card, #careerConfirm:not([hidden])");
    modal.scrollTop = 0;
    if (target) target.focus({ preventScroll: !picked });
  }

  function renderCareer(stepChanged) {
    const steps = document.getElementById("careerSteps");
    const reachable = s => s === 0 || (career.branch && career.picks.length >= s - 1);
    steps.innerHTML = "";
    STEP_NAMES.forEach((n, s) => {
      const li = el("li", { class: s === career.step ? "current" : s < career.step ? "done" : "" });
      const b = el("button", { type: "button" }, esc(n));
      b.disabled = !reachable(s) || s === career.step;
      b.addEventListener("click", () => { career.step = s; renderCareer(true); });
      li.appendChild(b);
      steps.appendChild(li);
    });

    const intro = document.getElementById("careerIntro");
    const cards = document.getElementById("careerCards");
    const confirm = document.getElementById("careerConfirm");
    const back = document.getElementById("careerBack");
    cards.innerHTML = "";
    cards.className = "career-cards";
    confirm.hidden = career.step !== 4;
    back.disabled = career.step === 0;
    const branch = DB.careers.branches.find(b => b.id === career.branch);
    const diffName = DB.costs.difficulties.find(d => d.id === state.difficulty).name;
    const valueTag = n => `<span class="c-value" title="What these bonuses would cost in Cyber Modules on ${esc(diffName)}">Worth <b>${n}</b> modules</span>`;

    if (career.step === 0) {
      intro.innerHTML = `<p>Four years before the Von Braun. Choose the branch of service you enlist in; it decides the bonuses your character starts with.</p>`;
      DB.careers.branches.forEach(b => {
        const card = el("button", { type: "button", class: "career-card branch" + (b.id === career.branch ? " selected" : "") },
          `<span class="emblem-coin" style="background-image:url('assets/career/${b.emblem}.png')" aria-hidden="true"></span>
           <span class="c-name">${esc(b.name)}</span>
           <span class="c-role">${esc(b.blurb)}</span>
           <span class="c-gain">${esc(b.basic.name)}: ${grantLabels(b.basic).map(esc).join(", ")}</span>
           ${valueTag(stepValue(b.basic))}`);
        card.addEventListener("click", () => {
          if (career.branch !== b.id) career.picks = [];
          career.branch = b.id;
          career.step = 1;
          renderCareer(true);
        });
        cards.appendChild(card);
      });
    } else if (career.step <= 3) {
      const y = career.step - 1;
      intro.innerHTML = `<p><b>${esc(branch.name)}</b> · Year ${career.step} of your tour of duty. Pick your posting.</p>`;
      // each posting is priced on top of the levels the earlier steps gave
      const got = {};
      [branch.basic, ...branch.years.slice(0, y).map((opts, j) => opts[career.picks[j]])].forEach(st => stepValue(st, got));
      branch.years[y].forEach((opt, k) => {
        const card = el("button", { type: "button", class: "career-card" + (career.picks[y] === k ? " selected" : "") },
          `<img src="assets/career/${opt.pic}.png" alt="" class="pic">
           <span class="c-name">${esc(opt.name)}</span>
           <span class="c-role">${esc(opt.role)}</span>
           <span class="c-gain">${grantLabels(opt).map(esc).join("<br>")}</span>
           ${valueTag(stepValue(opt, { ...got }))}`);
        card.addEventListener("click", () => {
          career.picks[y] = k;
          career.picks.length = Math.max(career.picks.length, y + 1);
          career.step = y + 2;
          renderCareer(true);
        });
        cards.appendChild(card);
      });
    } else {
      const path = { branch: career.branch, picks: career.picks };
      const g = careerGrants(path);
      const v = careerValue(path);
      intro.innerHTML = `<p><b>${esc(branch.name)}</b> · Service record complete. These bonuses are free and don't cost Cyber Modules.${career.dismissable ? " Upgrades you've already bought are kept." : ""}</p>`;
      cards.classList.add("record");
      g.steps.forEach((st, i) => {
        cards.appendChild(el("div", { class: "record-row" },
          `<span class="r-year">${i === 0 ? "Basic" : `Year ${i}`}</span>
           <span class="r-name">${esc(st.name)}<small>${esc(st.role)}</small></span>
           <span class="r-gain">${grantLabels(st).map(esc).join(", ") || "—"}</span>
           <span class="r-value"><b>${v.steps[i]}</b> modules</span>`));
      });
      cards.appendChild(el("div", { class: "record-row total" },
        `<span class="r-year">Total</span>
         <span class="r-name">Cyber Modules Value<small>Priced on ${esc(diffName)}</small></span>
         <span class="r-gain"></span>
         <span class="r-value"><b>${v.total}</b> modules</span>`));
    }

    // running totals
    const partial = career.branch
      ? careerGrants({ branch: career.branch, picks: career.picks.concat([]).slice(0, 3) }) : null;
    const sum = document.getElementById("careerSummary");
    if (!partial) sum.innerHTML = `<span class="s-label">Starting bonuses</span><span class="s-none">None yet</span>`;
    else {
      const parts = Object.entries(partial.lv).map(([k, v]) => `+${v} ${esc(reqLabel(k))}`);
      partial.psi.forEach(id => parts.push(esc(DB.psiById[id].name)));
      sum.innerHTML = `<span class="s-label">Starting bonuses</span>${parts.map(p => `<span class="s-chip">${p}</span>`).join("")}`;
    }
    if (stepChanged) focusCareer();
  }

  function buildCareerModal() {
    document.getElementById("careerBack").addEventListener("click", () => {
      if (career.step > 0) { career.step -= 1; renderCareer(true); }
    });
    document.getElementById("careerClose").addEventListener("click", closeCareer);
    document.getElementById("careerConfirm").addEventListener("click", () => {
      state.career = { branch: career.branch, picks: career.picks.slice(0, 3) };
      grantCache.key = null;
      normalize(state);
      commit();
      closeCareer();
    });
    const modal = document.getElementById("careerModal");
    modal.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && career.dismissable) { closeCareer(); return; }
      if (ev.key !== "Tab") return;
      const f = [...modal.querySelectorAll("button:not([disabled]):not([hidden])")].filter(b => b.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
  }

  /* --- everything --- */

  function renderAll() {
    grantCache.key = null;
    document.getElementById("shareNote").hidden = !shared;
    renderControls();
    renderModuleBar();
    GROUPS.forEach(renderTrainingPanel);
    renderPsiPanel();
    renderOsPanel();
    renderInventory();
  }

  function showLoadError(err) {
    const box = document.getElementById("loadError");
    const fileProto = location.protocol === "file:";
    box.innerHTML = `<div class="box"><h2>Data link failure</h2>
      <p>The planner could not load its JSON database (${esc(err.message || err)}).</p>
      ${fileProto ? `<p>Browsers block <code>fetch()</code> on pages opened straight from disk. Serve the folder over HTTP instead, for example by running <code>serve.ps1</code> in PowerShell or using the VS Code “Live Server” extension, then open <code>http://localhost:8080/</code>.</p>` : ""}
    </div>`;
    box.hidden = false;
  }

  // Fetches the art that only appears on hover or after a purchase (button
  // hover states, the other psi tier tabs, every psi icon variant) once the
  // page is idle, so the first hover or purchase doesn't flash empty.
  function preloadArt() {
    const urls = ["tbut11", "tbutmax", "undo1", "psi2", "psi3", "psi4", "psi5"].map(n => `assets/ui/${n}.png`);
    DB.psiFlat.forEach(p => [0, 1, 2].forEach(v => urls.push(`assets/ui/psi/${p.icon}_${v}.png`)));
    const run = () => { ui.preloaded = urls.map(u => { const img = new Image(); img.src = u; return img; }); };
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 800);
  }

  async function init() {
    try {
      DB = await loadData();
    } catch (err) {
      document.body.classList.remove("booting");
      showLoadError(err);
      return;
    }
    ui.tooltip = document.getElementById("tooltip");
    state = restore();
    buildControls();
    buildShareNote();
    buildPools();
    buildModuleBar();
    GROUPS.forEach(buildTrainingPanel);
    buildPsiPanel();
    buildOsPanel();
    buildInventory();
    buildCareerModal();
    document.body.classList.remove("booting");
    layoutBarLabels();   // the bar had no width while the page was hidden
    renderAll();
    save();
    preloadArt();
    window.addEventListener("scroll", hideTooltip, { passive: true });
    window.addEventListener("hashchange", onHashChange);
    // on touch screens nothing "leaves" an element, so a tap elsewhere closes the tooltip
    document.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "mouse" && !ev.target.closest(".inv-item, [data-tip]")) hideTooltip();
    });
    if (!state.career) openCareer(false);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
