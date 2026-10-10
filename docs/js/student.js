// Страница студента: вход/регистрация, навигация по открытым юнитам,
// упражнения с автосохранением черновика, сдача работы, просмотр результатов.
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, orderBy,
  serverTimestamp,
} from "./fb.js";
import { COURSE_TITLE } from "./firebase-config.js";
import {
  esc, renderBlocks, readInput, fmtTime, friendlyError, authFormHTML, wireAuthForm, subId, exercisesOf, isAuto,
  isTeacherChecked, wireFlashcards, countWords,
} from "./common.js";
import { initShell, renderUnitNav, wireUnitNav } from "./shell.js";
import { feedbackHTML } from "./writing.js";

const $ = (s) => document.querySelector(s);
const S = {
  user: null, profile: null, group: null, units: [],
  content: {},   // unitId -> content | null (нет доступа)
  sub: {},       // unitId -> {answers, status, updatedAt, dirty}
  result: {},    // unitId -> result | null
  exr: {},       // unitId -> results of exercises the teacher has checked one by one
  exrVer: 0,
  // timed tests: testKey -> attempt | null, content | null, result | null, local answers
  att: {}, attUnsub: {}, tcontent: {}, tres: {}, tresUnsub: {}, tdraft: {},
  unsub: [], unitUnsub: {}, resultUnsub: {},
  registering: false,
};
const SAVE_DELAY = 1000;
let saveTimer = null;

document.title = COURSE_TITLE;
document.querySelectorAll("[data-course-title]").forEach((el) => (el.textContent = COURSE_TITLE));
initShell();
wireFlashcards();
protectBook();
wireUnitNav(document.querySelector("#unit-nav"), () => renderNav());

// ------------------------------------------------------------------ auth
$("#auth-screen").innerHTML = authFormHTML({ eyebrow: "Course Workbook", title: COURSE_TITLE, allowRegister: true });
wireAuthForm($("#auth-screen"), {
  async login(f) { await signInWithEmailAndPassword(auth, f.email.trim(), f.password); },
  async reset(f) {
    await sendPasswordResetEmail(auth, f.email.trim());
    return "We have sent you a link to reset your password. Please check your Spam folder too.";
  },
  async register(f) {
    const name = (f.name || "").trim(), group = (f.group || "").trim().toUpperCase();
    if (!name) throw new Error("Please enter your name.");
    if (!group) throw new Error("Please enter your group code.");
    S.registering = true;
    const cred = await createUserWithEmailAndPassword(auth, f.email.trim(), f.password);
    try {
      // правила Firestore проверят, что группа с таким кодом существует
      await setDoc(doc(db, "users", cred.user.uid), {
        name, email: cred.user.email, groupId: group, createdAt: serverTimestamp(),
      });
    } catch (e) {
      await cred.user.delete().catch(() => {});
      throw new Error("There is no group with this code. Please check the code with your teacher.");
    } finally {
      S.registering = false;
    }
  },
});
$("#logout").addEventListener("click", async () => { await flushSave(); signOut(auth); });

onAuthStateChanged(auth, (user) => {
  stopAll();
  S.user = user;
  $("#boot").hidden = true;
  $("#auth-screen").hidden = !!user;
  $("#app").hidden = !user;
  if (!user) return;
  $("#me-email").textContent = user.email;

  S.unsub.push(onSnapshot(doc(db, "users", user.uid), async (snap) => {
    if (!snap.exists()) {
      if (S.registering) return;
      const isTeacher = (await getDoc(doc(db, "teachers", user.uid)).catch(() => null))?.exists();
      $("#content").innerHTML = isTeacher
        ? `<div class="locked-msg"><span class="big">👩‍🏫</span>You are signed in with a teacher account. <a href="teacher.html">Open the Teacher's Edition</a></div>`
        : `<div class="locked-msg">We could not find your student profile. Please contact your teacher.</div>`;
      return;
    }
    const prevGroup = S.profile?.groupId;
    S.profile = snap.data();
    $("#me-name").textContent = S.profile.name;
    if (S.profile.groupId !== prevGroup) subscribeGroup(S.profile.groupId);
  }));

  S.unsub.push(onSnapshot(query(collection(db, "units"), orderBy("order")), (snap) => {
    S.units = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderNav(); renderMain();
  }));
});

