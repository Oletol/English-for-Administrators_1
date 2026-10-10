// Teacher's Edition: unit preview with keys, unit access per group, releasing results,
// manual assessment of open answers, analytics, content import, groups and students.
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, orderBy,
  writeBatch, arrayUnion, arrayRemove, serverTimestamp,
} from "./fb.js";
import { COURSE_TITLE } from "./firebase-config.js";
import {
  esc, renderBlocks, renderExercise, exercisesOf, isAuto, gradeAuto, buildResult, keyText, norm,
  fmtTime, friendlyError, authFormHTML, wireAuthForm, subId, KIND_LABEL, isTeacherChecked, gradeExercise, wireFlashcards, isManual,
} from "./common.js";
import { initShell, renderUnitNav, wireUnitNav } from "./shell.js";
import { loadVocab, grammarCheck, vocabProfile, unitVocabulary, feedbackHTML, sleep } from "./writing.js";

const $ = (s) => document.querySelector(s);
const ls = {
  get: (k, d) => { try { return localStorage.getItem("t:" + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("t:" + k, v); } catch {} },
};
const T = {
  user: null, groups: [], units: [], users: [], usersLoaded: false,
  gid: ls.get("gid", ""), unitId: ls.get("unit", ""),
  students: [], subs: [], results: {}, exr: {},
  unitData: {},          // unitId -> {content, keys, notes}
  selected: null,        // student uid opened in "Student work"
  includeDrafts: false,
  groupFilter: null,
  showCorrect: ls.get("showCorrect", "1") === "1",
  tests: [], testsLoaded: false, testSel: null, attempts: [], testRes: {}, testContent: {},
  unsub: [], ctxUnsub: [],
};

const TOOLS = [
  { id: "access", icon: "🔓", title: "Access & results", sub: "Open units, release results" },
  { id: "works", icon: "📝", title: "Student work", sub: "Answers, open-answer marking" },
  { id: "tests", icon: "⏱", title: "Tests", sub: "Timed tests: open, watch, check" },
  { id: "stats", icon: "📊", title: "Analytics", sub: "Difficult questions, heat map" },
  { id: "groups", icon: "👥", title: "Groups & students", sub: "Group codes, moving students" },
  { id: "content", icon: "📦", title: "Course content", sub: "Import units and keys" },
];

document.title = `Teacher's Edition · ${COURSE_TITLE}`;
document.querySelectorAll("[data-course-title]").forEach((el) => (el.textContent = COURSE_TITLE));
initShell();
wireFlashcards();
wireUnitNav($("#unit-nav"), () => renderNav());

function toast(t, ms = 3500) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = t;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast("Error: " + friendlyError(e), 6000); }
}

// ------------------------------------------------------------------ auth
$("#auth-screen").innerHTML = authFormHTML({ eyebrow: COURSE_TITLE, title: "Teacher's Edition", allowRegister: false });
wireAuthForm($("#auth-screen"), {
  async login(f) { await signInWithEmailAndPassword(auth, f.email.trim(), f.password); },
  async reset(f) { await sendPasswordResetEmail(auth, f.email.trim()); return "We have sent you a link to reset your password."; },
});
$("#logout").addEventListener("click", () => signOut(auth));
$("#logout2").addEventListener("click", (e) => { e.preventDefault(); signOut(auth); });