function stopAll() {
  S.unsub.forEach((u) => u()); S.unsub = [];
  Object.values(S.unitUnsub).forEach((u) => u()); S.unitUnsub = {};
  Object.values(S.resultUnsub).forEach((u) => u()); S.resultUnsub = {};
  Object.values(S.attUnsub).forEach((u) => u()); S.attUnsub = {};
  Object.values(S.tresUnsub).forEach((u) => u()); S.tresUnsub = {};
  Object.assign(S, { profile: null, group: null, units: [], content: {}, sub: {}, result: {}, exr: {}, att: {}, tcontent: {}, tres: {}, tdraft: {} });
}

let groupUnsub = null;
function subscribeGroup(gid) {
  groupUnsub?.();
  groupUnsub = onSnapshot(doc(db, "groups", gid), (snap) => {
    S.group = snap.exists() ? snap.data() : { openUnits: [], releasedUnits: [] };
    $("#me-group").textContent = "Group: " + (S.group.name || gid);
    syncUnitSubscriptions();
    renderNav(); renderMain();
  }, () => { S.group = { openUnits: [], releasedUnits: [] }; renderNav(); renderMain(); });
  S.unsub.push(() => groupUnsub?.());
}

const isOpen = (id) => !!S.group?.openUnits?.includes(id);
const isReleased = (id) => !!S.group?.releasedUnits?.includes(id);

// Реакция в реальном времени на открытие/закрытие юнита и включение проверки
function syncUnitSubscriptions() {
  for (const key of Object.keys(S.unitUnsub)) {
    const id = key.replace(/^(sub|exr):/, "");
    if (!isOpen(id)) { S.unitUnsub[key](); delete S.unitUnsub[key]; delete S.content[id]; delete S.sub[id]; delete S.exr[id]; }
  }
  for (const id of Object.keys(S.resultUnsub)) {
    if (!isReleased(id)) { S.resultUnsub[id](); delete S.resultUnsub[id]; delete S.result[id]; }
  }
  for (const id of S.group?.releasedUnits || []) {
    if (S.resultUnsub[id] || !S.sub[id]) continue;
    S.resultUnsub[id] = onSnapshot(doc(db, "results", subId(id, S.user.uid)),
      (snap) => { S.result[id] = snap.exists() ? snap.data() : null; renderMain(); },
      () => { S.result[id] = null; renderMain(); });
  }
}

function ensureUnit(unitId) {
  if (S.unitUnsub[unitId]) return;
  S.unitUnsub[unitId] = onSnapshot(doc(db, "unitContent", unitId),
    (snap) => { S.content[unitId] = snap.exists() ? snap.data() : null; renderMain(); },
    () => { S.content[unitId] = null; renderMain(); });
  // results of exercises that the teacher checks one by one
  S.unitUnsub["exr:" + unitId] = onSnapshot(doc(db, "exerciseResults", subId(unitId, S.user.uid)),
    (snap) => { S.exr[unitId] = snap.exists() ? snap.data() : null; S.exrVer++; renderMain(); },
    () => { S.exr[unitId] = null; });
  // Своя работа — тоже в реальном времени (преподаватель может «вернуть на доработку»)
  const key = "sub:" + unitId;
  S.unitUnsub[key] = onSnapshot(doc(db, "submissions", subId(unitId, S.user.uid)), (snap) => {
    const server = snap.exists() ? snap.data() : { answers: {}, status: "none" };
    const cur = S.sub[unitId];
    if (!cur) {
      S.sub[unitId] = { ...server, dirty: false };
      // локальная копия новее серверной? (например, вкладку закрыли до отправки)
      const local = readLocal(unitId);
      const serverMs = server.updatedAt?.toMillis?.() || 0;
      if (local && local.ts > serverMs && server.status !== "submitted" && !isReleased(unitId)) {
        S.sub[unitId].answers = local.answers;
        S.sub[unitId].dirty = true;
        scheduleSave(unitId);
      }
    } else if (!snap.metadata.hasPendingWrites) {
      // обновляем статус; ответы — только если у нас нет несохранённых правок
      Object.assign(cur, { status: server.status, submittedAt: server.submittedAt, updatedAt: server.updatedAt || cur.updatedAt });
      if (!cur.dirty) cur.answers = server.answers || {};
    }
    syncUnitSubscriptions();
    renderNav(); renderMain();
  }, () => { S.sub[unitId] ??= { answers: {}, status: "none", dirty: false }; renderMain(); });
}

// ------------------------------------------------------------------ routing
function route() {
  const [unit, section] = location.hash.replace(/^#/, "").split("/");
  return { unit: unit || null, section: section || null };
}
window.addEventListener("hashchange", async () => { await flushSave(); renderNav(); renderMain(); window.scrollTo(0, 0); });

// ------------------------------------------------------------------ nav
function renderNav() {
  // tests appear only when the teacher has opened them (or released their results)
  const tests = visibleTests();
  $("#test-nav-wrap").hidden = !tests.length;
  const r = route();
  $("#test-nav").innerHTML = tests.map(([key, t]) => {
    const a = S.att[key];
    const note = t.released ? "Results available" : !t.open ? "Closed" : a?.status === "submitted" ? "Submitted" : a ? "In progress" : `${t.minutes} min · open now`;
    return `<a class="sb-item ${r.unit === "test" && r.section === key ? "on" : ""}" href="#test/${esc(key)}">
      <span class="ic">⏱</span><span class="t">${esc(t.title)}<span class="s">${esc(note)}</span></span></a>`;
  }).join("");
  renderUnitNav($("#unit-nav"), {
    units: S.units,
    route: route(),
    empty: "The course units will appear here.",
    state: (u) => {
      if (u.status === "soon") return { locked: true, note: "Coming soon", noteClass: "lock" };
      if (!isOpen(u.id)) return { locked: true, note: "🔒 Locked", noteClass: "lock" };
      if (isReleased(u.id)) return { locked: false, note: "✓ Results available", noteClass: "good" };
      const st = S.sub[u.id]?.status;
      return { locked: false, note: st === "submitted" ? "Submitted" : "" };
    },
  });
}

// ------------------------------------------------------------------ main
function setCrumb(html) { $("#crumb").innerHTML = html; }
const unitNum = (u) => u.order || S.units.indexOf(u) + 1;

function renderMain() {
  if (!S.user || !S.group) return;
  const r = route();
  if (r.unit === "test") { renderTest(r.section); return; }
  const unit = S.units.find((u) => u.id === r.unit);
  const content = $("#content");
  content.dataset.test = "";
  if (!unit) {
    const open = S.units.filter((u) => isOpen(u.id) && u.status !== "soon");
    document.title = COURSE_TITLE;
    setCrumb(`<b>${esc(COURSE_TITLE)}</b>`);
    $("#unit-bar").innerHTML = "";
    content.dataset.view = "";
    content.innerHTML = `<header class="page-h"><div class="pe">Welcome</div><h2>Hello${S.profile ? ", " + esc(S.profile.name) : ""}!</h2>
      <p class="pl">${open.length ? "Choose a unit to start working." : "No units are open yet. They will appear here automatically as soon as your teacher opens them."}</p></header>
      ${visibleTests().filter(([, t]) => t.open).map(([key, t]) => `<div class="ub ub-res"><span><b>Test: ${esc(t.title)}</b> · ${t.minutes} minutes</span><a class="btn primary" href="#test/${esc(key)}">Go to the test</a></div>`).join("")}
      ${open.length ? `<div class="cards">${open.map((u) => `<a class="pg" href="#${esc(u.id)}"><span class="d">Unit ${unitNum(u)}</span><span class="t">${esc(u.title)}</span></a>`).join("")}</div>` : ""}`;
    return;
  }
  document.title = `Unit ${unitNum(unit)} · ${unit.title}`;
  setCrumb(`<b>Unit ${unitNum(unit)}</b> &middot; ${esc(unit.title)}`);
  if (!isOpen(unit.id) || unit.status === "soon") {
    $("#unit-bar").innerHTML = "";
    content.dataset.view = "";
    content.innerHTML = `<header class="page-h"><div class="pe">Unit ${unitNum(unit)}</div><h2>${esc(unit.title)}</h2></header>
      <div class="locked-msg"><span class="big">🔒</span>${unit.status === "soon"
        ? "This unit is still being prepared."
        : "This unit is not open yet. It will open automatically when your teacher gives your group access."}</div>`;
    return;
  }
  ensureUnit(unit.id);
  const c = S.content[unit.id], sub = S.sub[unit.id];
  if (c === undefined || !sub) { content.innerHTML = `<p class="muted">Loading…</p>`; return; }
  if (c === null) { content.innerHTML = `<div class="locked-msg">You do not have access to this unit.</div>`; return; }

  const sec = c.sections.find((s) => s.id === r.section) || c.sections[0];
  const secIdx = c.sections.indexOf(sec) + 1;
  const meta = (unit.sections || []).find((s) => s.id === sec.id) || {};
  setCrumb(`<b>Unit ${unitNum(unit)}</b> &middot; ${unitNum(unit)}.${secIdx} ${esc(sec.title)}`);
  const released = isReleased(unit.id);
  const res = released ? S.result[unit.id] : undefined;
  const readOnly = released || sub.status === "submitted";
  const relEx = S.group.releasedEx?.[unit.id] || [];
  const viewKey = `${unit.id}/${sec.id}/${readOnly}/${!!res}/${relEx.join(",")}/${(S.group.feedbackEx?.[unit.id] || []).join(",")}/${S.exrVer}`;

  // do not re-render while the student is typing (keeps the cursor in place)
  const active = document.activeElement;
  if (content.dataset.view === viewKey && active?.dataset?.item && content.contains(active)) {
    renderUnitBar(unit, sub, released, res);
    return;
  }
  content.dataset.view = viewKey;
  content.dataset.unit = unit.id;
  content.innerHTML = `<header class="page-h"><div class="pe">Unit ${unitNum(unit)} &middot; ${unitNum(unit)}.${secIdx}</div>
      <h2>${esc(sec.title)}</h2>${meta.subtitle || sec.subtitle ? `<p class="pl">${esc(meta.subtitle || sec.subtitle)}</p>` : ""}</header>`
    + renderBlocks(sec.blocks, (ex) => {
      const exDone = relEx.includes(ex.id);   // the teacher has checked this exercise
      const fbOn = (S.group.feedbackEx?.[unit.id] || []).includes(ex.id);
      const fb = fbOn && !res ? S.exr[unit.id]?.feedback?.[ex.id] : null;
      const fbAt = S.exr[unit.id]?.feedbackAt?.[ex.id];
      return {
        itemExtra: fb ? (itemId) => feedbackHTML(fb[itemId], { checkedAt: fmtTime(fbAt) }) : null,
        answers: sub.answers?.[ex.id] || {},
        readOnly: readOnly || exDone,
        auto: res ? (isAuto(ex) ? res.auto?.[ex.id] || {} : null) : exDone ? S.exr[unit.id]?.items?.[ex.id] || {} : undefined,
        manual: res?.manual?.[ex.id],
        showPending: !!res,
        tag: ex.check === "teacher" && !res ? (exDone ? "Checked" : fb ? "Feedback ready – you can correct your text" : "Checked by your teacher") : "",
      };
    }, `${unitNum(unit)}.${secIdx}`) + pagerHTML(unit, c, sec);
  renderUnitBar(unit, sub, released, res);
}

function pagerHTML(unit, c, sec) {
  const i = c.sections.indexOf(sec);
  const prev = c.sections[i - 1], next = c.sections[i + 1];
  const n = unitNum(unit);
  return `<nav class="pager">
    ${prev ? `<a class="pg" href="#${unit.id}/${prev.id}"><span class="d">Previous</span><span class="t">${n}.${i} ${esc(prev.title)}</span></a>` : ""}
    ${next ? `<a class="pg next" href="#${unit.id}/${next.id}"><span class="d">Next</span><span class="t">${n}.${i + 2} ${esc(next.title)}</span></a>` : ""}
  </nav>`;
}

function renderUnitBar(unit, sub, released, res) {
  const bar = $("#unit-bar");
  let html;
  if (released) {
    html = res
      ? `<div class="ub ub-res"><b>Your result: ${res.score} / ${res.max}</b>
         <span>Auto-checked tasks ${res.autoScore}/${res.autoMax}${res.manualMax ? ` · open answers ${res.manualPending ? "being assessed" : res.manualScore + "/" + res.manualMax}` : ""}</span></div>`
      : `<div class="ub">Results are available, but your work for this unit was not submitted.</div>`;
  } else if (sub.status === "submitted") {
    html = `<div class="ub ub-sub">✓ Submitted ${fmtTime(sub.submittedAt)}. Your teacher will release the results.</div>`;
  } else {
    html = `<div class="ub"><span id="save-state" class="muted">${sub.dirty ? "Unsaved changes…" : sub.updatedAt ? "Draft saved " + fmtTime(sub.updatedAt) : "Your answers are saved automatically"}</span>
      <button class="btn primary" id="submit-unit">Submit this unit</button></div>`;
  }
  bar.innerHTML = html;
  $("#submit-unit")?.addEventListener("click", () => submitUnit(unit.id));
}

// ------------------------------------------------------------------ answers & autosave
$("#content").addEventListener("input", onAnswer);
$("#content").addEventListener("change", onAnswer);
function onAnswer(e) {
  const el = e.target;
  if (!el.dataset?.item || el.disabled) return;
  const wcEl = document.querySelector(`[data-wc="${CSS.escape(el.dataset.ex + ":" + el.dataset.item)}"]`);
  if (wcEl) wcEl.textContent = countWords(el.value);
  if ($("#content").dataset.test) { onTestAnswer(el); return; }
  const unitId = $("#content").dataset.unit;
  const sub = S.sub[unitId];
  const v = readInput(el);
  if (v === null) return;
  sub.answers ??= {};
  sub.answers[el.dataset.ex] ??= {};
  if (sub.answers[el.dataset.ex][el.dataset.item] === v) return;
  sub.answers[el.dataset.ex][el.dataset.item] = v;
  sub.dirty = true;
  writeLocal(unitId, sub.answers);
  setSaveState("Editing…");
  scheduleSave(unitId);
}

function scheduleSave(unitId) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft(unitId), SAVE_DELAY);
}