onAuthStateChanged(auth, async (user) => {
  T.unsub.forEach((u) => u()); T.unsub = [];
  T.ctxUnsub.forEach((u) => u()); T.ctxUnsub = []; ctxKey = "";
  T.user = user;
  $("#boot").hidden = true;
  $("#auth-screen").hidden = !!user;
  $("#app").hidden = true; $("#denied").hidden = true;
  if (!user) return;
  const t = await getDoc(doc(db, "teachers", user.uid)).catch(() => null);
  if (!t?.exists()) { $("#denied").hidden = false; return; }
  $("#app").hidden = false;
  $("#me-email").textContent = user.email;

  T.unsub.push(onSnapshot(collection(db, "groups"), (snap) => {
    T.groups = snap.docs.map((d) => ({ id: d.id, openUnits: [], releasedUnits: [], releasedEx: {}, feedbackEx: {}, tests: {}, ...d.data() }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (!T.groups.find((g) => g.id === T.gid)) T.gid = T.groups[0]?.id || "";
    fillCtx(); subscribeCtx(); render();
  }));
  T.unsub.push(onSnapshot(query(collection(db, "units"), orderBy("order")), (snap) => {
    T.units = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!T.units.find((u) => u.id === T.unitId)) T.unitId = (T.units.find((u) => u.status !== "soon") || T.units[0])?.id || "";
    fillCtx(); subscribeCtx(); render();
  }));
});

// ------------------------------------------------------------------ context: group + unit
function fillCtx() {
  $("#ctx-group").innerHTML = T.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === T.gid ? "selected" : ""}>${esc(g.name || g.id)}</option>`).join("") || `<option value="">no groups yet</option>`;
  $("#ctx-unit").innerHTML = T.units.map((u, i) => `<option value="${esc(u.id)}" ${u.id === T.unitId ? "selected" : ""}>Unit ${u.order || i + 1}</option>`).join("") || `<option value="">no units yet</option>`;
}
$("#ctx-group").addEventListener("change", (e) => { T.gid = e.target.value; ls.set("gid", T.gid); T.selected = null; subscribeCtx(); render(); });
$("#ctx-unit").addEventListener("change", (e) => setUnit(e.target.value));
function setUnit(id) {
  if (!id || id === T.unitId) return;
  T.unitId = id; ls.set("unit", id); T.selected = null;
  $("#ctx-unit").value = id;
  subscribeCtx(); render();
}

let ctxKey = "";
function subscribeCtx() {
  const key = T.gid + "|" + T.unitId;
  if (key === ctxKey) return;
  ctxKey = key;
  T.ctxUnsub.forEach((u) => u()); T.ctxUnsub = [];
  T.students = []; T.subs = []; T.results = {};
  if (!T.gid) return;
  // students of the group, their work and results — all in real time
  T.ctxUnsub.push(onSnapshot(query(collection(db, "users"), where("groupId", "==", T.gid)), (snap) => {
    T.students = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    render();
  }));
  if (!T.unitId) return;
  loadUnitData(T.unitId).then(render);
  T.ctxUnsub.push(onSnapshot(query(collection(db, "submissions"), where("groupId", "==", T.gid), where("unitId", "==", T.unitId)), (snap) => {
    T.subs = snap.docs.map((d) => d.data());
    render();
  }));
  T.ctxUnsub.push(onSnapshot(query(collection(db, "exerciseResults"), where("groupId", "==", T.gid), where("unitId", "==", T.unitId)), (snap) => {
    T.exr = Object.fromEntries(snap.docs.map((d) => [d.data().uid, d.data()]));
    render();
  }));
  T.ctxUnsub.push(onSnapshot(query(collection(db, "results"), where("groupId", "==", T.gid), where("unitId", "==", T.unitId)), (snap) => {
    T.results = Object.fromEntries(snap.docs.map((d) => [d.data().uid, d.data()]));
    render();
  }));
}

async function loadUnitData(unitId, force = false) {
  if (T.unitData[unitId] && !force) return T.unitData[unitId];
  const [c, k] = await Promise.all([getDoc(doc(db, "unitContent", unitId)), getDoc(doc(db, "answerKeys", unitId))]);
  T.unitData[unitId] = {
    content: c.exists() ? c.data() : null,
    keys: k.exists() ? k.data().exercises || {} : {},
    notes: k.exists() ? k.data().notes || {} : {},
  };
  return T.unitData[unitId];
}

// ------------------------------------------------------------------ routing & sidebar
// #tools/<id>  — teaching tools;  #<unitId>/<sectionId> — unit with keys and notes
function route() {
  const [a, b] = location.hash.replace(/^#/, "").split("/");
  if (!a || a === "tools") return { tool: TOOLS.find((t) => t.id === b)?.id || "access" };
  return { unit: a, section: b || null };
}
window.addEventListener("hashchange", () => {
  const r = route();
  if (r.unit) setUnit(r.unit);
  T.selected = r.tool === "works" ? T.selected : null;
  render(true);
  window.scrollTo(0, 0);
});

const group = () => T.groups.find((g) => g.id === T.gid);
const unit = () => T.units.find((u) => u.id === T.unitId);
const unitNum = (u) => u.order || T.units.indexOf(u) + 1;

function renderNav() {
  const r = route();
  $("#tool-nav").innerHTML = TOOLS.map((t) => `<a class="sb-item ${r.tool === t.id ? "on" : ""}" href="#tools/${t.id}">
      <span class="ic">${t.icon}</span><span class="t">${t.title}<span class="s">${t.sub}</span></span></a>`).join("");
  const g = group();
  renderUnitNav($("#unit-nav"), {
    units: T.units,
    route: { unit: r.unit, section: r.section },
    empty: `No units yet. Import the course file in <a href="#tools/content">Course content</a>.`,
    state: (u) => {
      if (u.status === "soon") return { locked: false, note: "Coming soon", noteClass: "lock" };
      if (!g) return { locked: false, note: "" };
      if (g.releasedUnits.includes(u.id)) return { locked: false, note: `✓ Results released · ${esc(g.name)}`, noteClass: "good" };
      if (g.openUnits.includes(u.id)) return { locked: false, note: `Open for ${esc(g.name)}`, noteClass: "good" };
      return { locked: false, note: `Closed for ${esc(g.name)}`, noteClass: "lock" };
    },
  });
}

function render(force = false) {
  if (!T.user || $("#app").hidden) return;
  renderNav();
  // do not re-render while the teacher is typing a mark, comment or JSON
  const a = document.activeElement;
  if (!force && a && $("#view").contains(a) && a.matches(".g-score,.g-comment,textarea.json,input[type=text],input:not([type])")) return;
  const r = route();
  if (r.unit && r.unit !== T.unitId && T.units.some((u) => u.id === r.unit)) { setUnit(r.unit); return; }
  $("#wrap").classList.toggle("wide", !!r.tool && r.tool !== "content");
  if (r.unit) { $("#view").innerHTML = viewUnit(r); return; }
  const tool = TOOLS.find((t) => t.id === r.tool);
  $("#crumb").innerHTML = `<b>Teaching tools</b> &middot; ${tool.title}`;
  const views = { access: viewAccess, works: viewWorks, tests: viewTests, stats: viewStats, content: viewContent, groups: viewGroups };
  $("#view").innerHTML = views[r.tool]();
}

const pageHead = (eyebrow, title, lead = "") =>
  `<header class="page-h"><div class="pe">${eyebrow}</div><h2>${title}</h2>${lead ? `<p class="pl">${lead}</p>` : ""}</header>`;

// ================================================================== Unit with keys
function viewUnit(r) {
  const u = T.units.find((x) => x.id === r.unit);
  if (!u) return pageHead("Unit", "Unit not found");
  const n = unitNum(u);
  $("#crumb").innerHTML = `<b>Unit ${n}</b> &middot; ${esc(u.title)}`;
  const g = group();
  const bar = g && u.status !== "soon" ? accessBar(u, g) : "";
  if (u.status === "soon") return pageHead(`Unit ${n}`, esc(u.title)) + `<div class="locked-msg"><span class="big">🛠</span>This unit is still being prepared. Import its content in <a href="#tools/content">Course content</a>.</div>`;
  const d = T.unitData[u.id];
  if (!d) { loadUnitData(u.id).then(() => render(true)); return `<p class="muted">Loading…</p>`; }
  if (!d.content) return pageHead(`Unit ${n}`, esc(u.title)) + `<div class="locked-msg">This unit has no content yet.</div>`;
  const secs = d.content.sections;
  const sec = secs.find((s) => s.id === r.section) || secs[0];
  const i = secs.indexOf(sec);
  const meta = (u.sections || []).find((s) => s.id === sec.id) || {};
  $("#crumb").innerHTML = `<b>Unit ${n}</b> &middot; ${n}.${i + 1} ${esc(sec.title)}`;
  const blocks = [...sec.blocks];
  for (const note of [...(d.notes[sec.id] || [])].reverse()) blocks.splice(note.at, 0, { type: "teacher-note", html: note.html });
  const prev = secs[i - 1], next = secs[i + 1];
  return bar + pageHead(`Unit ${n} &middot; ${n}.${i + 1}`, esc(sec.title), esc(meta.subtitle || sec.subtitle || ""))
    + renderBlocks(blocks, (ex) => ({
      key: d.keys[ex.id] || {}, readOnly: true,
      tag: ex.check === "teacher" ? (isManual(ex) ? "Writing check by the teacher" : "Checked by the teacher") : "",
      before: ex.check === "teacher" && g ? (isManual(ex) ? writingBar(u, ex, g) : exerciseBar(u, ex, g)) : "",
    }), `${n}.${i + 1}`)
    + `<nav class="pager">
      ${prev ? `<a class="pg" href="#${u.id}/${prev.id}"><span class="d">Previous</span><span class="t">${n}.${i} ${esc(prev.title)}</span></a>` : ""}
      ${next ? `<a class="pg next" href="#${u.id}/${next.id}"><span class="d">Next</span><span class="t">${n}.${i + 2} ${esc(next.title)}</span></a>` : ""}
    </nav>`;
}

// Exercises marked "check": "teacher" are checked one at a time, when the teacher decides
function exerciseBar(u, ex, g) {
  const done = (g.releasedEx?.[u.id] || []).includes(ex.id);
  return `<div class="ex-bar"><span>Group <b>${esc(g.name)}</b>: <span class="pill ${done ? "on" : "off"}">${done ? "checked · results shown" : "not checked yet"}</span></span>
    <span class="sp" style="flex:1"></span>
    ${done
      ? `<button class="btn small" data-act="check-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" title="Check again, e.g. for students who answered later">Re-check</button>
         <button class="btn small danger" data-act="uncheck-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}">Hide results</button>`
      : `<button class="btn small good" data-act="check-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" ${g.openUnits.includes(u.id) ? "" : "disabled title=\"Open the unit for the group first\""}>Check this exercise now</button>`}
  </div>`;
}

async function checkExercise(gid, unitId, exId) {
  await guard(async () => {
    const { content, keys } = await loadUnitData(unitId, true);
    const ex = exercisesOf(content).find((e) => e.id === exId);
    if (!ex) throw new Error("Exercise not found.");
    const subs = (await getDocs(query(collection(db, "submissions"), where("groupId", "==", gid), where("unitId", "==", unitId)))).docs.map((d) => d.data());
    const answered = subs.filter((s) => Object.values(s.answers?.[exId] || {}).some((v) => String(v).trim()));
    if (!confirm(`Check “${ex.title}” for the group and show the students their results?\nStudents who have answered: ${answered.length} of ${T.students.length}.\nAfter this, students can no longer change their answers in this exercise.`)) return;
    let batch = writeBatch(db), n = 0;
    for (const s of subs) {
      const r = gradeExercise(ex, s.answers?.[exId], keys[exId]);
      if (!T.showCorrect) for (const it of Object.values(r.items)) delete it.correct;
      batch.set(doc(db, "exerciseResults", subId(unitId, s.uid)), {
        uid: s.uid, groupId: gid, unitId,
        items: { [exId]: r.items }, scores: { [exId]: { score: r.score, max: r.max } },
        updatedAt: serverTimestamp(),
      }, { merge: true });
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    batch.update(doc(db, "groups", gid), { [`releasedEx.${unitId}`]: arrayUnion(exId) });
    await batch.commit();
    toast(`Exercise checked for ${subs.length} ${subs.length === 1 ? "student" : "students"}. They can see their results now.`);
  });
}

// Free writing ("kind": "open", "check": "teacher"): the check gives feedback, the text stays editable
function writingBar(u, ex, g) {
  const done = (g.feedbackEx?.[u.id] || []).includes(ex.id);
  return `<div class="ex-bar"><span>Group <b>${esc(g.name)}</b>: <span class="pill ${done ? "on" : "off"}">${done ? "feedback shown" : "not checked yet"}</span></span>
    <span class="sp" style="flex:1"></span>
    <span id="wcheck-progress" class="muted"></span>
    <button class="btn small good" data-act="check-writing" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" ${g.openUnits.includes(u.id) ? "" : "disabled"}>${done ? "Check again" : "Check the writing now"}</button>
    ${done ? `<button class="btn small danger" data-act="hide-writing" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}">Hide feedback</button>` : ""}
  </div>`;
}

async function checkWriting(gid, unitId, exId) {
  await guard(async () => {
    const { content } = await loadUnitData(unitId, true);
    const ex = exercisesOf(content).find((e) => e.id === exId);
    const subs = (await getDocs(query(collection(db, "submissions"), where("groupId", "==", gid), where("unitId", "==", unitId)))).docs.map((d) => d.data())
      .filter((s) => Object.values(s.answers?.[exId] || {}).some((v) => String(v).trim()));
    if (!confirm(`Check the writing in “${ex.title}”?\nStudents with answers: ${subs.length}.\nThe texts are sent to LanguageTool for the grammar check (about 3 seconds per student). Students will see the feedback and can correct their texts.`)) return;
    const V = await loadVocab();
    const phrases = unitVocabulary(content);
    let n = 0, ltFailed = 0;
    for (const s of subs) {
      n++;
      const prog = document.querySelector("#wcheck-progress");
      if (prog) prog.textContent = `Checking ${n} of ${subs.length}…`;
      const texts = s.answers[exId] || {};
      let issues = {}, grammarError = false;
      try { issues = await grammarCheck(texts); } catch (e) { console.warn(e); grammarError = true; ltFailed++; }
      const fb = {};
      for (const it of ex.items || []) {
        const text = String(texts[it.id] || "");
        if (!text.trim()) continue;
        fb[it.id] = { text, issues: issues[it.id] || [], grammarError, vocab: vocabProfile(text, V, phrases), unitTotal: phrases.length };
      }
      await setDoc(doc(db, "exerciseResults", subId(unitId, s.uid)), {
        uid: s.uid, groupId: gid, unitId,
        feedback: { [exId]: fb }, feedbackAt: { [exId]: serverTimestamp() },
      }, { merge: true });
      if (n < subs.length && !grammarError) await sleep(3200);   // LanguageTool: at most 20 requests a minute
    }
    await updateDoc(doc(db, "groups", gid), { [`feedbackEx.${unitId}`]: arrayUnion(exId) });
    toast(ltFailed ? `Done. The grammar check was not available for ${ltFailed} of ${subs.length}; the vocabulary check worked.` : `Done: ${subs.length} texts checked. Students can see the feedback now.`, 7000);
  });
}

function accessBar(u, g) {
  const open = g.openUnits.includes(u.id), rel = g.releasedUnits.includes(u.id);
  return `<div class="ub"><span>Group <b>${esc(g.name)}</b>:
      <span class="pill ${open ? "on" : "off"}">${open ? "open" : "closed"}</span>
      <span class="pill ${rel ? "on" : "off"}">${rel ? "results released" : "results hidden"}</span></span>
    <span class="row">
      <button class="btn small" data-act="toggle-open" data-unit="${esc(u.id)}">${open ? "Close for the group" : "Open for the group"}</button>
      ${rel ? `<button class="btn small danger" data-act="unrelease" data-unit="${esc(u.id)}">Hide results</button>`
            : `<button class="btn small good" data-act="release" data-unit="${esc(u.id)}" ${open ? "" : "disabled"}>Check &amp; release results</button>`}
    </span></div>`;
}

// ================================================================== Access & results
function viewAccess() {
  const g = group();
  const head = pageHead("Teaching tools", "Access &amp; results",
    "Students see changes immediately, without reloading the page.");
  if (!g) return head + `<div class="box">First create a group in <a href="#tools/groups">Groups &amp; students</a>.</div>`;
  const rows = T.units.map((u) => {
    const soon = u.status === "soon";
    const open = g.openUnits.includes(u.id), rel = g.releasedUnits.includes(u.id);
    return `<tr>
      <td class="num">${unitNum(u)}</td>
      <td><a href="#${esc(u.id)}">${esc(u.title)}</a></td>
      <td>${soon ? `<span class="pill off">coming soon</span>` : `<span class="pill ${open ? "on" : "off"}">${open ? "open" : "closed"}</span>
        <button class="btn small" data-act="toggle-open" data-unit="${esc(u.id)}">${open ? "Close" : "Open"}</button>`}</td>
      <td>${soon ? "" : `<span class="pill ${rel ? "on" : "off"}">${rel ? "released" : "hidden"}</span>
        ${rel
          ? `<button class="btn small" data-act="release" data-unit="${esc(u.id)}" title="Re-check, e.g. for work submitted late">Re-check</button>
             <button class="btn small danger" data-act="unrelease" data-unit="${esc(u.id)}">Hide</button>`
          : `<button class="btn small good" data-act="release" data-unit="${esc(u.id)}" ${open ? "" : "disabled"}>Check &amp; release</button>`}`}</td>
    </tr>`;
  }).join("");
  return head + `
  <div class="box"><b>Group: ${esc(g.name)}</b> <span class="muted">(code <code>${esc(g.id)}</code>)</span><br>
  <span class="muted">“Check &amp; release” marks all <b>submitted</b> work of the group against the keys, saves the results and shows them to the students. After that students can no longer change their answers.</span>
  <label class="row" style="margin-top:10px"><input type="checkbox" id="show-correct" ${T.showCorrect ? "checked" : ""}> Show students the correct answers to their mistakes</label></div>
  <table class="t"><tr><th>#</th><th>Unit</th><th>Access for the group</th><th>Results</th></tr>${rows}</table>`;
}