async function saveDraft(unitId, status = "draft") {
  const sub = S.sub[unitId];
  if (!sub || (!sub.dirty && status === "draft")) return;
  sub.dirty = false;
  const data = {
    uid: S.user.uid, groupId: S.profile.groupId, unitId,
    answers: sub.answers || {}, status, updatedAt: serverTimestamp(),
  };
  if (status === "submitted") data.submittedAt = serverTimestamp();
  setSaveState("Saving…");
  const p = setDoc(doc(db, "submissions", subId(unitId, S.user.uid)), data);
  // запись уже в локальном кэше (IndexedDB) — даже офлайн она не потеряется
  setSaveState("Saved on this device…");
  try {
    await p;
    sub.updatedAt = new Date();
    sub.status = status;
    if (status === "submitted") sub.submittedAt = new Date();
    clearLocal(unitId);
    setSaveState("✓ Saved " + fmtTime(new Date()));
  } catch (e) {
    sub.dirty = true;
    setSaveState("⚠ Not saved: " + friendlyError(e));
    throw e;
  }
}

async function flushSave() {
  clearTimeout(saveTimer);
  const unitId = $("#content").dataset.unit;
  if (unitId && S.sub[unitId]?.dirty) await saveDraft(unitId).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
window.addEventListener("pagehide", () => flushSave());

async function submitUnit(unitId) {
  const c = S.content[unitId], sub = S.sub[unitId];
  const total = exercisesOf(c).reduce((n, ex) => n + (ex.items || []).length, 0);
  const filled = exercisesOf(c).reduce((n, ex) => n + (ex.items || []).filter((it) => String(sub.answers?.[ex.id]?.[it.id] ?? "").trim()).length, 0);
  if (!confirm(`Submit your work? You have answered ${filled} of ${total} items.\nYou will not be able to change your answers after submitting.`)) return;
  clearTimeout(saveTimer);
  sub.dirty = true;
  try {
    await saveDraft(unitId, "submitted");
    syncUnitSubscriptions();
    renderMain();
  } catch (e) { alert(friendlyError(e)); }
}

function setSaveState(t) { const el = $("#save-state"); if (el) el.textContent = t; }

// localStorage — страховка на окно между вводом и отправкой
const lsKey = (unitId) => `draft:${S.user?.uid}:${unitId}`;
function writeLocal(unitId, answers) { try { localStorage.setItem(lsKey(unitId), JSON.stringify({ ts: Date.now(), answers })); } catch {} }
function readLocal(unitId) { try { return JSON.parse(localStorage.getItem(lsKey(unitId))); } catch { return null; } }
function clearLocal(unitId) { try { localStorage.removeItem(lsKey(unitId)); } catch {} }

// ------------------------------------------------------------------ the book cannot be copied or pasted into
function protectBook() {
  document.body.classList.add("protect");
  const content = document.querySelector("#content");
  const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  let lastNote = 0;
  const note = (t) => {
    if (Date.now() - lastNote < 1500) return;
    lastNote = Date.now();
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = t;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  };
  ["copy", "cut"].forEach((ev) => content.addEventListener(ev, (e) => { e.preventDefault(); note("Copying is turned off in this course book."); }));
  content.addEventListener("contextmenu", (e) => { if (!isField(e.target)) e.preventDefault(); });
  content.addEventListener("dragstart", (e) => e.preventDefault());
  content.addEventListener("paste", (e) => { e.preventDefault(); note("Pasting is turned off. Please type your answer."); });
  content.addEventListener("drop", (e) => { e.preventDefault(); note("Pasting is turned off. Please type your answer."); });
  content.addEventListener("beforeinput", (e) => {
    if (["insertFromPaste", "insertFromDrop", "insertFromYank", "insertFromPasteAsQuotation"].includes(e.inputType)) {
      e.preventDefault(); note("Pasting is turned off. Please type your answer.");
    }
  });
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === "p" || k === "s")) { e.preventDefault(); note("Printing and saving are turned off in this course book."); }
  });
}