document.addEventListener("change", (e) => {
  if (e.target.id === "show-correct") { T.showCorrect = e.target.checked; ls.set("showCorrect", T.showCorrect ? "1" : "0"); }
  if (e.target.id === "inc-drafts") { T.includeDrafts = e.target.checked; render(true); }
  if (e.target.id === "g-filter") { T.groupFilter = e.target.value; render(true); }
  if (e.target.matches("select[data-move]")) guard(async () => {
    await updateDoc(doc(db, "users", e.target.dataset.move), { groupId: e.target.value });
    toast("The student has been moved to another group.");
    await loadAllUsers();
  });
  if (e.target.id === "import-file") {
    const f = e.target.files[0];
    if (f) f.text().then((t) => { $("#import-text").value = t; });
  }
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault();
  const act = b.dataset.act, u = b.dataset.unit;
  const handlers = {
    "toggle-open": () => guard(async () => {
      const open = group().openUnits.includes(u);
      await updateDoc(doc(db, "groups", T.gid), { openUnits: open ? arrayRemove(u) : arrayUnion(u) });
    }),
    "release": () => releaseUnit(T.gid, u),
    "check-ex": () => checkExercise(T.gid, u, b.dataset.ex),
    "check-writing": () => checkWriting(T.gid, u, b.dataset.ex),
    "hide-writing": () => guard(async () => updateDoc(doc(db, "groups", T.gid), { [`feedbackEx.${u}`]: arrayRemove(b.dataset.ex) })),
    "uncheck-ex": () => guard(async () => {
      if (!confirm("Hide the results of this exercise from the students? They will be able to change their answers again.")) return;
      await updateDoc(doc(db, "groups", T.gid), { [`releasedEx.${u}`]: arrayRemove(b.dataset.ex) });
    }),
    "unrelease": () => guard(async () => {
      if (!confirm("Hide the results from the students? Students will again be able to edit drafts they have not submitted.")) return;
      await updateDoc(doc(db, "groups", T.gid), { releasedUnits: arrayRemove(u) });
    }),
    "select-student": () => { T.selected = b.dataset.uid; if (route().tool !== "works") location.hash = "#tools/works"; else render(true); setTimeout(() => $("#detail")?.scrollIntoView({ behavior: "smooth" }), 50); },
    "save-grades": () => saveGrades(b.dataset.uid),
    "return": () => guard(async () => {
      if (!confirm("Return this work to the student for revision?")) return;
      await updateDoc(doc(db, "submissions", subId(T.unitId, b.dataset.uid)), { status: "draft" });
      toast("The work has been returned to the student.");
    }),
    "import": () => importCourse(),
    "delete-unit": () => deleteUnit(u),
    "create-group": () => createGroup(),
    "load-users": () => loadAllUsers(),
    "test-open": () => openTest(b.dataset.key),
    "test-close": () => guard(async () => {
      if (!confirm("Close the test? Students who have not finished will not be able to continue.")) return;
      await updateDoc(doc(db, "groups", T.gid), { [`tests.${b.dataset.key}.open`]: false });
    }),
    "test-release": () => releaseTest(b.dataset.key),
    "test-unrelease": () => guard(async () => updateDoc(doc(db, "groups", T.gid), { [`tests.${b.dataset.key}.released`]: false })),
    "test-select": () => { T.testSel = b.dataset.key; subscribeAttempts(); render(true); },
    "test-reset": () => guard(async () => {
      if (!confirm("Delete this student's attempt so that they can take the test again?")) return;
      const id = `${T.testSel}__${b.dataset.uid}`;
      await Promise.all([deleteDoc(doc(db, "testAttempts", id)), deleteDoc(doc(db, "testResults", id))]);
      toast("The student can start the test again.");
    }),
  };
  handlers[act]?.();
});