// ------------------------------------------------------------------ timed tests
function visibleTests() {
  return Object.entries(S.group?.tests || {})
    .filter(([key, t]) => t && (t.open || t.released || S.att[key]))
    .sort((a, b) => (a[1].title || "").localeCompare(b[1].title || ""));
}
const attRef = (key) => doc(db, "testAttempts", `${key}__${S.user.uid}`);

function ensureAttempt(key) {
  if (S.attUnsub[key]) return;
  S.attUnsub[key] = onSnapshot(attRef(key), (snap) => {
    const a = snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null;
    S.att[key] = a;
    if (a && S.tdraft[key] === undefined) S.tdraft[key] = structuredClone(a.answers || {});
    if (a && S.tcontent[key] === undefined && !snap.metadata.hasPendingWrites) loadTestContent(key);
    renderNav(); renderMain();
  }, () => { S.att[key] = null; renderMain(); });
}
async function loadTestContent(key) {
  S.tcontent[key] = "loading";
  try {
    const snap = await getDoc(doc(db, "testContent", key));
    S.tcontent[key] = snap.exists() ? snap.data() : null;
  } catch { S.tcontent[key] = null; }
  renderMain();
}
function ensureTestResult(key) {
  if (S.tresUnsub[key]) return;
  S.tresUnsub[key] = onSnapshot(doc(db, "testResults", `${key}__${S.user.uid}`),
    (snap) => { S.tres[key] = snap.exists() ? snap.data() : null; renderMain(); },
    () => { S.tres[key] = null; });
}

const deadlineOf = (key) => {
  const a = S.att[key], t = S.group?.tests?.[key];
  const start = a?.startedAt?.toMillis?.();
  return start && t ? start + t.minutes * 60000 : null;
};
const fmtLeft = (ms) => { const sec = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };

function renderTest(key) {
  const content = $("#content");
  const t = S.group?.tests?.[key];
  content.dataset.unit = "";
  setCrumb(`<b>Test</b> &middot; ${esc(t?.title || "")}`);
  $("#unit-bar").innerHTML = "";
  if (!t) { content.dataset.view = ""; content.dataset.test = ""; content.innerHTML = `<div class="locked-msg">This test is not available.</div>`; return; }
  ensureAttempt(key);
  if (t.released) ensureTestResult(key);
  const a = S.att[key];
  const head = `<header class="page-h"><div class="pe">Test</div><h2>${esc(t.title)}</h2><p class="pl">Time limit: ${t.minutes} minutes</p></header>`;
  document.title = `Test · ${t.title}`;
  if (a === undefined) { content.innerHTML = head + `<p class="muted">Loading…</p>`; return; }
  if (a === null) {
    content.dataset.view = ""; content.dataset.test = "";
    content.innerHTML = head + (t.open
      ? `<div class="box"><p><b>You have ${t.minutes} minutes for this test.</b> The timer starts when you click <b>Start the test</b> and cannot be paused.</p>
         <p>Your answers are saved automatically. When the time is up, the test closes and your answers are submitted as they are.</p>
         <button class="btn primary" id="start-test">Start the test</button></div>`
      : `<div class="locked-msg">This test is closed.</div>`);
    $("#start-test")?.addEventListener("click", () => startTest(key));
    return;
  }
  const c = S.tcontent[key];
  if (c === undefined || c === "loading") { content.innerHTML = head + `<p class="muted">Loading the test…</p>`; return; }
  if (c === null) { content.innerHTML = head + `<div class="locked-msg">The test cannot be shown. It may have been closed by your teacher.</div>`; return; }
  const deadline = deadlineOf(key);
  const timeUp = deadline && Date.now() >= deadline;
  const readOnly = a.status === "submitted" || timeUp || !t.open;
  const res = t.released ? S.tres[key] : undefined;
  const viewKey = `test/${key}/${readOnly}/${!!res}`;
  const active = document.activeElement;
  if (content.dataset.view === viewKey && active?.dataset?.item && content.contains(active)) { renderTestBar(key, readOnly, res); return; }
  content.dataset.view = viewKey;
  content.dataset.test = key;
  if (readOnly && a.status !== "submitted" && !timeUp) {}  // closed by the teacher
  content.innerHTML = head + (c.rubric ? `<div class="rubric">${c.rubric}</div>` : "")
    + renderBlocks(c.exercises || [], (ex) => ({
      answers: (S.tdraft[key] || a.answers || {})[ex.id] || {},
      readOnly,
      auto: res ? res.items?.[ex.id] || {} : undefined,
    }))
    + (readOnly ? "" : `<div class="row" style="margin-top:24px"><button class="btn primary" id="submit-test">Submit the test</button></div>`);
  $("#submit-test")?.addEventListener("click", () => submitTest(key, true));
  renderTestBar(key, readOnly, res);
  if (!readOnly && timeUp === false) startTicker(key);
  if (timeUp && a.status !== "submitted") submitTest(key, false);
}