// Marking runs in the teacher's browser: only teachers are allowed to read the keys.
async function releaseUnit(gid, unitId) {
  await guard(async () => {
    const { content, keys } = await loadUnitData(unitId, true);
    if (!content) throw new Error("This unit has no content.");
    const subs = (await getDocs(query(collection(db, "submissions"), where("groupId", "==", gid), where("unitId", "==", unitId))))
      .docs.map((d) => d.data()).filter((s) => s.status === "submitted");
    const drafts = T.unitId === unitId ? T.subs.filter((s) => s.status === "draft").length : 0;
    if (!confirm(`Check the work and show the results to the students?\nSubmitted: ${subs.length}${drafts ? `\nNot submitted (drafts): ${drafts}. These will not be checked and can no longer be edited.` : ""}`)) return;
    const prev = Object.fromEntries((await getDocs(query(collection(db, "results"), where("groupId", "==", gid), where("unitId", "==", unitId))))
      .docs.map((d) => [d.data().uid, d.data()]));
    let batch = writeBatch(db), n = 0;
    for (const sub of subs) {
      const r = buildResult({ sub, content, keys, manual: prev[sub.uid]?.manual || {}, showCorrect: T.showCorrect });
      batch.set(doc(db, "results", subId(unitId, sub.uid)), { ...r, gradedAt: serverTimestamp() });
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    batch.update(doc(db, "groups", gid), { releasedUnits: arrayUnion(unitId) });
    await batch.commit();
    toast(`Done: ${subs.length} ${subs.length === 1 ? "piece of work" : "pieces of work"} checked. Students can see their results now.`);
  });
}

// ================================================================== Student work
function viewWorks() {
  const g = group(), u = unit();
  const head = pageHead("Teaching tools", "Student work",
    g && u ? `Unit ${unitNum(u)} · ${esc(u.title)} — group ${esc(g.name)}` : "");
  if (!g || !u) return head + `<div class="box">Choose a group and a unit at the top of the page.</div>`;
  const data = T.unitData[u.id];
  if (!data) return head + `<p class="muted">Loading…</p>`;
  if (!data.content) return head + `<div class="box">This unit has no content yet.</div>`;
  const subBy = Object.fromEntries(T.subs.map((s) => [s.uid, s]));
  const exs = exercisesOf(data.content);
  const totalItems = exs.reduce((n, ex) => n + (ex.items || []).length, 0);
  const openTotal = exs.filter((ex) => !isAuto(ex)).reduce((n, ex) => n + ex.items.length, 0);
  const rows = T.students.map((st) => {
    const s = subBy[st.uid], r = T.results[st.uid];
    const filled = s ? exs.reduce((n, ex) => n + (ex.items || []).filter((it) => String(s.answers?.[ex.id]?.[it.id] ?? "").trim()).length, 0) : 0;
    const auto = s ? gradeAuto(data.content, s.answers, data.keys) : null;
    const status = !s ? `<span class="pill off">not started</span>` : s.status === "submitted" ? `<span class="pill on">submitted</span>` : `<span class="pill warn">draft</span>`;
    const openDone = r ? openTotal - (r.manualPending ?? openTotal) : 0;
    return `<tr class="${T.selected === st.uid ? "sel" : ""}">
      <td><b>${esc(st.name)}</b><br><small class="muted">${esc(st.email)}</small></td>
      <td>${status}</td>
      <td>${s ? fmtTime(s.status === "submitted" ? s.submittedAt : s.updatedAt) : ""}</td>
      <td class="num">${filled} / ${totalItems}</td>
      <td class="num">${auto ? `${auto.score} / ${auto.max}` : ""}</td>
      <td class="num">${openTotal ? `${openDone} / ${openTotal}` : "—"}</td>
      <td class="num">${r ? `<b>${r.score} / ${r.max}</b>` : ""}</td>
      <td>${s ? `<button class="btn small" data-act="select-student" data-uid="${esc(st.uid)}">Open</button>` : ""}</td>
    </tr>`;
  }).join("");
  return head + `
    <p class="muted">The table updates live while students work. “Auto” is a preliminary score against the keys (students do not see it until you release the results). “Open” shows how many open answers you have already marked.</p>
    <table class="t"><tr><th>Student</th><th>Status</th><th>Last change</th><th>Answered</th><th>Auto</th><th>Open</th><th>Total</th><th></th></tr>
    ${rows || `<tr><td colspan="8" class="muted">There are no students in this group yet.</td></tr>`}</table>
    <div id="detail">${T.selected ? studentDetail(T.selected, data) : ""}</div>`;
}

function studentDetail(uid, data) {
  const st = T.students.find((s) => s.uid === uid);
  const sub = T.subs.find((s) => s.uid === uid);
  if (!st || !sub) return "";
  const r = T.results[uid];
  const auto = gradeAuto(data.content, sub.answers, data.keys);
  const u = unit(), n = unitNum(u);
  const body = data.content.sections.map((sec, i) => {
    const exs = (sec.blocks || []).filter((b) => b.type === "exercise");
    if (!exs.length) return "";
    return `<h3>${n}.${i + 1} ${esc(sec.title)}</h3>` + exs.map((ex, j) => renderExercise(ex, {
      num: `${n}.${i + 1}.${j + 1}`,
      answers: sub.answers?.[ex.id] || {},
      readOnly: true,
      auto: isAuto(ex) ? auto.items[ex.id] : undefined,
      manual: r?.manual?.[ex.id],
      grading: isManual(ex),
      itemExtra: T.exr?.[uid]?.feedback?.[ex.id] ? (itemId) => feedbackHTML(T.exr[uid].feedback[ex.id][itemId], { checkedAt: fmtTime(T.exr[uid].feedbackAt?.[ex.id]) }) : null,
    })).join("");
  }).join("");
  return `<div class="box">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${esc(st.name)} <span class="muted" style="font-size:16px">· auto-checked ${auto.score}/${auto.max}</span></h2>
      <div class="row">
        ${sub.status === "submitted" && !group()?.releasedUnits.includes(T.unitId) ? `<button class="btn small" data-act="return" data-uid="${esc(uid)}">Return for revision</button>` : ""}
        <button class="btn small primary" data-act="save-grades" data-uid="${esc(uid)}">Save marks</button>
      </div>
    </div>
    <p class="muted">Green — correct; red — mistake, with the correct answer next to it. For open answers, enter a score and a comment, then click “Save marks”. If the results are already released, the student sees the mark immediately.</p>
    ${body}
    <div class="row"><button class="btn primary" data-act="save-grades" data-uid="${esc(uid)}">Save marks</button></div>
  </div>`;
}

async function saveGrades(uid) {
  await guard(async () => {
    const data = await loadUnitData(T.unitId);
    const sub = T.subs.find((s) => s.uid === uid);
    const manual = structuredClone(T.results[uid]?.manual || {});
    document.querySelectorAll("#detail .g-score").forEach((inp) => {
      const ex = inp.dataset.ex, it = inp.dataset.item;
      const com = document.querySelector(`#detail .g-comment[data-ex="${CSS.escape(ex)}"][data-item="${CSS.escape(it)}"]`);
      manual[ex] ??= {};
      manual[ex][it] = { score: inp.value === "" ? null : Number(inp.value), comment: com?.value || "" };
    });
    const showCorrect = T.results[uid]?.showCorrect ?? T.showCorrect;
    const r = buildResult({ sub, content: data.content, keys: data.keys, manual, showCorrect });
    await setDoc(doc(db, "results", subId(T.unitId, uid)), { ...r, gradedAt: serverTimestamp() });
    document.activeElement?.blur();
    toast("Marks saved.");
    render(true);
  });
}

// ================================================================== Analytics
function viewStats() {
  const g = group(), u = unit();
  const head = pageHead("Teaching tools", "Analytics",
    g && u ? `Unit ${unitNum(u)} · ${esc(u.title)} — group ${esc(g.name)}` : "")
    + `<label class="row"><input type="checkbox" id="inc-drafts" ${T.includeDrafts ? "checked" : ""}> include drafts that have not been submitted</label>`;
  if (!g || !u) return head + `<div class="box">Choose a group and a unit at the top of the page.</div>`;
  const data = T.unitData[u.id];
  if (!data?.content) return head + `<p class="muted">No data.</p>`;
  const subs = T.subs.filter((s) => s.status === "submitted" || T.includeDrafts);
  const exs = exercisesOf(data.content);
  const nameOf = Object.fromEntries(T.students.map((s) => [s.uid, s.name]));
  if (!subs.length) return head + `<div class="box">No ${T.includeDrafts ? "work" : "submitted work"} yet.</div>`;

  // per question
  const items = [];
  for (const ex of exs) {
    if (!isAuto(ex)) continue;
    for (const it of ex.items) {
      const key = data.keys?.[ex.id]?.[it.id];
      let ok = 0; const wrong = {};
      for (const s of subs) {
        const given = s.answers?.[ex.id]?.[it.id] ?? "";
        if (norm(given) && (Array.isArray(key) ? key : [key]).some((k) => norm(k) === norm(given))) ok++;
        else { const w = norm(given) || "(blank)"; wrong[w] = (wrong[w] || 0) + 1; }
      }
      items.push({ ex, it, key, ok, n: subs.length, pct: Math.round((100 * ok) / subs.length), wrong: Object.entries(wrong).sort((a, b) => b[1] - a[1]) });
    }
  }
  // per student and exercise
  const perStudent = subs.map((s) => {
    const a = gradeAuto(data.content, s.answers, data.keys);
    const byEx = {};
    for (const ex of exs) if (isAuto(ex)) {
      const v = Object.values(a.items[ex.id] || {});
      byEx[ex.id] = v.length ? Math.round((100 * v.filter((x) => x.ok).length) / v.length) : null;
    }
    return { s, a, byEx, pct: a.max ? Math.round((100 * a.score) / a.max) : 0 };
  }).sort((x, y) => x.pct - y.pct);
  const avg = Math.round(perStudent.reduce((n, p) => n + p.pct, 0) / perStudent.length);
  const autoEx = exs.filter(isAuto);
  const openItems = exs.filter((ex) => !isAuto(ex)).reduce((n, ex) => n + ex.items.length, 0);
  const graded = Object.values(T.results).reduce((n, r) => n + (openItems - (r.manualPending ?? openItems)), 0);

  const wrongHTML = (w) => w.slice(0, 3).map(([ans, c]) => `“${esc(ans)}” ×${c}`).join(", ");
  const itemRow = (x) => `<tr>
      <td>${esc(x.ex.title)}<br><small class="muted">${esc(KIND_LABEL[x.ex.kind])}</small></td>
      <td>${esc(x.it.id)}. ${x.it.text.replace("___", "_____").replace(/<[^>]*>/g, "").slice(0, 90)}</td>
      <td><span class="keyhint" style="margin:0">${esc(keyText(x.key))}</span></td>
      <td class="num">${x.pct}%<div class="bar"><i style="width:${x.pct}%;background:${heat(x.pct)}"></i></div></td>
      <td class="wrong-list">${wrongHTML(x.wrong)}</td></tr>`;
  const hardest = [...items].sort((a, b) => a.pct - b.pct).slice(0, 10);

  return head + `
    <div class="cards">
      <div class="card"><b>${subs.length} / ${T.students.length}</b><span>pieces of work / students</span></div>
      <div class="card"><b>${avg}%</b><span>average auto-checked score</span></div>
      <div class="card"><b>${hardest[0] ? hardest[0].pct + "%" : "—"}</b><span>most difficult question</span></div>
      ${openItems ? `<div class="card"><b>${graded} / ${openItems * subs.length}</b><span>open answers marked</span></div>` : ""}
    </div>
    <h3>Questions students found most difficult</h3>
    <table class="t"><tr><th>Exercise</th><th>Question</th><th>Key</th><th>Correct</th><th>Most common mistakes</th></tr>${hardest.map(itemRow).join("")}</table>

    <h3>Results by student and exercise</h3>
    <div style="overflow-x:auto"><table class="t"><tr><th>Student</th><th>Total</th>${autoEx.map((ex) => `<th title="${esc(ex.title)}">${esc(ex.title.slice(0, 22))}</th>`).join("")}<th></th></tr>
    ${perStudent.map((p) => `<tr><td>${esc(nameOf[p.s.uid] || p.s.uid)}${p.s.status !== "submitted" ? ` <span class="pill warn">draft</span>` : ""}</td>
      <td class="num"><b>${p.a.score}/${p.a.max}</b> (${p.pct}%)</td>
      ${autoEx.map((ex) => `<td class="heat" style="background:${heat(p.byEx[ex.id], true)}">${p.byEx[ex.id] ?? "—"}%</td>`).join("")}
      <td><button class="btn small" data-act="select-student" data-uid="${esc(p.s.uid)}">Answers</button></td></tr>`).join("")}
    </table></div>

    <details><summary>All questions in order (${items.length})</summary>
    <table class="t"><tr><th>Exercise</th><th>Question</th><th>Key</th><th>Correct</th><th>Wrong answers</th></tr>${items.map(itemRow).join("")}</table></details>`;
}
function heat(p, light) {
  if (p === null || p === undefined) return "transparent";
  const c = p >= 80 ? [29, 107, 69] : p >= 50 ? [192, 138, 46] : [162, 58, 42];
  return light ? `rgba(${c.join(",")},.15)` : `rgb(${c.join(",")})`;
}

// ================================================================== Course content
function viewContent() {
  const rows = T.units.map((u) => `<tr>
    <td class="num">${esc(u.order)}</td><td><code>${esc(u.id)}</code></td><td>${u.status === "soon" ? esc(u.title) : `<a href="#${esc(u.id)}">${esc(u.title)}</a>`}</td>
    <td>${u.status === "soon" ? `<span class="pill off">coming soon</span>` : `<span class="pill on">${(u.sections || []).length} sections</span>`}</td>
    <td><button class="btn small danger" data-act="delete-unit" data-unit="${esc(u.id)}">Delete</button></td></tr>`).join("");
  return pageHead("Teaching tools", "Course content", "Units are imported from a JSON file that you keep on your computer.") + `
  <div class="box">
    <h3 style="margin-top:0">Import units from JSON</h3>
    <p class="muted">Keep the course file on your computer, not in the public repository. On import, the <code>answer</code> fields are removed from the exercises and stored separately as keys, and <code>teacher-note</code> blocks become teaching notes. Students receive neither.
    Importing a unit with an existing <code>id</code> replaces it; students' answers are kept.</p>
    <div class="row"><input type="file" id="import-file" accept=".json,application/json"></div>
    <textarea class="json" id="import-text" placeholder='{"units":[{"id":"u1","order":1,"title":"…","sections":[…]}]}'></textarea>
    <div class="row"><button class="btn primary" data-act="import">Import</button></div>
  </div>
  <table class="t"><tr><th>#</th><th>id</th><th>Unit</th><th>Status</th><th></th></tr>${rows || `<tr><td colspan="5" class="muted">The course is empty. Import a JSON file.</td></tr>`}</table>`;
}

// Strip the answers out of one exercise: returns the exercise for students and its keys
function stripExercise(b, seen, where) {
  if (!b.id || seen.has(b.id)) throw new Error(`Missing or repeated exercise id “${b.id}” (${where})`);
  seen.add(b.id);
  if (!KIND_LABEL[b.kind]) throw new Error(`Exercise ${b.id}: unknown kind “${b.kind}” (gap | match | mcq | open)`);
  const keys = {};
  const items = (b.items || []).map((it) => {
    const { answer, ...rest } = it;
    if (it.id === undefined) throw new Error(`Exercise ${b.id}: an item has no id`);
    rest.id = String(it.id);
    if (b.kind !== "open" && b.graded !== false) {
      if (answer === undefined || answer === "") throw new Error(`Exercise ${b.id}, item ${it.id}: no answer`);
      keys[rest.id] = answer;
    }
    return rest;
  });
  return { ex: { ...b, type: "exercise", items }, keys };
}

function splitUnit(u) {
  if (!u.id || !/^[A-Za-z0-9_-]+$/.test(u.id)) throw new Error(`Invalid unit id “${u.id}” (use Latin letters, digits, - and _)`);
  if (!u.title) throw new Error(`Unit ${u.id} has no title`);
  const hasContent = Array.isArray(u.sections) && u.sections.some((s) => (s.blocks || []).length);
  const meta = {
    title: u.title, order: Number(u.order ?? 0),
    status: u.status || (hasContent ? "ready" : "soon"),
    sections: (u.sections || []).map((s) => ({ id: s.id, title: s.title, ...(s.subtitle ? { subtitle: s.subtitle } : {}) })),
  };
  // timed tests: hidden from students until the teacher opens them
  const tests = {}, testKeys = {};
  for (const t of u.tests || []) {
    if (!t.id || !/^[A-Za-z0-9_-]+$/.test(t.id) || tests[t.id]) throw new Error(`Unit ${u.id}: test with a missing or repeated id “${t.id}”`);
    if (!(Number(t.minutes) > 0)) throw new Error(`Test ${t.id}: set "minutes" (the time limit)`);
    const seenT = new Set(), keysT = {};
    const exercises = (t.exercises || []).map((b) => { const r = stripExercise(b, seenT, `${u.id}, test ${t.id}`); keysT[b.id] = r.keys; return r.ex; });
    tests[t.id] = { unitId: u.id, testId: t.id, title: t.title || "Test", minutes: Number(t.minutes), rubric: t.rubric || "", exercises };
    testKeys[t.id] = { title: t.title || "Test", minutes: Number(t.minutes), keys: keysT };
  }
  if (!hasContent) return { meta, tests, keys: Object.keys(tests).length ? { exercises: {}, notes: {}, tests: testKeys } : null };
  const keys = {}, notes = {}, seen = new Set();
  const sections = u.sections.map((s) => {
    if (!s.id || !s.title) throw new Error(`A section in unit ${u.id} has no id or title`);
    const blocks = [];
    for (const b of s.blocks || []) {
      if (b.type === "teacher-note") { (notes[s.id] ??= []).push({ at: blocks.length, html: b.html }); continue; }
      if (b.type !== "exercise") { blocks.push(b); continue; }
      const r = stripExercise(b, seen, u.id);
      keys[b.id] = r.keys;
      blocks.push(r.ex);
    }
    return { id: s.id, title: s.title, ...(s.subtitle ? { subtitle: s.subtitle } : {}), blocks };
  });
  return { meta, content: { sections }, tests, keys: { exercises: keys, notes, tests: testKeys } };
}

async function importCourse() {
  await guard(async () => {
    const raw = $("#import-text").value.trim();
    if (!raw) throw new Error("Paste JSON or choose a file.");
    let json;
    try { json = JSON.parse(raw); } catch (e) { throw new Error("The JSON has an error: " + e.message); }
    const list = json.units || [json];
    const parts = list.map(splitUnit);          // validate everything first
    const batch = writeBatch(db);
    parts.forEach((p, i) => {
      const id = list[i].id;
      batch.set(doc(db, "units", id), p.meta);
      if (p.content) batch.set(doc(db, "unitContent", id), p.content);
      if (p.keys) batch.set(doc(db, "answerKeys", id), p.keys);
      for (const [tid, t] of Object.entries(p.tests || {})) batch.set(doc(db, "testContent", `${id}--${tid}`), t);
    });
    await batch.commit();
    for (const l of list) delete T.unitData[l.id];
    T.testsLoaded = false;
    $("#import-text").value = "";
    toast(`Units imported: ${parts.length}`);
    ctxKey = ""; subscribeCtx(); render(true);
  });
}

async function deleteUnit(u) {
  if (!confirm(`Delete unit “${u}” together with its keys? Students' answers stay in the database.`)) return;
  await guard(async () => {
    await Promise.all(["units", "unitContent", "answerKeys"].map((c) => deleteDoc(doc(db, c, u))));
    toast("Unit deleted.");
  });
}

// ================================================================== Groups & students
function viewGroups() {
  if (!T.usersLoaded) setTimeout(loadAllUsers, 0);
  const counts = {};
  T.users.forEach((u) => (counts[u.groupId] = (counts[u.groupId] || 0) + 1));
  const filter = T.groupFilter ?? T.gid;
  const list = T.users.filter((u) => !filter || u.groupId === filter).sort((a, b) => a.name.localeCompare(b.name));
  return pageHead("Teaching tools", "Groups &amp; students", "Students enter the group code when they create an account.") + `
  <div class="box"><div class="row">
    <input id="g-name" placeholder="Group name, e.g. PA-21">
    <input id="g-code" placeholder="Code (optional)" style="width:12em">
    <button class="btn primary" data-act="create-group">Create group</button>
  </div><p class="muted" style="margin:8px 0 0">If you leave the code empty, one will be generated.</p></div>
  <table class="t"><tr><th>Code</th><th>Group</th><th>Students</th><th>Open units</th></tr>
  ${T.groups.map((g) => `<tr><td><code>${esc(g.id)}</code></td><td>${esc(g.name)}</td><td class="num">${T.usersLoaded ? counts[g.id] || 0 : "…"}</td><td>${g.openUnits.map((id) => { const u = T.units.find((x) => x.id === id); return u ? unitNum(u) : esc(id); }).join(", ") || "—"}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">No groups yet.</td></tr>`}</table>

  <h3>Students</h3>
  <div class="row">Show: <select id="g-filter"><option value="">all groups</option>${T.groups.map((g) => `<option value="${esc(g.id)}" ${filter === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
  <button class="btn small" data-act="load-users">Refresh</button></div>
  <table class="t"><tr><th>Name</th><th>Email</th><th>Group</th></tr>
  ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-move="${esc(u.uid)}">${T.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === u.groupId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">${T.usersLoaded ? "No students" : "Loading…"}</td></tr>`}</table>`;
}

let loadingUsers = false;
async function loadAllUsers() {
  if (!T.user || loadingUsers) return;
  loadingUsers = true;
  await guard(async () => {
    const snap = await getDocs(collection(db, "users"));
    T.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    T.usersLoaded = true;
  });
  loadingUsers = false;
  T.usersLoaded = true;
  render(true);
}

async function createGroup() {
  await guard(async () => {
    const name = $("#g-name").value.trim();
    let code = $("#g-code").value.trim().toUpperCase();
    if (!name) throw new Error("Please enter a group name.");
    if (!code) {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      code = "G-" + Array.from(crypto.getRandomValues(new Uint8Array(5)), (x) => abc[x % abc.length]).join("");
    }
    if (!/^[A-Z0-9-]{3,24}$/.test(code)) throw new Error("The code must be 3–24 characters: Latin letters, digits and hyphens.");
    if ((await getDoc(doc(db, "groups", code))).exists()) throw new Error("A group with this code already exists.");
    await setDoc(doc(db, "groups", code), { name, openUnits: [], releasedUnits: [], createdAt: serverTimestamp() });
    $("#g-name").value = ""; $("#g-code").value = "";
    document.activeElement?.blur();
    toast(`Group created. Code for students: ${code}`, 8000);
    loadAllUsers();
  });
}

// ================================================================== Timed tests
// Tests are described in course.json (unit.tests) and stored apart from the book:
// testContent/{unitId--testId} — questions; answerKeys/{unitId}.tests — keys.
async function loadTests() {
  if (T.testsLoading) return;
  T.testsLoading = true;
  const list = [];
  for (const u of T.units) {
    const k = await getDoc(doc(db, "answerKeys", u.id)).catch(() => null);
    for (const [tid, t] of Object.entries(k?.exists() ? k.data().tests || {} : {})) {
      list.push({ key: `${u.id}--${tid}`, unitId: u.id, testId: tid, title: t.title, minutes: t.minutes, keys: t.keys || {} });
    }
  }
  T.tests = list; T.testsLoaded = true; T.testsLoading = false;
  render(true);
}

let attUnsub = null, attKey = "";
function subscribeAttempts() {
  const key = `${T.gid}|${T.testSel}`;
  if (key === attKey) return;
  attKey = key; attUnsub?.(); T.attempts = []; T.testRes = {};
  if (!T.gid || !T.testSel) return;
  const u1 = onSnapshot(query(collection(db, "testAttempts"), where("groupId", "==", T.gid), where("testKey", "==", T.testSel)),
    (snap) => { T.attempts = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" })); render(); });
  const u2 = onSnapshot(query(collection(db, "testResults"), where("groupId", "==", T.gid), where("testKey", "==", T.testSel)),
    (snap) => { T.testRes = Object.fromEntries(snap.docs.map((d) => [d.data().uid, d.data()])); render(); });
  attUnsub = () => { u1(); u2(); };
  if (!T.testContent?.[T.testSel]) getDoc(doc(db, "testContent", T.testSel)).then((d) => { (T.testContent ??= {})[T.testSel] = d.data(); render(); });
}
setInterval(() => { if (route().tool === "tests" && T.testSel) render(); }, 5000);

function viewTests() {
  const g = group();
  const head = pageHead("Teaching tools", "Tests", "Timed tests stay hidden from students until you open them for a group.");
  if (!g) return head + `<div class="box">First create a group in <a href="#tools/groups">Groups &amp; students</a>.</div>`;
  if (!T.testsLoaded) { loadTests(); return head + `<p class="muted">Loading…</p>`; }
  if (!T.tests.length) return head + `<div class="box">There are no tests in the course yet. Tests are added to a unit in the course file (<code>"tests"</code>) and imported in <a href="#tools/content">Course content</a>.</div>`;
  if (T.testSel) subscribeAttempts();
  const rows = T.tests.map((t) => {
    const cfg = g.tests?.[t.key];
    const u = T.units.find((x) => x.id === t.unitId);
    const status = cfg?.released ? `<span class="pill on">results shown</span>`
      : cfg?.open ? `<span class="pill warn">open now</span>`
      : cfg ? `<span class="pill off">closed</span>` : `<span class="pill off">hidden</span>`;
    return `<tr class="${T.testSel === t.key ? "sel" : ""}">
      <td><b>${esc(t.title)}</b><br><small class="muted">Unit ${u ? unitNum(u) : esc(t.unitId)}</small></td>
      <td class="num">${t.minutes} min</td>
      <td>${status}</td>
      <td class="row">
        ${cfg?.open ? `<button class="btn small" data-act="test-close" data-key="${esc(t.key)}">Close</button>`
                    : `<button class="btn small good" data-act="test-open" data-key="${esc(t.key)}">${cfg ? "Open again" : "Open for the group"}</button>`}
        ${cfg?.released ? `<button class="btn small danger" data-act="test-unrelease" data-key="${esc(t.key)}">Hide results</button>`
                        : cfg ? `<button class="btn small" data-act="test-release" data-key="${esc(t.key)}">Check &amp; show results</button>` : ""}
        <button class="btn small" data-act="test-select" data-key="${esc(t.key)}">Details</button>
      </td></tr>`;
  }).join("");
  return head + `<table class="t"><tr><th>Test</th><th>Time</th><th>Group ${esc(g.name)}</th><th></th></tr>${rows}</table>
    ${T.testSel ? testDetail(g) : ""}`;
}

function testDetail(g) {
  const t = T.tests.find((x) => x.key === T.testSel);
  const c = T.testContent?.[T.testSel];
  if (!t) return "";
  const byUid = Object.fromEntries((T.attempts || []).map((a) => [a.uid, a]));
  const now = Date.now();
  const rows = T.students.map((st) => {
    const a = byUid[st.uid], r = T.testRes?.[st.uid];
    let status = `<span class="pill off">not started</span>`, time = "";
    if (a) {
      const start = a.startedAt?.toMillis?.() || now, end = start + t.minutes * 60000;
      if (a.status === "submitted") { status = `<span class="pill on">submitted</span>`; time = fmtTime(a.updatedAt); }
      else if (now < end && g.tests?.[t.key]?.open) { status = `<span class="pill warn">in progress</span>`; time = `${Math.ceil((end - now) / 60000)} min left`; }
      else { status = `<span class="pill on">time over</span>`; time = fmtTime(a.updatedAt); }
    }
    let prelim = "";
    if (a && c) {
      let sc = 0, mx = 0;
      for (const ex of c.exercises || []) { const gr = gradeExercise(ex, a.answers?.[ex.id], t.keys[ex.id]); if (isAuto(ex)) { sc += gr.score; mx += gr.max; } }
      prelim = `${sc} / ${mx}`;
    }
    const answered = a ? Object.values(a.answers || {}).reduce((n, ex) => n + Object.values(ex).filter((v) => String(v).trim()).length, 0) : 0;
    return `<tr><td><b>${esc(st.name)}</b></td><td>${status}</td><td>${a ? fmtTime(a.startedAt) : ""}</td><td>${time}</td>
      <td class="num">${a ? answered : ""}</td><td class="num">${prelim}</td><td class="num">${r ? `<b>${r.score} / ${r.max}</b>` : ""}</td>
      <td>${a ? `<button class="btn small" data-act="test-reset" data-uid="${esc(st.uid)}">Allow a new attempt</button>` : ""}</td></tr>`;
  }).join("");
  const preview = c ? renderBlocks(c.exercises || [], (ex) => ({ key: t.keys[ex.id] || {}, readOnly: true })) : `<p class="muted">Loading…</p>`;
  return `<div class="box"><h2 style="margin-top:0">${esc(t.title)} <span class="muted" style="font-size:16px">· ${t.minutes} minutes · group ${esc(g.name)}</span></h2>
    <p class="muted">The table updates live. “Score” is preliminary; students see it only after “Check &amp; show results”.</p>
    <table class="t"><tr><th>Student</th><th>Status</th><th>Started</th><th>Time</th><th>Answered</th><th>Score</th><th>Released</th><th></th></tr>
    ${rows || `<tr><td colspan="8" class="muted">There are no students in this group yet.</td></tr>`}</table>
    <details><summary>Questions with keys</summary>${preview}</details></div>`;
}

async function openTest(key) {
  const t = T.tests.find((x) => x.key === key);
  await guard(async () => {
    if (!confirm(`Open “${t.title}” for the group now?\nEach student has ${t.minutes} minutes from the moment they click “Start the test”.`)) return;
    await updateDoc(doc(db, "groups", T.gid), {
      [`tests.${key}`]: { open: true, released: false, minutes: t.minutes, title: t.title, unitId: t.unitId, openedAt: serverTimestamp() },
    });
    T.testSel = key; subscribeAttempts();
    toast("The test is open. Students can see it in their sidebar.");
  });
}

async function releaseTest(key) {
  const t = T.tests.find((x) => x.key === key);
  await guard(async () => {
    const c = (await getDoc(doc(db, "testContent", key))).data();
    const atts = (await getDocs(query(collection(db, "testAttempts"), where("groupId", "==", T.gid), where("testKey", "==", key)))).docs.map((d) => d.data());
    if (!confirm(`Check the test and show the results?\nAttempts: ${atts.length}. The test will be closed for the group.`)) return;
    let batch = writeBatch(db), n = 0;
    for (const a of atts) {
      const items = {}; let score = 0, max = 0;
      for (const ex of c.exercises || []) {
        if (!isAuto(ex)) continue;
        const gr = gradeExercise(ex, a.answers?.[ex.id], t.keys[ex.id]);
        if (!T.showCorrect) for (const it of Object.values(gr.items)) delete it.correct;
        items[ex.id] = gr.items; score += gr.score; max += gr.max;
      }
      batch.set(doc(db, "testResults", `${key}__${a.uid}`), { uid: a.uid, groupId: T.gid, testKey: key, items, score, max, gradedAt: serverTimestamp() });
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    batch.update(doc(db, "groups", T.gid), { [`tests.${key}.open`]: false, [`tests.${key}.released`]: true });
    await batch.commit();
    toast(`Checked: ${atts.length}. Students can see their results now.`);
  });
}