function renderTestBar(key, readOnly, res) {
  const t = S.group.tests[key], a = S.att[key];
  let html;
  if (t.released) html = res ? `<div class="ub ub-res"><b>Your result: ${res.score} / ${res.max}</b><span>${esc(t.title)}</span></div>`
                             : `<div class="ub">Results are available, but you did not answer this test.</div>`;
  else if (readOnly) html = `<div class="ub ub-sub">✓ Your answers have been submitted. Your teacher will show the results.</div>`;
  else html = `<div class="ub" style="position:sticky;top:64px;z-index:5"><span id="save-state" class="muted">Your answers are saved automatically</span>
      <b id="test-timer" style="font-family:var(--mono);font-size:18px">${fmtLeft(deadlineOf(key) - Date.now())}</b></div>`;
  $("#unit-bar").innerHTML = html;
}

let ticker = null, tickerKey = null;
function startTicker(key) {
  if (ticker && tickerKey === key) return;
  clearInterval(ticker); tickerKey = key;
  ticker = setInterval(() => {
    if (route().section !== key) { clearInterval(ticker); ticker = null; return; }
    const left = deadlineOf(key) - Date.now();
    const el = $("#test-timer");
    if (el) { el.textContent = fmtLeft(left); el.style.color = left < 60000 ? "var(--bad)" : ""; }
    if (left <= 0) { clearInterval(ticker); ticker = null; submitTest(key, false); }
  }, 1000);
}

async function startTest(key) {
  try {
    await setDoc(attRef(key), {
      uid: S.user.uid, groupId: S.profile.groupId, testKey: key,
      startedAt: serverTimestamp(), updatedAt: serverTimestamp(), answers: {}, status: "in_progress",
    });
  } catch (e) { alert(friendlyError(e)); }
}

let testTimer = null;
function onTestAnswer(el) {
  const key = $("#content").dataset.test;
  const v = readInput(el);
  if (v === null) return;
  const d = (S.tdraft[key] ??= {});
  (d[el.dataset.ex] ??= {})[el.dataset.item] = v;
  setSaveState("Editing…");
  clearTimeout(testTimer);
  testTimer = setTimeout(() => saveTest(key), 800);
}
async function saveTest(key, status) {
  const data = { answers: S.tdraft[key] || {}, updatedAt: serverTimestamp() };
  if (status) data.status = status;
  setSaveState("Saving…");
  try { await updateDoc(attRef(key), data); setSaveState("✓ Saved " + fmtTime(new Date())); return true; }
  catch (e) { setSaveState("⚠ Not saved: the time may be over."); return false; }
}
let submitting = false;
async function submitTest(key, ask) {
  if (submitting || S.att[key]?.status === "submitted") return;
  if (ask && !confirm("Submit the test now? You will not be able to change your answers.")) return;
  submitting = true;
  clearTimeout(testTimer);
  await saveTest(key, "submitted");
  submitting = false;
  renderMain();
}
