// Teacher's Edition: unit preview with keys, unit access per group, releasing results,
// manual assessment of open answers, analytics, content import, groups and students.
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, orderBy,
  writeBatch, arrayUnion, arrayRemove, serverTimestamp, deleteField,
} from "./fb.js?v=20261106b";
import { COURSE_TITLE } from "./firebase-config.js?v=20261106b";
import {
  esc, renderBlocks, renderExercise, exercisesOf, isAuto, gradeAuto, buildResult, keyText, norm,
  fmtTime, friendlyError, authFormHTML, wireAuthForm, subId, KIND_LABEL, isTeacherChecked, gradeExercise, wireFlashcards, isManual,
  isCorrect, readInput, doneMap, isTranslation, exerciseNumbers, fmtDate, todayISO, answerLabel, r2,
} from "./common.js?v=20261106b";
import { initShell, renderUnitNav, wireUnitNav } from "./shell.js?v=20261106b";
import { loadVocab, grammarCheck, vocabProfile, unitVocabulary, feedbackHTML, sleep } from "./writing.js?v=20261106b";
import "./speaking.js?v=20261106b";
import { isWritingTask, measure, METRICS, toCSV } from "./progress.js?v=20261106b";

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
  practice: {},          // unitId -> {exId: {itemId: value}}: what the teacher types in the unit (kept in this tab only)
  mistOpen: new Set(),   // exercises whose list of students' mistakes is open
  prog: null,            // Speaking and Writing progress: {gid, loading, tasks, rows, at, error}
  progOpt: { metric: { speaking: ls.get("progM:speaking", "wpm"), writing: ls.get("progM:writing", "words") }, student: "", setting: ls.get("progSet", ""), open: null },
  viewAs: "",            // unit page: "" = the teacher's own practice answers, or a student uid whose answers are shown
  statsOnlySubmitted: false,
  journal: undefined,    // attendance of the current group: {lessons: {"2026-10-21": {absent: [uid]}}}
  unitViewKey: "",
};
// An absent student gets this share of the points for the in-class exercises of that lesson
const ABSENT_FACTOR = 0.25;

const TOOLS = [
  { id: "access", icon: "🔓", title: "Access & results", sub: "Open units, release results" },
  { id: "works", icon: "📝", title: "Student work", sub: "Answers, open-answer marking" },
  { id: "tests", icon: "⏱", title: "Tests", sub: "Timed tests: open, watch, check" },
  { id: "stats", icon: "📊", title: "Analytics", sub: "Difficult questions, heat map" },
  { id: "journal", icon: "📅", title: "Attendance", sub: "Lesson dates, present and absent" },
  { id: "speaking", icon: "🎙", title: "Speaking progress", sub: "Recordings as text: figures, trends, texts" },
  { id: "writing", icon: "✍", title: "Writing progress", sub: "Letters and essays: figures, trends, texts" },
  { id: "groups", icon: "👥", title: "Groups & students", sub: "Group codes, moving and removing students" },
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
  try { T.lastError = ""; return await fn(); } catch (e) { console.error(e); T.lastError = friendlyError(e); toast("Error: " + T.lastError, 6000); }
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
$("#ctx-group").addEventListener("change", (e) => { T.gid = e.target.value; ls.set("gid", T.gid); T.selected = null; T.viewAs = ""; T.progOpt.student = ""; subscribeCtx(); render(); });
document.addEventListener("change", (e) => {
  if (e.target.id === "view-as") setViewAs(e.target.value);
  if (e.target.id === "works-student") { T.selected = e.target.value; render(true); setTimeout(() => $("#detail")?.scrollIntoView({ behavior: "smooth" }), 50); }
});
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
  // attendance journal: kept in a teacher-only document (answerKeys/journal~<group>), students never receive it
  T.journal = undefined;
  T.ctxUnsub.push(onSnapshot(journalRef(T.gid), (snap) => {
    T.journal = snap.exists() ? snap.data() : { lessons: {} };
    T.journal.lessons ??= {};
    render();
  }, () => { T.journal = { lessons: {}, error: true }; render(); }));
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
  const r = route();
  // A unit page that is already on the screen is not drawn again when students type:
  // only the live statistics are refreshed. The teacher's own answers, an audio file that is playing,
  // a flashcard or a recorder stay as they are.
  if (!force && r.unit && r.unit === T.unitId && T.unitViewKey && T.unitViewKey === unitViewKey(r)) { patchUnitStats(); return; }
  // do not re-render while the teacher is typing a mark, comment or JSON
  const a = document.activeElement;
  if (!force && a && $("#view").contains(a) && a.matches(".g-score,.g-comment,textarea.json,input[type=text],input:not([type]),[data-item],input[type=date]")) return;
  if (r.unit && r.unit !== T.unitId && T.units.some((u) => u.id === r.unit)) { setUnit(r.unit); return; }
  $("#wrap").classList.toggle("wide", !!r.tool && r.tool !== "content");
  T.unitViewKey = "";
  if (r.unit) { $("#view").innerHTML = viewUnit(r); T.unitViewKey = unitViewKey(r); return; }
  const tool = TOOLS.find((t) => t.id === r.tool);
  $("#crumb").innerHTML = `<b>Teaching tools</b> &middot; ${tool.title}`;
  const views = { access: viewAccess, works: viewWorks, tests: viewTests, stats: viewStats, content: viewContent, groups: viewGroups, journal: viewJournal, speaking: () => viewProgress("speaking"), writing: () => viewProgress("writing") };
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
  const mine = T.practice[u.id] || {};
  // "Answers shown": the teacher's own practice answers, or one student's work in this unit
  if (T.viewAs && !T.students.some((s) => s.uid === T.viewAs)) T.viewAs = "";
  const vs = T.viewAs ? T.subs.find((s) => s.uid === T.viewAs) : null;
  const vexr = T.viewAs ? T.exr?.[T.viewAs] : null;
  const vres = T.viewAs ? T.results[T.viewAs] : null;
  const tip = T.viewAs
    ? `<p class="muted tip">You see the answers of <b>${esc(T.students.find((s) => s.uid === T.viewAs)?.name || "")}</b>${vs ? ` (${vs.status === "submitted" ? "submitted" : "draft"}, last change ${esc(fmtTime(vs.updatedAt))})` : ""}: green – correct, red – a mistake with the key next to it. The page follows the student's changes live. Marks for open answers are given in <a href="#tools/works" data-act="select-student" data-uid="${esc(T.viewAs)}">Student work</a>.</p>`
    : `<p class="muted tip">You can type and choose answers here, as the students do: nothing is saved or sent to the students.
       Under each exercise title you can mark it <b>In-Class</b> or <b>HA</b> and tick <b>Done</b>. The figures on the right update live while the students work (drafts included).
       ${Object.keys(mine).length ? `<button class="btn small" data-act="practice-clear" data-unit="${esc(u.id)}">Clear my answers</button>` : ""}</p>`;
  return bar + docxBar(u) + viewAsBar() + pageHead(`Unit ${n} &middot; ${n}.${i + 1}`, esc(sec.title), esc(meta.subtitle || sec.subtitle || ""))
    + tip
    + (T.viewAs && !vs ? `<div class="box">This student has not started the unit yet.</div>` : "")
    + renderBlocks(blocks, (ex) => {
      const st = exStats(ex);
      if (T.viewAs) {
        const ans = vs?.answers?.[ex.id] || {};
        const fbx = vexr?.feedback?.[ex.id];
        const done = vs && doneMap(vs.answers)[ex.id];
        const graded = vs && isAuto(ex) && Object.values(ans).some((v) => String(v).trim());
        return {
          key: graded ? null : d.keys[ex.id] || {}, readOnly: true, answers: ans,
          speech: vs?.answers?._speech?.[ex.id],
          auto: graded ? gradeExercise(ex, ans, d.keys[ex.id] || {}).items : undefined,
          manual: vres?.manual?.[ex.id],
          tag: done ? "Done ✓" : vs && Object.values(ans).some((v) => String(v).trim()) ? "Started, not marked Done" : "",
          before: g ? toolsBar(u, ex, g, st) : "",
          itemExtra: fbx ? (itemId) => feedbackHTML(fbx[itemId], { checkedAt: fmtTime(vexr.feedbackAt?.[ex.id]) }) : null,
        };
      }
      return {
        key: d.keys[ex.id] || {}, readOnly: false,
        answers: mine[ex.id] || {},
        tag: ex.check === "teacher" ? (isManual(ex) ? "Writing check by the teacher" : "Checked by the teacher") : "",
        before: g ? toolsBar(u, ex, g, st) : "",
        itemStat: st.items ? (itemId) => `<span class="istat" data-is="${esc(ex.id)}|${esc(itemId)}">${itemBadge(ex, st.items[itemId])}</span>` : null,
        after: st.items ? `<div class="mist" data-mi="${esc(ex.id)}" ${T.mistOpen.has(ex.id) ? "" : "hidden"}>${mistakesHTML(ex, st)}</div>` : "",
      };
    }, `${n}.${i + 1}`)
    + `<nav class="pager">
      ${prev ? `<a class="pg" href="#${u.id}/${prev.id}"><span class="d">Previous</span><span class="t">${n}.${i} ${esc(prev.title)}</span></a>` : ""}
      ${next ? `<a class="pg next" href="#${u.id}/${next.id}"><span class="d">Next</span><span class="t">${n}.${i + 2} ${esc(next.title)}</span></a>` : ""}
    </nav>`;
}

// The list above a unit page: whose answers are shown. Students are in alphabetical order; the arrows go to the
// previous and next student, so the teacher can look through the whole group exercise by exercise.
function viewAsBar() {
  if (!group() || !T.students.length) return "";
  const subBy = Object.fromEntries(T.subs.map((s) => [s.uid, s]));
  const i = T.students.findIndex((s) => s.uid === T.viewAs);
  const prev = i > 0 ? T.students[i - 1] : null, next = i < T.students.length - 1 ? T.students[i + 1] : null;
  const label = (s) => { const x = subBy[s.uid]; return `${s.name}${!x ? " · not started" : x.status === "submitted" ? " · submitted" : ""}`; };
  return `<div class="viewas-bar ${T.viewAs ? "on" : ""}"><label for="view-as">Answers shown</label>
    <button class="btn small" data-act="view-as" data-uid="${esc(prev?.uid || "")}" ${i < 0 || !prev ? "disabled" : ""} title="Previous student">Previous</button>
    <select id="view-as"><option value="">My practice (nothing is saved)</option>${T.students.map((s) => `<option value="${esc(s.uid)}" ${s.uid === T.viewAs ? "selected" : ""}>${esc(label(s))}</option>`).join("")}</select>
    <button class="btn small" data-act="view-as" data-uid="${esc((i < 0 ? T.students[0] : next)?.uid || "")}" ${i >= 0 && !next ? "disabled" : ""} title="Next student">Next</button>
    ${T.viewAs ? `<button class="btn small" data-act="view-as" data-uid="">Back to my practice</button>` : ""}</div>`;
}
function viewAsStamp() {
  const s = T.subs.find((x) => x.uid === T.viewAs), e = T.exr?.[T.viewAs], r = T.results[T.viewAs];
  const ms = (t) => t?.toMillis?.() || 0;
  return [ms(s?.updatedAt), s?.status || "", Object.values(e?.feedbackAt || {}).reduce((n, t) => n + ms(t), 0), ms(r?.gradedAt)].join("|");
}
function setViewAs(uid) {
  T.viewAs = uid || "";
  const y = window.scrollY;
  render(true);
  window.scrollTo(0, y);
}

// Download the whole unit as a Word file (no interactive elements): Student's Book or Teacher's Book with keys
function docxBar(u) {
  return `<div class="dl-bar"><span>Download Unit ${esc(unitNum(u))} as Word:</span>
    <button class="btn small" data-act="docx" data-unit="${esc(u.id)}" data-ver="student">Student's Book (.docx)</button>
    <button class="btn small" data-act="docx" data-unit="${esc(u.id)}" data-ver="teacher">Teacher's Book (.docx)</button></div>`;
}
async function downloadDocx(unitId, ver, btn) {
  const u = T.units.find((x) => x.id === unitId);
  if (!u) return;
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  try {
    const d = await loadUnitData(unitId);
    if (!d?.content) throw new Error("This unit has no content yet.");
    const { exportUnitDocx, saveBlob } = await import("./export-docx.js?v=20261106b");
    const teacher = ver === "teacher";
    const sections = d.content.sections.map((s) => ({ ...s, subtitle: (u.sections || []).find((m) => m.id === s.id)?.subtitle || s.subtitle || "" }));
    const blob = await exportUnitDocx({ courseTitle: COURSE_TITLE, unitNum: unitNum(u), unitTitle: u.title, sections,
      keys: teacher ? d.keys : {}, notes: teacher ? d.notes : {}, teacher });
    const safe = (t) => String(t).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    saveBlob(blob, `${safe(COURSE_TITLE)}_Unit-${unitNum(u)}_${teacher ? "Teachers-Book" : "Students-Book"}.docx`);
  } catch (e) { console.error(e); toast("Could not create the Word file: " + (e.message || e), 6000); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

// Exercises marked "check": "teacher" are checked one at a time, when the teacher decides
function exerciseBar(u, ex, g) {
  const done = (g.releasedEx?.[u.id] || []).includes(ex.id);
  return `<div class="tb-row"><span>Group <b>${esc(g.name)}</b>: <span class="pill ${done ? "on" : "off"}">${done ? "checked · results shown" : "not checked yet"}</span></span>
    <span class="sp" style="flex:1"></span>
    ${done
      ? `<button class="btn small" data-act="check-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" title="Check again, e.g. for students who answered later">Re-check</button>
         <button class="btn small danger" data-act="uncheck-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}">Hide results</button>`
      : `<button class="btn small good" data-act="check-ex" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" ${g.openUnits.includes(u.id) ? "" : "disabled title=\"Open the unit for the group first\""}>Check this exercise now</button>`}
  </div>`;
}

// ================================================================== In-Class / HA, Done, live statistics
// The bar above each exercise in the Teacher's Edition.
function toolsBar(u, ex, g, st) {
  const p = g.plan?.[u.id]?.[ex.id] || {};
  const k = `${u.id}|${ex.id}`;
  const row = `<div class="tb-row">
    <span class="seg" role="group" aria-label="Type of work">
      <button type="button" class="${p.as === "class" ? "on" : ""}" data-act="plan-as" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" data-as="class" title="Work done in class">In-Class</button><button type="button" class="${p.as === "home" ? "on" : ""}" data-act="plan-as" data-unit="${esc(u.id)}" data-ex="${esc(ex.id)}" data-as="home" title="Home assignment">HA</button>
    </span>
    <label class="tb-done ${p.done ? "on" : ""}"><input type="checkbox" data-plan-done="${esc(k)}" ${p.done ? "checked" : ""}> Done</label>
    ${p.done ? `<input type="date" class="tb-date" data-plan-date="${esc(k)}" value="${esc(p.date || "")}" title="The lesson when it was done">` : ""}
    <span class="sp" style="flex:1"></span>
    <span class="tstat" data-ts="${esc(ex.id)}">${statSummary(ex, st)}</span>
    ${st.items ? `<button class="btn small" type="button" data-act="mist" data-ex="${esc(ex.id)}">Mistakes</button>` : ""}
  </div>`;
  const check = ex.check === "teacher" ? (isManual(ex) ? writingBar(u, ex, g) : exerciseBar(u, ex, g)) : "";
  return `<div class="ex-bar tbar">${row}${check}</div>`;
}

// students of the group and their answers in this exercise (drafts and submitted work)
function exStats(ex) {
  const keys = T.unitData[T.unitId]?.keys?.[ex.id] || {};
  const inGroup = new Set(T.students.map((s) => s.uid));
  const nameOf = (uid) => T.students.find((s) => s.uid === uid)?.name || "?";
  const subs = T.subs.filter((s) => inGroup.has(s.uid));
  let answered = 0, done = 0;
  for (const s of subs) {
    if (Object.values(s.answers?.[ex.id] || {}).some((v) => String(v ?? "").trim())) answered++;
    if (doneMap(s.answers)[ex.id] || s.status === "submitted") done++;
  }
  const out = { answered, done, total: T.students.length };
  if (!isAuto(ex) || isTranslation(ex)) return out;
  let n = 0, ok = 0;
  out.items = {};
  for (const it of ex.items || []) {
    const r = { n: 0, ok: 0, wrong: {} };
    for (const s of subs) {
      const v = s.answers?.[ex.id]?.[it.id];
      if (!String(v ?? "").trim()) continue;
      r.n++;
      if (isCorrect(v, keys[it.id], { punct: ex.punct })) r.ok++;
      else (r.wrong[norm(v)] ??= { label: answerLabel(ex, String(v).trim()), names: [] }).names.push(nameOf(s.uid));
    }
    r.wrong = Object.values(r.wrong).sort((a, b) => b.names.length - a.names.length);
    out.items[it.id] = r;
    n += r.n; ok += r.ok;
  }
  out.pct = n ? Math.round((100 * ok) / n) : null;
  out.wrong = n - ok;
  return out;
}
function statSummary(ex, st) {
  const parts = [`<span title="Students who have answered at least one item">answered <b>${st.answered}/${st.total}</b></span>`,
    `<span title="Students who have clicked Done (or submitted the unit)">done <b>${st.done}/${st.total}</b></span>`];
  if (st.items) parts.push(st.pct === null ? `<span class="muted">no answers yet</span>`
    : `<span class="pct" style="color:${heat(st.pct)}" title="Correct answers among all answers given">correct <b>${st.pct}%</b></span>${st.wrong ? ` <span class="bad-n">${st.wrong} ${st.wrong === 1 ? "mistake" : "mistakes"}</span>` : ""}`);
  return parts.join(" · ");
}
function itemBadge(ex, r) {
  if (!r || !r.n) return "";
  const tip = r.wrong.length ? r.wrong.map((w) => `“${w.label}”: ${w.names.join(", ")}`).join("\n") : "All answers are correct";
  return `<span class="ib" title="${esc(tip)}">${r.ok ? `<span class="ib-ok">✓${r.ok}</span>` : ""}${r.n - r.ok ? `<span class="ib-bad">✗${r.n - r.ok}</span>` : ""}</span>`;
}
function mistakesHTML(ex, st) {
  const rows = (ex.items || []).filter((it) => st.items[it.id]?.wrong.length).map((it) => `<tr><td class="num">${esc(it.id)}</td>
    <td>${st.items[it.id].wrong.map((w) => `<span class="mw">“${esc(w.label)}”</span> <span class="muted">${esc(w.names.join(", "))}</span>`).join("<br>")}</td></tr>`).join("");
  return `<div class="mist-h">Students' mistakes (drafts included)</div>` + (rows ? `<table class="t mist-t">${rows}</table>` : `<p class="muted">No mistakes so far.</p>`);
}
function unitViewKey(r) {
  const u = T.units.find((x) => x.id === r.unit), g = group(), d = T.unitData[r.unit];
  if (!u || !d?.content) return "";
  return JSON.stringify([u.id, r.section || "", T.gid, u.status, !!g?.openUnits?.includes(u.id), !!g?.releasedUnits?.includes(u.id),
    g?.releasedEx?.[u.id] || [], g?.feedbackEx?.[u.id] || [], g?.plan?.[u.id] || {}, Object.keys(T.practice[u.id] || {}).length > 0,
    // a student's answers on the page: drawn again when the student changes them or gets feedback
    T.viewAs, T.viewAs ? viewAsStamp() : ""]);
}
function patchUnitStats() {
  const d = T.unitData[T.unitId];
  if (!d?.content) return;
  const byId = Object.fromEntries(exercisesOf(d.content).map((ex) => [ex.id, ex]));
  const cache = {};
  const stOf = (id) => (cache[id] ??= byId[id] ? exStats(byId[id]) : null);
  document.querySelectorAll("#view [data-ts]").forEach((el) => { const st = stOf(el.dataset.ts); if (st) el.innerHTML = statSummary(byId[el.dataset.ts], st); });
  document.querySelectorAll("#view [data-is]").forEach((el) => {
    const [exId, itemId] = el.dataset.is.split("|");
    const st = stOf(exId);
    if (st?.items) el.innerHTML = itemBadge(byId[exId], st.items[itemId]);
  });
  document.querySelectorAll("#view [data-mi]").forEach((el) => { const st = stOf(el.dataset.mi); if (st?.items) el.innerHTML = mistakesHTML(byId[el.dataset.mi], st); });
}

// the teacher's own answers in the unit: kept in memory, never saved
function onPractice(e) {
  const el = e.target;
  if (!el.dataset?.item || !el.dataset.ex || el.matches(".g-score,.g-comment")) return;
  const r = route();
  if (!r.unit || !$("#view").contains(el)) return;
  const v = readInput(el);
  if (v === null) return;
  const had = Object.keys(T.practice[r.unit] || {}).length > 0;
  ((T.practice[r.unit] ??= {})[el.dataset.ex] ??= {})[el.dataset.item] = v;
  if (!had) T.unitViewKey = unitViewKey(r);   // the "Clear my answers" button appears on the next full drawing
}
document.addEventListener("input", onPractice);
document.addEventListener("change", onPractice);

// In-Class / HA and Done: groups/{gid}.plan[unitId][exId] = {as, done, date}
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset?.planDone || t.dataset?.planDate) guard(async () => {
    const [u, ex] = (t.dataset.planDone || t.dataset.planDate).split("|");
    const p = group()?.plan?.[u]?.[ex] || {};
    const base = `plan.${u}.${ex}`;
    if (t.dataset.planDone) {
      const date = p.date || todayISO();
      await updateDoc(doc(db, "groups", T.gid), t.checked
        ? { [`${base}.done`]: true, [`${base}.date`]: date }
        : { [`${base}.done`]: false, [`${base}.date`]: deleteField() });
      if (t.checked && p.as === "class") await ensureLesson(date);
    } else if (t.value) {
      await updateDoc(doc(db, "groups", T.gid), { [`${base}.date`]: t.value });
      if (p.as === "class") await ensureLesson(t.value);
    }
  });
});
async function setPlanAs(u, ex, as) {
  await guard(async () => {
    const p = group()?.plan?.[u]?.[ex] || {};
    const val = p.as === as ? deleteField() : as;      // a second click removes the label
    await updateDoc(doc(db, "groups", T.gid), { [`plan.${u}.${ex}.as`]: val });
    if (as === "class" && p.as !== "class" && p.done && p.date) await ensureLesson(p.date);
  });
}

// ================================================================== Attendance
const journalRef = (gid) => doc(db, "answerKeys", `journal~${gid}`);
async function ensureLesson(date) {
  if (!T.gid || !date || T.journal?.lessons?.[date]) return;
  await setDoc(journalRef(T.gid), { groupId: T.gid, lessons: { [date]: { absent: [] } } }, { merge: true });
}
// {exId: 0.25} for the in-class exercises done on a day when this student was absent
function factorsFor(uid, unitId) {
  const out = {};
  for (const [exId, p] of Object.entries(group()?.plan?.[unitId] || {}))
    if (p?.as === "class" && p.done && p.date && (T.journal?.lessons?.[p.date]?.absent || []).includes(uid)) out[exId] = ABSENT_FACTOR;
  return out;
}
function adjustedAuto(auto, factors) {
  return r2(Object.entries(auto.items).reduce((n, [exId, items]) => n + Object.values(items).filter((x) => x.ok).length * (factors[exId] ?? 1), 0));
}

function viewJournal() {
  const g = group();
  const head = pageHead("Teaching tools", "Attendance", g ? `Group ${esc(g.name)}` : "");
  if (!g) return head + `<div class="box">First create a group in <a href="#tools/groups">Groups &amp; students</a>.</div>`;
  if (T.journal === undefined) return head + `<p class="muted">Loading…</p>`;
  const L = T.journal.lessons || {};
  const dates = Object.keys(L).sort();
  // exercises marked Done for each date, in all units
  const byDate = {};
  for (const u of T.units) for (const [exId, p] of Object.entries(g.plan?.[u.id] || {})) {
    if (!p?.done || !p.date) continue;
    if (!T.unitData[u.id] && !(T.unitLoading ??= new Set()).has(u.id)) { T.unitLoading.add(u.id); loadUnitData(u.id).then(() => render(true)).catch(() => {}); }
    const num = T.unitData[u.id]?.content ? exerciseNumbers(T.unitData[u.id].content, unitNum(u))[exId] : null;
    (byDate[p.date] ??= []).push({ u, exId, as: p.as, num: num || `${unitNum(u)} · ${exId}` });
  }
  const exList = (date, as) => (byDate[date] || []).filter((x) => x.as === as).sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }))
    .map((x) => `<span class="jx ${as}">${esc(x.num)}</span>`).join(" ") || `<span class="muted">—</span>`;
  const absentN = (uid) => dates.filter((d) => (L[d].absent || []).includes(uid)).length;
  const rows = T.students.map((st) => `<tr><td><b>${esc(st.name)}</b></td>
    ${dates.map((d) => { const a = (L[d].absent || []).includes(st.uid);
      return `<td class="jc"><button type="button" class="att ${a ? "abs" : "pres"}" data-act="att" data-date="${esc(d)}" data-uid="${esc(st.uid)}" title="${a ? "Absent: click to mark present" : "Present: click to mark absent"}">${a ? "✗" : "✓"}</button></td>`; }).join("")}
    <td class="num">${absentN(st.uid) || ""}</td></tr>`).join("");
  return head + `
  <div class="box">
    <div class="row"><label>Lesson date <input type="date" id="j-date" value="${todayISO()}"></label>
      <button class="btn primary" data-act="lesson-add">Add the lesson</button></div>
    <p class="muted" style="margin:8px 0 0">Everybody is present in a new lesson: click ✓ to mark a student absent (✗), click again to undo.
      A lesson is also added automatically when you tick <b>Done</b> on an <b>In-Class</b> exercise.
      <b>Rule:</b> for the In-Class exercises done on a day when a student was absent, the student gets ${Math.round(ABSENT_FACTOR * 100)}% of the points.
      If you have already checked the work, click <b>Re-check</b> (or <b>Check this exercise now</b> again) so that changes in attendance reach the students' results.</p>
    ${T.journal.error ? `<p class="bad-n">The attendance could not be loaded. Check the connection and reload the page.</p>` : ""}
  </div>
  ${dates.length ? `<div style="overflow-x:auto"><table class="t jt">
    <tr><th>Student</th>${dates.map((d) => `<th class="jc">${esc(fmtDate(d).slice(0, 5))}<br><button type="button" class="jdel" data-act="lesson-del" data-date="${esc(d)}" title="Delete this lesson">delete</button></th>`).join("")}<th>Absent</th></tr>
    ${rows || `<tr><td colspan="${dates.length + 2}" class="muted">There are no students in this group yet.</td></tr>`}
    <tr class="jfoot"><td>Present</td>${dates.map((d) => `<td class="jc num">${T.students.length - (L[d].absent || []).filter((uid) => T.students.some((s) => s.uid === uid)).length}</td>`).join("")}<td></td></tr>
  </table></div>
  <h3>What was done</h3>
  <table class="t"><tr><th>Date</th><th>In-Class</th><th>HA</th><th>Absent</th></tr>
    ${[...dates].reverse().map((d) => `<tr><td>${esc(fmtDate(d))}</td><td>${exList(d, "class")}</td><td>${exList(d, "home")}</td>
      <td>${(L[d].absent || []).map((uid) => esc(T.students.find((s) => s.uid === uid)?.name || "")).filter(Boolean).join(", ") || `<span class="muted">—</span>`}</td></tr>`).join("")}
  </table>` : `<div class="box muted">No lessons yet. Choose a date and click “Add the lesson”.</div>`}`;
}
async function addLesson() {
  const date = $("#j-date")?.value;
  if (!date) return toast("Choose a date first.");
  if (T.journal?.lessons?.[date]) return toast("This lesson is already in the list.");
  await guard(() => ensureLesson(date));
}
async function toggleAbsent(date, uid) {
  const a = (T.journal?.lessons?.[date]?.absent || []).includes(uid);
  await guard(() => setDoc(journalRef(T.gid), { groupId: T.gid, lessons: { [date]: { absent: a ? arrayRemove(uid) : arrayUnion(uid) } } }, { merge: true }));
}
async function deleteLesson(date) {
  if (!confirm(`Delete the lesson of ${fmtDate(date)} from the attendance list?`)) return;
  await guard(() => updateDoc(journalRef(T.gid), { [`lessons.${date}`]: deleteField() }));
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
      const f = factorsFor(s.uid, unitId)[exId] ?? 1;      // absent from the lesson: 25% of the points
      batch.set(doc(db, "exerciseResults", subId(unitId, s.uid)), {
        uid: s.uid, groupId: gid, unitId,
        items: { [exId]: r.items }, scores: { [exId]: { score: r2(r.score * f), max: r.max } }, factors: { [exId]: f },
        updatedAt: serverTimestamp(),
      }, { merge: true });
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    batch.update(doc(db, "groups", gid), { [`releasedEx.${unitId}`]: arrayUnion(exId) });
    await batch.commit();
    toast(`“${ex.title}” checked for ${subs.length} ${subs.length === 1 ? "student" : "students"}. Only this exercise is closed; the others stay open.`, 6000);
  });
}

// Free writing ("kind": "open", "check": "teacher"): the check gives feedback, the text stays editable
function writingBar(u, ex, g) {
  const done = (g.feedbackEx?.[u.id] || []).includes(ex.id);
  return `<div class="tb-row"><span>Group <b>${esc(g.name)}</b>: <span class="pill ${done ? "on" : "off"}">${done ? "feedback shown" : "not checked yet"}</span></span>
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
      const plainIds = new Set((ex.items || []).filter((it) => it.plain).map((it) => it.id));
      const texts = Object.fromEntries(Object.entries(s.answers[exId] || {}).filter(([id]) => !plainIds.has(id)));
      let issues = {}, grammarError = false;
      try { issues = await grammarCheck(texts); } catch (e) { console.warn(e); grammarError = true; ltFailed++; }
      const fb = {};
      for (const it of ex.items || []) {
        if (it.plain) continue;                     // a partner's name: nothing to check
        const text = String(texts[it.id] || "");
        if (!text.trim()) continue;
        fb[it.id] = { text, issues: issues[it.id] || [], grammarError, vocab: vocabProfile(text, V, phrases), unitTotal: phrases.length };
        // a transcribed speaking task: the measurements of the speech (length, speed, pauses) go with the feedback
        if (ex.transcript && it === ex.items[0] && s.answers?._speech?.[exId]) { try { fb[it.id].speech = JSON.parse(s.answers._speech[exId]); } catch {} }
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
      ${rel ? `<button class="btn small danger" data-act="unrelease" data-unit="${esc(u.id)}">Hide whole-unit results</button>` : ""}
    </span>
    <span class="muted" style="flex-basis:100%;font-size:13px">To check one exercise, use the green button above it. The whole unit is checked only in <a href="#tools/access">Access &amp; results</a>.</span></div>`;
}

// ================================================================== Speaking and Writing progress
// One page for each skill, the same layout: the group table (task by task, with the change and a trend line) and a chart
// of the chosen measure, then a card for every student with all their texts and figures. A student can be chosen
// in the list: the chart then shows this student against the group mean.
// Speaking: every exercise with "transcript" (the text Whisper wrote from a recording, alone or a pair discussion).
// Writing: open exercises marked "track": "writing", or one-text tasks in the Writing section (a letter, an essay…).
async function loadProgress() {
  const gid = T.gid;
  T.prog = { gid, loading: true };
  try {
    const V = await loadVocab();
    const tasks = [];
    for (const u of [...T.units].filter((x) => x.status !== "soon").sort((a, b) => unitNum(a) - unitNum(b))) {
      const { content } = await loadUnitData(u.id);
      if (!content) continue;
      const nums = exerciseNumbers(content, unitNum(u));
      const unitPhrases = unitVocabulary(content);
      for (const ex of exercisesOf(content)) {
        const skill = ex.transcript ? "speaking" : isWritingTask(ex) ? "writing" : "";
        if (!skill) continue;
        const it = (ex.items || []).find((x) => !x.plain);
        if (!it) continue;
        const own = Array.isArray(ex.vocab) && ex.vocab.length ? ex.vocab : null;
        tasks.push({ key: `${u.id}/${ex.id}`, skill, unitId: u.id, unitNo: unitNum(u), ex, itemId: it.id, num: nums[ex.id] || "",
          title: ex.title || "", prompt: new DOMParser().parseFromString(String(it.text || ex.rubric || "").replace(/<[^>]+>/g, " "), "text/html").body.textContent.replace(/\s+/g, " ").trim(),
          phrases: own || (skill === "writing" ? unitPhrases : []), phrasesOwn: !!own,
          partnerId: (ex.items || []).find((x) => x.plain)?.id || "" });
      }
    }
    const [subs, exrs] = await Promise.all([
      getDocs(query(collection(db, "submissions"), where("groupId", "==", gid))),
      getDocs(query(collection(db, "exerciseResults"), where("groupId", "==", gid))),
    ]);
    const exrOf = {};
    exrs.docs.forEach((d) => { const x = d.data(); exrOf[subId(x.unitId, x.uid)] = x; });
    const rows = [];
    for (const d of subs.docs) {
      const sub = d.data();
      for (const t of tasks) {
        if (t.unitId !== sub.unitId) continue;
        const text = String(sub.answers?.[t.ex.id]?.[t.itemId] || "").trim();
        if (!text) continue;
        let sp = null;
        if (t.skill === "speaking") { try { sp = JSON.parse(sub.answers?._speech?.[t.ex.id] || "null"); } catch {} }
        const fb = exrOf[subId(sub.unitId, sub.uid)]?.feedback?.[t.ex.id]?.[t.itemId];
        rows.push({
          uid: sub.uid, key: t.key, skill: t.skill, text, status: sub.status,
          partner: t.partnerId ? String(sub.answers?.[t.ex.id]?.[t.partnerId] || "").trim() : "",
          at: sp?.at || sub.updatedAt?.toMillis?.() || 0, atExact: !!sp?.at,
          m: measure(text, V, t.phrases, fb, sp),
        });
      }
    }
    if (T.prog?.gid === gid) T.prog = { gid, tasks, rows, at: new Date() };
  } catch (e) {
    console.warn(e);
    if (T.prog?.gid === gid) T.prog = { gid, error: friendlyError(e) };
  }
  if (["speaking", "writing"].includes(route().tool)) render(true);
}

const n1 = (x) => (Math.round(x * 10) / 10).toString();
const fmtV = (v, id) => (v === null || v === undefined || Number.isNaN(v) ? "–" : id === "mattr" ? Number(v).toFixed(2) : String(v));
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

function sparkline(vals, dir) {
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => typeof v === "number");
  if (pts.length < 2) return "";
  const W = 90, H = 24, xs = vals.length - 1 || 1;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])), span = hi - lo || 1;
  const P = pts.map(([i, v]) => [(4 + (i / xs) * (W - 8)).toFixed(1), (H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)]);
  const up = (pts[pts.length - 1][1] - pts[0][1]) * dir >= 0;
  const c = `var(${up ? "--ok" : "--bad"})`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${P.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${c}" stroke-width="1.8"/>${P.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="${c}"/>`).join("")}</svg>`;
}

function progressChart(tasks, series, mean, M, one) {
  const all = [...series.flatMap((s) => s.vals), ...mean].filter((v) => typeof v === "number");
  if (!all.length || tasks.length < 2) return "";
  const W = 640, H = 220, L = 44, R = 12, Tp = 14, B = 34;
  const lo = Math.min(0, ...all), hi = Math.max(...all) || 1;
  const x = (i) => L + (i / (tasks.length - 1)) * (W - L - R);
  const y = (v) => Tp + (1 - (v - lo) / (hi - lo || 1)) * (H - Tp - B);
  const line = (vals) => { const p = vals.map((v, i) => (typeof v === "number" ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean); return p.length > 1 ? p.join(" ") : ""; };
  const dots = (vals, cls, who) => vals.map((v, i) => (typeof v === "number" ? `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" class="${cls}"><title>T${i + 1}: ${esc(who)} ${fmtV(v, M.id)}</title></circle>` : "")).join("");
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmtV(Math.round(v * 100) / 100, M.id)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`).join("");
  const xl = tasks.map((t, i) => `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" class="ax">T${i + 1}</text>`).join("");
  const st = series.map((s) => { const p = line(s.vals); return (p ? `<polyline points="${p}" class="st${one ? " one" : ""}"><title>${esc(s.name)}</title></polyline>` : "") + (one ? dots(s.vals, "one", s.name) : ""); }).join("");
  const mp = line(mean);
  return `<figure class="prog-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(M.label)} by task">${ticks}${xl}${mp ? `<polyline points="${mp}" class="mn"/>` : ""}${dots(mean, "mn", "group mean")}${st}</svg>
    <figcaption><span class="lg mn"></span> group mean &nbsp; <span class="lg st${one ? " one" : ""}"></span> ${one ? esc(series[0]?.name || "") : "individual students (hover for the name)"}</figcaption></figure>`;
}

function viewProgress(skill) {
  const g = group();
  const isSp = skill === "speaking";
  const head = pageHead("Teaching tools", isSp ? "Speaking progress" : "Writing progress", isSp
    ? "Every recording a student has turned into text (Whisper, in the student's browser), task by task. Recordings made alone and pair discussions are marked, because their figures are not the same thing."
    : "Every tracked text a student has written (letters, essays and other one-text tasks), task by task.");
  if (!g) return head + `<div class="box">Choose a group at the top of the page.</div>`;
  if (!T.prog || T.prog.gid !== T.gid) { loadProgress(); return head + `<p class="muted">Loading the texts of group ${esc(g.name)}…</p>`; }
  if (T.prog.loading) return head + `<p class="muted">Loading the texts of group ${esc(g.name)}…</p>`;
  if (T.prog.error) return head + `<div class="box">The data could not be loaded: ${esc(T.prog.error)} <button class="btn small" data-act="prog-reload">Try again</button></div>`;
  const O = T.progOpt;
  // In-Class or HA: what the teacher marked above the exercise (the same mark as for attendance)
  const setOf = (t) => g.plan?.[t.unitId]?.[t.ex.id]?.as || "";
  const SET = { class: "In-Class", home: "HA" };
  const tagOf = (t) => (setOf(t) ? `<span class="set-tag ${setOf(t)}">${SET[setOf(t)]}</span>` : "");
  const tasksAll = T.prog.tasks.filter((t) => t.skill === skill);
  const tasks = O.setting ? tasksAll.filter((t) => setOf(t) === O.setting) : tasksAll;
  const metrics = METRICS.filter((m) => !m.skill || m.skill === skill);
  const M = metrics.find((m) => m.id === O.metric[skill]) || metrics[0];
  const studs = T.students;
  if (O.student && !studs.some((s) => s.uid === O.student)) O.student = "";
  const shown = O.student ? studs.filter((s) => s.uid === O.student) : studs;
  const by = new Map(T.prog.rows.filter((r) => r.skill === skill).map((r) => [r.uid + "|" + r.key, r]));
  const val = (uid, t) => { const r = by.get(uid + "|" + t.key); return r ? r.m[M.id] : undefined; };
  const seriesAll = studs.map((s) => ({ name: s.name, uid: s.uid, vals: tasks.map((t) => val(s.uid, t)) }));
  const series = O.student ? seriesAll.filter((s) => s.uid === O.student) : seriesAll;
  const mean = tasks.map((t, i) => { const v = seriesAll.map((s) => s.vals[i]).filter((x) => typeof x === "number"); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; });
  const counts = tasks.map((t, i) => seriesAll.filter((s) => typeof s.vals[i] === "number").length);

  const controls = `<div class="prog-ctl">
      <label>Student <select id="prog-student"><option value="">All students (${studs.length})</option>${studs.map((s) => `<option value="${esc(s.uid)}" ${s.uid === O.student ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <span class="seg prog-set" role="group" aria-label="In class or at home">${[["", "All tasks"], ["class", "In-Class"], ["home", "HA"]].map(([v, l]) => `<button type="button" class="${O.setting === v ? "on" : ""}" data-act="prog-set" data-set="${v}">${l}</button>`).join("")}</span>
      <label>Measure <select id="prog-metric" data-skill="${skill}">${metrics.map((m) => `<option value="${m.id}" ${m.id === M.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
      <span style="flex:1"></span>
      <span class="muted" style="font-size:13px">Group <b>${esc(g.name)}</b> · ${esc(fmtTime(T.prog.at))}</span>
      <button class="btn small" data-act="prog-reload">Refresh</button>
      <button class="btn small primary" data-act="prog-csv" title="Speaking and writing, every student and task, for research">Download all data (.csv)</button>
    </div>`;
  if (!tasks.length && O.setting) return head + controls + `<div class="box">No ${isSp ? "speaking" : "writing"} task is marked <b>${SET[O.setting]}</b> yet. Mark tasks with the In-Class / HA buttons above each exercise in the unit.</div>`;
  if (!tasks.length) return head + controls + `<div class="box">${isSp ? "There are no exercises with speech turned into text in the open units yet." : "There are no tracked writing tasks in the open units yet. A task is tracked when it is a one-text exercise in the Writing section (a letter, an essay…) or is marked <code>\"track\": \"writing\"</code> in the course file."}</div>`;

  const help = `<details class="box"><summary><b>How to read the figures</b></summary><ul>
    ${isSp ? `<li><b>Spoke</b> – time with speech in the recording (of the whole recording); <b>words per minute</b> – speed while speaking; <b>pauses</b> – silences longer than one second, per minute of recording.</li>` : `<li><b>Words per sentence</b> and <b>subordinating words</b> (<i>because, although, which, who, when, if…</i> per 100 words) show how complex the sentences are.</li>`}
    <li><b>Errors per 100 words</b> – LanguageTool issues except punctuation, spelling of spaces and style. They appear after you click <b>Check the writing now</b> above the exercise, and only while the text is the same as at the check.${isSp ? " The speech program sometimes corrects students’ mistakes, so the real number is higher; compare students with themselves, not with each other." : ""}</li>
    <li><b>MATTR-50</b> – lexical diversity: the share of different words in every 50-word window (Covington &amp; McFall, 2010); it does not depend on the length of the text.</li>
    <li><b>B2+ words</b> – the share of words from the higher levels of the word lists (CEFR-J A1–B2, Octanove C1–C2).</li>
    <li><b>${isSp ? "Task phrases" : "Unit phrases"}</b> – ${isSp ? "phrases from the exercise list that were used (passing the turn, building on an idea, disagreeing…)" : "words and phrases of the unit vocabulary that were used"}.</li>
    ${isSp ? `<li>In a <b>pair discussion</b> the program does not separate the two voices: the figures describe the pair, and the text is in the account of the student who recorded it. The partner’s name is next to it.</li>` : ""}
    <li><b>Change</b> – the last value minus the first; green means better, red means worse for this measure. Click a figure in the table to see the text.</li>
  </ul></details>`;

  const taskHead = tasks.map((t, i) => `<th title="${esc(`${t.num} ${t.title} – ${t.prompt}`)}">T${i + 1}<span class="s">${esc(t.num)}${setOf(t) ? ` · ${SET[setOf(t)]}` : ""}</span></th>`).join("");
  const rowsHTML = series.map((s) => {
    const nums = s.vals.filter((v) => typeof v === "number");
    const change = nums.length > 1 ? Math.round((nums[nums.length - 1] - nums[0]) * 100) / 100 : null;
    const good = change !== null && change * M.dir > 0, bad = change !== null && change * M.dir < 0;
    return `<tr><td class="nm"><a href="#" data-act="prog-student" data-uid="${esc(s.uid)}" title="Show only this student">${esc(s.name)}</a></td>${s.vals.map((v, i) => `<td class="num">${typeof v === "number" ? `<a href="#" data-act="prog-open" data-uid="${esc(s.uid)}" data-key="${esc(tasks[i].key)}">${fmtV(v, M.id)}</a>` : by.has(s.uid + "|" + tasks[i].key) ? `<a href="#" class="muted" data-act="prog-open" data-uid="${esc(s.uid)}" data-key="${esc(tasks[i].key)}" title="Text is there; not checked yet">text</a>` : `<span class="muted">–</span>`}</td>`).join("")}
      <td class="num ${good ? "up" : bad ? "down" : ""}">${change === null ? "–" : (change > 0 ? "+" : "") + fmtV(change, M.id)}</td><td>${sparkline(s.vals, M.dir)}</td></tr>`;
  }).join("");
  const table = `<div class="tscroll"><table class="t prog"><thead><tr><th>Student${O.student ? ` <a href="#" data-act="prog-student" data-uid="" class="all-link">show all</a>` : ""}</th>${taskHead}<th>Change</th><th>Trend</th></tr></thead>
    <tbody>${rowsHTML}</tbody>
    <tfoot><tr><td><b>Group mean</b></td>${mean.map((v) => `<td class="num"><b>${fmtV(v, M.id)}</b></td>`).join("")}<td></td><td>${sparkline(mean, M.dir)}</td></tr>
      <tr><td class="muted">Answers</td>${counts.map((c) => `<td class="num muted">${c}</td>`).join("")}<td></td><td></td></tr></tfoot></table></div>`;
  const legend = `<ol class="prog-tasks">${tasks.map((t, i) => `<li><b>T${i + 1}</b> · ${esc(t.num)} ${esc(t.title)} ${tagOf(t)}${t.ex.pair ? " · pair discussion" : ""} <span class="muted">${esc(t.prompt.slice(0, 110))}${t.prompt.length > 110 ? "…" : ""}</span></li>`).join("")}</ol>`;

  // the text and every figure of one answer (clicked in the table)
  let detail = "";
  if (O.open) {
    const r = by.get(O.open.uid + "|" + O.open.key), t = tasks.find((x) => x.key === O.open.key), st = studs.find((x) => x.uid === O.open.uid);
    if (r && t) {
      const m = r.m;
      const facts = [["Words", m.words],
        ...(isSp ? [["Spoke", m.total ? `${mmss(m.speech)} of ${mmss(m.total)}` : "–"], ["Words per minute", fmtV(m.wpm)], ["Pauses", m.pauses === null ? "–" : `${m.pauses} (${fmtV(m.pausesPerMin)} a minute, longest ${m.longest} s)`]]
          : [["Words per sentence", m.sentLen]]),
        ["Subordinating words / 100", m.subPer100], ["MATTR-50", fmtV(m.mattr, "mattr")], ["B2+ words", m.b2plus + "%"], ["C1+ words", m.c1plus + "%"],
        [isSp ? "Task phrases" : "Unit phrases", `${m.phrases}${t.phrasesOwn ? ` of ${t.phrases.length}` : ""}${m.phraseList.length ? ` (${esc(m.phraseList.join(", "))})` : ""}`],
        ["LanguageTool", m.ltChecked ? `${m.ltAll} issues, ${m.ltGrammar} grammar · ${m.errPer100} errors per 100 words` : m.ltStale ? "the text was changed after the check" : "not checked yet"]];
      detail = `<div class="box prog-detail" id="prog-detail"><div class="row" style="justify-content:space-between"><b>${esc(st?.name || "")} · T${tasks.indexOf(t) + 1} · ${esc(t.num)} ${esc(t.title)}</b>
        <button class="btn small" data-act="prog-close">Close</button></div>
        <p class="muted">${esc(t.prompt)}${r.partner ? ` · pair with ${esc(r.partner)}` : ""}</p>
        <div class="prog-text">${esc(r.text)}</div>
        ${m.checkedText && m.checkedText.trim() !== r.text ? `<details><summary>Text at the time of the check</summary><div class="prog-text">${esc(m.checkedText)}</div></details>` : ""}
        <dl class="prog-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
    }
  }

  // In class against at home, for the chosen measure: each student's mean in each setting, then the group
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const setMean = (uid, set) => avgOf(tasksAll.filter((t) => setOf(t) === set).map((t) => by.get(uid + "|" + t.key)?.m[M.id]).filter((v) => typeof v === "number"));
  const cmp = Object.fromEntries(studs.map((s) => [s.uid, { c: setMean(s.uid, "class"), h: setMean(s.uid, "home") }]));
  const both = studs.filter((s) => cmp[s.uid].c !== null && cmp[s.uid].h !== null);
  const nC = tasksAll.filter((t) => setOf(t) === "class").length, nH = tasksAll.filter((t) => setOf(t) === "home").length;
  const fmtM = (v) => (v === null ? "–" : fmtV(Math.round(v * 100) / 100, M.id));
  const dCell = (c, h) => { if (c === null || h === null) return `<td class="num muted">–</td>`; const d = Math.round((h - c) * 100) / 100; return `<td class="num ${d * M.dir > 0 ? "up" : d * M.dir < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${fmtV(d, M.id)}</td>`; };
  let compare = "";
  if (nC && nH) {
    const gc = avgOf(both.map((s) => cmp[s.uid].c)), gh = avgOf(both.map((s) => cmp[s.uid].h));
    const list = O.student ? shown : studs;
    compare = `<h3 class="prog-h">In class and at home: ${esc(M.label)}</h3>
      <p class="muted" style="font-size:13px">${nC} ${nC === 1 ? "task" : "tasks"} marked In-Class, ${nH} marked HA. Each figure is the student's mean over the tasks of that kind; the group line uses only the ${both.length} ${both.length === 1 ? "student" : "students"} who have both. “HA minus In-Class”: green – better at home, red – better in class.</p>
      <div class="tscroll"><table class="t prog"><thead><tr><th>Student</th><th>In-Class</th><th>HA</th><th>HA minus In-Class</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td class="nm">${esc(s.name)}</td><td class="num">${fmtM(cmp[s.uid].c)}</td><td class="num">${fmtM(cmp[s.uid].h)}</td>${dCell(cmp[s.uid].c, cmp[s.uid].h)}</tr>`).join("")}
      </tbody><tfoot><tr><td><b>Group mean</b></td><td class="num"><b>${fmtM(gc)}</b></td><td class="num"><b>${fmtM(gh)}</b></td>${dCell(gc, gh)}</tr></tfoot></table></div>`;
  } else {
    compare = `<p class="muted" style="font-size:13px">To compare work done in class with home assignments, mark the ${isSp ? "speaking" : "writing"} tasks <b>In-Class</b> or <b>HA</b> above each exercise in the unit${nC || nH ? ` (now: ${nC} In-Class, ${nH} HA)` : ""}.</p>`;
  }

  // a card for each student: every text in order with its figures
  const taskOf = Object.fromEntries(tasks.map((t, i) => [t.key, { t, i }]));
  const diff = (a, b, d = 0) => { const x = b - a, v = d ? n1(Math.abs(x)) : Math.round(Math.abs(x)); return +v === 0 ? "no change" : (x > 0 ? "+" : "−") + v; };
  const firstLast = (rows) => {
    if (rows.length < 2) return `<p class="muted">One ${isSp ? "recording" : "text"} so far: the changes will appear after the next one.</p>`;
    const a = rows[0].m, b = rows[rows.length - 1].m, out = [];
    out.push(`words ${a.words} then ${b.words} (${diff(a.words, b.words)})`);
    if (isSp && a.wpm && b.wpm) out.push(`words per minute ${a.wpm} then ${b.wpm} (${diff(a.wpm, b.wpm)})`);
    if (isSp && a.pausesPerMin !== null && b.pausesPerMin !== null) out.push(`pauses per minute ${n1(a.pausesPerMin)} then ${n1(b.pausesPerMin)} (${diff(a.pausesPerMin, b.pausesPerMin, 1)})`);
    if (!isSp) out.push(`words per sentence ${n1(a.sentLen)} then ${n1(b.sentLen)} (${diff(a.sentLen, b.sentLen, 1)})`);
    const ga = rows.find((r) => r.m.errPer100 !== null), gb = [...rows].reverse().find((r) => r.m.errPer100 !== null);
    if (ga && gb && ga !== gb) out.push(`errors per 100 words ${n1(ga.m.errPer100)} then ${n1(gb.m.errPer100)} (${diff(ga.m.errPer100, gb.m.errPer100, 1)})`);
    out.push(`B2+ words ${Math.round(a.b2plus)}% then ${Math.round(b.b2plus)}% (${diff(a.b2plus, b.b2plus)})`);
    const ta = taskOf[rows[0].key].t, tb = taskOf[rows[rows.length - 1].key].t;
    return `<p><b>First and last (${esc(ta.num)} and ${esc(tb.num)}):</b> ${out.join(" · ")}.</p>`
      + (isSp && !!ta.ex.pair !== !!tb.ex.pair ? `<p class="muted">One of them was made alone and the other in a pair, so compare with care.</p>` : "");
  };
  const cols = isSp
    ? ["Exercise", "Date", "Recorded", "Spoke", "Words", "Words per minute", "Pauses", "Errors per 100 words", "Task phrases", "B2+ words", "MATTR"]
    : ["Exercise", "Date", "Words", "Words per sentence", "Subordinating / 100", "Errors per 100 words", "Unit phrases", "B2+ words", "MATTR"];
  const errCell = (m) => (m.errPer100 !== null ? n1(m.errPer100) : `<span class="muted">${m.ltStale ? "text changed after the check" : "not checked"}</span>`);
  const row = (r) => {
    const { t } = taskOf[r.key], m = r.m;
    const date = r.at ? esc((r.atExact ? "" : "about ") + new Date(r.at).toLocaleDateString("ru-RU")) : "—";
    const ph = `<td title="${esc(m.phraseList.join(", "))}">${t.phrasesOwn ? `${m.phrases} of ${t.phrases.length}` : t.phrases.length ? m.phrases : "—"}</td>`;
    const cells = isSp
      ? `<td>${date}</td><td>${t.ex.pair ? `pair${r.partner ? ` with ${esc(r.partner)}` : ""}` : "alone"}</td><td>${m.total ? mmss(m.speech) + " / " + mmss(m.total) : "—"}</td><td>${m.words}</td><td>${m.wpm || "—"}</td>
         <td>${m.pauses !== null ? `${m.pauses} <span class="muted">(${fmtV(m.pausesPerMin)}/min)</span>` : "—"}</td><td>${errCell(m)}</td>${ph}<td>${Math.round(m.b2plus)}%</td><td>${fmtV(m.mattr, "mattr")}</td>`
      : `<td>${date}</td><td>${m.words}</td><td>${m.sentLen}</td><td>${m.subPer100}</td><td>${errCell(m)}</td>${ph}<td>${Math.round(m.b2plus)}%</td><td>${fmtV(m.mattr, "mattr")}</td>`;
    return `<tr><td><b>${esc(t.num)}</b> ${esc(t.title)} ${tagOf(t)}</td>${cells}</tr>
      <tr class="spk-text"><td colspan="${cols.length}"><details ${O.student ? "open" : ""}><summary>Text${m.phraseList.length ? ` · phrases: ${esc(m.phraseList.join(", "))}` : ""}</summary><p>${esc(r.text)}</p></details></td></tr>`;
  };
  const cards = shown.map((st) => {
    const rows = tasks.map((t) => by.get(st.uid + "|" + t.key)).filter(Boolean);
    const what = isSp ? (rows.length === 1 ? "recording" : "recordings") : rows.length === 1 ? "text" : "texts";
    return `<section class="card spk-card"><h3>${esc(st.name)} <span class="muted" style="font-weight:400;font-size:14px">${rows.length} ${what}</span></h3>
      ${rows.length ? firstLast(rows) + `<div class="tscroll"><table class="t spk-t"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`
        : `<p class="muted">No ${isSp ? "recordings turned into text" : "texts"} yet.</p>`}</section>`;
  }).join("");

  return head + controls + help + detail
    + `<h3 class="prog-h">${esc(M.label)}: ${O.student ? `${esc(shown[0]?.name || "")} and the group mean` : "the whole group"}</h3>`
    + progressChart(tasks, series, mean, M, !!O.student) + table + legend + compare
    + `<h3 class="prog-h">${O.student ? "Texts and figures" : "Each student: texts and figures"}</h3>` + cards;
}

function progressCSV() {
  if (!T.prog?.rows) return;
  const g = group();
  const uids = [...new Set([...T.students.map((s) => s.uid), ...T.prog.rows.map((r) => r.uid)])];
  const code = Object.fromEntries(uids.map((u, i) => [u, "S" + String(i + 1).padStart(2, "0")]));
  const nameOf = Object.fromEntries(T.students.map((s) => [s.uid, s.name]));
  const taskOf = Object.fromEntries(T.prog.tasks.map((t, i) => [t.key, { t, i }]));
  const taskNo = {};
  for (const sk of ["speaking", "writing"]) T.prog.tasks.filter((t) => t.skill === sk).forEach((t, i) => (taskNo[t.key] = i + 1));
  const rows = [...T.prog.rows].sort((a, b) => a.skill.localeCompare(b.skill) || (code[a.uid] || "").localeCompare(code[b.uid] || "") || taskOf[a.key].i - taskOf[b.key].i).map((r) => {
    const { t } = taskOf[r.key], m = r.m;
    return { code: code[r.uid], student: nameOf[r.uid] || "", group: g?.name || "", skill: r.skill, unit: t.unitNo, task_no: taskNo[r.key], exercise: t.num || t.ex.id,
      task_title: t.title, setting: { class: "in-class", home: "home" }[g?.plan?.[t.unitId]?.[t.ex.id]?.as] || "", pair: t.ex.pair ? "yes" : "no", partner: r.partner, date: r.at ? new Date(r.at).toISOString().slice(0, 10) : "", submitted: r.status === "submitted" ? "yes" : "no",
      words: m.words, speech_s: m.speech || "", recording_s: m.total || "", wpm: m.wpm ?? "", pauses: m.pauses ?? "", pauses_per_min: m.pausesPerMin ?? "", longest_pause_s: m.longest ?? "",
      ttr: m.ttr, mattr50: m.mattr, b2plus_pct: m.b2plus, c1plus_pct: m.c1plus, phrases: m.phrases, phrase_list: m.phraseList.join("; "),
      words_per_sentence: m.sentLen, subordinators_per100: m.subPer100, lt_checked: m.ltChecked ? "yes" : "no", lt_issues_all: m.ltAll ?? "", lt_grammar: m.ltGrammar ?? "",
      errors_per100: m.errPer100 ?? "", text: r.text, text_at_check: m.checkedText };
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" }));
  a.download = `${COURSE_TITLE.replace(/[^\w]+/g, "-")}_${(g?.name || "group").replace(/[^\w]+/g, "-")}_progress_${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
document.addEventListener("change", (e) => {
  if (e.target.id === "prog-metric") { const sk = e.target.dataset.skill; T.progOpt.metric[sk] = e.target.value; ls.set("progM:" + sk, e.target.value); render(true); }
  if (e.target.id === "prog-student") { T.progOpt.student = e.target.value; T.progOpt.open = null; render(true); }
});

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
          : `<button class="btn small" data-act="release" data-unit="${esc(u.id)}" ${open ? "" : "disabled"}>Check the whole unit</button>`}`}</td>
    </tr>`;
  }).join("");
  return head + `
  <div class="box"><b>Group: ${esc(g.name)}</b> <span class="muted">(code <code>${esc(g.id)}</code>)</span><br>
  <span class="muted">To check <b>one exercise</b>, open the unit and click <b>Check this exercise now</b> above that exercise. “Check the whole unit” is for the end of a unit: it marks <b>all exercises</b> of all <b>submitted</b> work against the keys and shows the results; after that students can no longer change any answers in the unit.</span>
  <label class="row" style="margin-top:10px"><input type="checkbox" id="show-correct" ${T.showCorrect ? "checked" : ""}> Show students the correct answers to their mistakes</label></div>
  <table class="t"><tr><th>#</th><th>Unit</th><th>Access for the group</th><th>Results</th></tr>${rows}</table>`;
}

document.addEventListener("change", (e) => {
  if (e.target.id === "show-correct") { T.showCorrect = e.target.checked; ls.set("showCorrect", T.showCorrect ? "1" : "0"); }
  if (e.target.id === "stats-submitted") { T.statsOnlySubmitted = e.target.checked; render(true); }
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
    "prog-reload": () => { T.prog = null; T.progOpt.open = null; render(true); },
    "prog-csv": () => progressCSV(b.dataset.skill),
    "prog-open": () => { T.progOpt.open = { uid: b.dataset.uid, key: b.dataset.key }; render(true); setTimeout(() => $("#prog-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30); },
    "prog-close": () => { T.progOpt.open = null; render(true); },
    "prog-set": () => { T.progOpt.setting = b.dataset.set || ""; ls.set("progSet", T.progOpt.setting); T.progOpt.open = null; render(true); },
    "prog-student": () => { T.progOpt.student = b.dataset.uid || ""; T.progOpt.open = null; render(true); },
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
      const st = T.students.find((x) => x.uid === b.dataset.uid);
      const note = prompt(`Return the work of ${st?.name || "this student"} for revision.\nComment for the student (optional): what should be improved?\n\nExercises you have already checked stay closed.`, "");
      if (note === null) return;
      await updateDoc(doc(db, "submissions", subId(T.unitId, b.dataset.uid)), { status: "draft", returnNote: note.trim().slice(0, 1000), returnedAt: serverTimestamp() });
      toast("The work has been returned to the student.");
    }),
    "docx": () => downloadDocx(u, b.dataset.ver, b),
    "plan-as": () => setPlanAs(u, b.dataset.ex, b.dataset.as),
    "mist": () => {
      const id = b.dataset.ex;
      T.mistOpen.has(id) ? T.mistOpen.delete(id) : T.mistOpen.add(id);
      document.querySelectorAll(`[data-mi="${CSS.escape(id)}"]`).forEach((el) => (el.hidden = !T.mistOpen.has(id)));
    },
    "practice-clear": () => { delete T.practice[u]; render(true); },
    "view-as": () => setViewAs(b.dataset.uid),
    // Analytics: open the unit with this student's answers
    "view-unit-as": () => { T.viewAs = b.dataset.uid; location.hash = `#${T.unitId}`; },
    "lesson-add": () => addLesson(),
    "lesson-del": () => deleteLesson(b.dataset.date),
    "att": () => toggleAbsent(b.dataset.date, b.dataset.uid),
    "import": () => importCourse(),
    "delete-unit": () => deleteUnit(u),
    "create-group": () => createGroup(),
    "load-users": () => loadAllUsers(),
    "remove-student": () => removeStudent(b.dataset.uid),
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
    const un = T.units.find((x) => x.id === unitId);
    if (!confirm(`Check ALL exercises of Unit ${un ? unitNum(un) : ""} and show the results to the students?\nThis closes the whole unit: students can no longer change any answers.\n(To check one exercise, use the button above that exercise instead.)\n\nSubmitted: ${subs.length}${drafts ? `\nNot submitted (drafts): ${drafts}. These will not be checked and can no longer be edited.` : ""}`)) return;
    const prev = Object.fromEntries((await getDocs(query(collection(db, "results"), where("groupId", "==", gid), where("unitId", "==", unitId))))
      .docs.map((d) => [d.data().uid, d.data()]));
    let batch = writeBatch(db), n = 0;
    for (const sub of subs) {
      const r = buildResult({ sub, content, keys, manual: prev[sub.uid]?.manual || {}, showCorrect: T.showCorrect, factors: factorsFor(sub.uid, unitId) });
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
  const openTotal = exs.filter((ex) => !isAuto(ex)).reduce((n, ex) => n + ex.items.filter((it) => !it.plain).length, 0);
  const rows = T.students.map((st) => {
    const s = subBy[st.uid], r = T.results[st.uid];
    const filled = s ? exs.reduce((n, ex) => n + (ex.items || []).filter((it) => String(s.answers?.[ex.id]?.[it.id] ?? "").trim()).length, 0) : 0;
    const auto = s ? gradeAuto(data.content, s.answers, data.keys) : null;
    const f = factorsFor(st.uid, u.id), fN = Object.keys(f).length;
    const nDone = s ? exs.filter((ex) => doneMap(s.answers)[ex.id]).length : 0;
    const status = !s ? `<span class="pill off">not started</span>` : s.status === "submitted" ? `<span class="pill on">submitted</span>` : s.returnedAt ? `<span class="pill warn">returned</span>` : `<span class="pill warn">draft</span>`;
    const openDone = r ? openTotal - (r.manualPending ?? openTotal) : 0;
    return `<tr class="${T.selected === st.uid ? "sel" : ""}">
      <td><b>${esc(st.name)}</b><br><small class="muted">${esc(st.email)}</small></td>
      <td>${status}</td>
      <td>${s ? fmtTime(s.status === "submitted" ? s.submittedAt : s.updatedAt) : ""}</td>
      <td class="num">${filled} / ${totalItems}</td>
      <td class="num">${s ? `${nDone} / ${exs.length}` : ""}</td>
      <td class="num">${auto ? `${fN ? adjustedAuto(auto, f) : auto.score} / ${auto.max}` : ""}${fN ? `<br><span class="pill warn" title="Absent: ${fN} in-class ${fN === 1 ? "exercise counts" : "exercises count"} ${Math.round(ABSENT_FACTOR * 100)}%">absent · ${fN}</span>` : ""}</td>
      <td class="num">${openTotal ? `${openDone} / ${openTotal}` : "—"}</td>
      <td class="num">${r ? `<b>${r.score} / ${r.max}</b>` : ""}</td>
      <td>${s ? `<div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn small" data-act="select-student" data-uid="${esc(st.uid)}">Open</button>${returnBtn(s)}</div>` : ""}</td>
    </tr>`;
  }).join("");
  return head + `
    <p class="muted">The table updates live while students work. “Done” shows how many exercises the student has marked as done. “Auto” is a preliminary score against the keys (students do not see it until you release the results); for a student who was absent, in-class exercises of that lesson count ${Math.round(ABSENT_FACTOR * 100)}%. “Open” shows how many open answers you have already marked.</p>
    <table class="t"><tr><th>Student</th><th>Status</th><th>Last change</th><th>Answered</th><th>Done</th><th>Auto</th><th>Open</th><th>Total</th><th></th></tr>
    ${rows || `<tr><td colspan="9" class="muted">There are no students in this group yet.</td></tr>`}</table>
    <div id="detail">${T.selected ? studentDetail(T.selected, data) : ""}</div>`;
}

// "Return for revision": a submitted work becomes editable again; on a draft it sends the student a comment.
// Not possible after the whole unit has been checked (results released): hide those results first.
function returnBtn(s) {
  if (!s) return "";
  if (group()?.releasedUnits.includes(T.unitId))
    return `<button class="btn small" disabled title="The whole unit has been checked. Click “Hide” in Access &amp; results first.">Return for revision</button>`;
  return `<button class="btn small" data-act="return" data-uid="${esc(s.uid)}" title="${s.status === "submitted" ? "The student can change the answers and submit again" : "The student sees your comment at the top of the unit"}">Return for revision</button>`;
}

function studentDetail(uid, data) {
  const st = T.students.find((s) => s.uid === uid);
  const sub = T.subs.find((s) => s.uid === uid);
  if (!st || !sub) return "";
  const r = T.results[uid];
  const auto = gradeAuto(data.content, sub.answers, data.keys);
  const u = unit(), n = unitNum(u);
  const f = factorsFor(uid, u.id);
  const body = data.content.sections.map((sec, i) => {
    const exs = (sec.blocks || []).filter((b) => b.type === "exercise");
    if (!exs.length) return "";
    return `<h3>${n}.${i + 1} ${esc(sec.title)}</h3>` + exs.map((ex, j) => renderExercise(ex, {
      num: `${n}.${i + 1}.${j + 1}`,
      answers: sub.answers?.[ex.id] || {},
      speech: sub.answers?._speech?.[ex.id],
      readOnly: true,
      auto: isAuto(ex) ? auto.items[ex.id] : undefined,
      factor: f[ex.id],
      manual: r?.manual?.[ex.id],
      grading: isManual(ex),
      itemExtra: T.exr?.[uid]?.feedback?.[ex.id] ? (itemId) => feedbackHTML(T.exr[uid].feedback[ex.id][itemId], { checkedAt: fmtTime(T.exr[uid].feedbackAt?.[ex.id]) }) : null,
    })).join("");
  }).join("");
  // switching between students without going back to the table
  const withWork = T.students.filter((x) => T.subs.some((s) => s.uid === x.uid));
  const k = withWork.findIndex((x) => x.uid === uid), pv = withWork[k - 1], nx = withWork[k + 1];
  const switcher = `<div class="viewas-bar on" style="margin:0 0 12px">
      <button class="btn small" data-act="select-student" data-uid="${esc(pv?.uid || "")}" ${pv ? "" : "disabled"} title="Previous student">Previous</button>
      <select id="works-student">${withWork.map((x) => `<option value="${esc(x.uid)}" ${x.uid === uid ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <button class="btn small" data-act="select-student" data-uid="${esc(nx?.uid || "")}" ${nx ? "" : "disabled"} title="Next student">Next</button>
      <span class="muted" style="font-size:13px">${k + 1} of ${withWork.length} students with work in this unit</span></div>`;
  return `<div class="box">
    ${switcher}
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${esc(st.name)} <span class="muted" style="font-size:16px">· auto-checked ${Object.keys(f).length ? adjustedAuto(auto, f) : auto.score}/${auto.max}</span></h2>
      <div class="row">
        ${returnBtn(sub)}
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
    const r = buildResult({ sub, content: data.content, keys: data.keys, manual, showCorrect, factors: factorsFor(uid, T.unitId) });
    await setDoc(doc(db, "results", subId(T.unitId, uid)), { ...r, gradedAt: serverTimestamp() });
    document.activeElement?.blur();
    toast("Marks saved.");
    render(true);
  });
}

// ================================================================== Analytics
// Students work exercise by exercise and seldom submit a whole unit, so all their answers count here
// (drafts included); a student is counted in an exercise once they have answered at least one of its questions.
// The tick "only units submitted as a whole" gives the old, stricter view.
function viewStats() {
  const g = group(), u = unit();
  const head = pageHead("Teaching tools", "Analytics",
    g && u ? `Unit ${unitNum(u)} · ${esc(u.title)} — group ${esc(g.name)}` : "")
    + `<label class="row"><input type="checkbox" id="stats-submitted" ${T.statsOnlySubmitted ? "checked" : ""}> only units submitted as a whole</label>`;
  if (!g || !u) return head + `<div class="box">Choose a group and a unit at the top of the page.</div>`;
  const data = T.unitData[u.id];
  if (!data?.content) return head + `<p class="muted">No data.</p>`;
  const inGroup = new Set(T.students.map((s) => s.uid));
  const subs = T.subs.filter((s) => inGroup.has(s.uid) && (!T.statsOnlySubmitted || s.status === "submitted"));
  const nameOf = Object.fromEntries(T.students.map((s) => [s.uid, s.name]));
  const autoEx = exercisesOf(data.content).filter((ex) => isAuto(ex) && ex.items?.length);
  const nums = exerciseNumbers(data.content, unitNum(u));
  const started = (s, ex) => (ex.items || []).some((it) => String(s.answers?.[ex.id]?.[it.id] ?? "").trim());
  if (!subs.length) return head + `<div class="box">${T.statsOnlySubmitted ? "No student has submitted this unit as a whole yet. Untick the box to see all answers." : "No student has answered anything in this unit yet."}</div>`;

  // per student and exercise: only the exercises the student has started
  const perStudent = subs.map((s) => {
    const byEx = {}; let score = 0, max = 0, nEx = 0;
    for (const ex of autoEx) {
      if (!started(s, ex)) { byEx[ex.id] = null; continue; }
      const r = gradeExercise(ex, s.answers?.[ex.id] || {}, data.keys?.[ex.id] || {});
      const n = ex.items.length;
      byEx[ex.id] = { pct: Math.round((100 * r.score) / n), items: r.items };
      score += r.score; max += n; nEx++;
    }
    return { s, byEx, score, max, nEx, pct: max ? Math.round((100 * score) / max) : null };
  });
  const active = perStudent.filter((p) => p.nEx);
  if (!active.length) return head + `<div class="box">Students have answered only open questions so far: there is nothing to check against the keys yet. Open answers are in <a href="#tools/works">Student work</a> and on the Progress pages.</div>`;
  active.sort((x, y) => x.pct - y.pct);

  // per question, among the students who started the exercise
  const items = [];
  for (const ex of autoEx) {
    const who = active.filter((p) => p.byEx[ex.id]);
    if (!who.length) continue;
    for (const it of ex.items) {
      let ok = 0; const wrong = {};
      for (const p of who) {
        const r = p.byEx[ex.id].items[it.id];
        if (r?.ok) ok++;
        else { const w = norm(r?.given ?? "") || "(blank)"; wrong[w] = (wrong[w] || 0) + 1; }
      }
      items.push({ ex, it, key: data.keys?.[ex.id]?.[it.id], ok, n: who.length, pct: Math.round((100 * ok) / who.length), wrong: Object.entries(wrong).sort((a, b) => b[1] - a[1]) });
    }
  }
  const avg = Math.round(active.reduce((n, p) => n + p.pct, 0) / active.length);
  const exUsed = autoEx.filter((ex) => active.some((p) => p.byEx[ex.id]));
  const exPct = Object.fromEntries(exUsed.map((ex) => { const v = active.map((p) => p.byEx[ex.id]?.pct).filter((x) => x !== undefined); return [ex.id, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]; }));
  const hardestEx = [...exUsed].sort((a, b) => exPct[a.id] - exPct[b.id])[0];
  // a question counts as "difficult" only when enough students have answered it
  const minN = Math.min(3, Math.max(...items.map((x) => x.n)));
  const hardest = items.filter((x) => x.n >= minN).sort((a, b) => a.pct - b.pct || b.n - a.n).slice(0, 10);
  const openEx = exercisesOf(data.content).filter((ex) => isManual(ex));
  const openItems = openEx.reduce((n, ex) => n + ex.items.filter((it) => !it.plain).length, 0);
  const openAnswered = subs.reduce((n, s) => n + openEx.reduce((m, ex) => m + ex.items.filter((it) => !it.plain && String(s.answers?.[ex.id]?.[it.id] ?? "").trim()).length, 0), 0);

  const wrongHTML = (w) => w.slice(0, 3).map(([ans, c]) => `“${esc(ans)}” ×${c}`).join(", ");
  const itemRow = (x) => `<tr>
      <td><b>${esc(nums[x.ex.id] || "")}</b> ${esc(x.ex.title)}<br><small class="muted">${esc(KIND_LABEL[x.ex.kind])}</small></td>
      <td>${esc(x.it.id)}. ${String(x.it.text || "").replace("___", "_____").replace(/<[^>]*>/g, "").slice(0, 90)}</td>
      <td><span class="keyhint" style="margin:0">${esc(keyText(x.key))}</span></td>
      <td class="num">${x.pct}% <small class="muted">of ${x.n}</small><div class="bar"><i style="width:${x.pct}%;background:${heat(x.pct)}"></i></div></td>
      <td class="wrong-list">${wrongHTML(x.wrong)}</td></tr>`;

  return head + `
    <p class="muted">Drafts are included: a student is counted in an exercise as soon as they have answered at least one of its questions. Open answers (translations, sentences, letters) are not checked against keys and are not in these figures.</p>
    <div class="cards">
      <div class="card"><b>${active.length} / ${T.students.length}</b><span>students with answers to check</span></div>
      <div class="card"><b>${avg}%</b><span>average score in the exercises they did</span></div>
      <div class="card"><b>${hardestEx ? exPct[hardestEx.id] + "%" : "—"}</b><span>most difficult exercise${hardestEx ? `: ${esc(nums[hardestEx.id] || "")} ${esc(hardestEx.title)}` : ""}</span></div>
      ${openItems ? `<div class="card"><b>${openAnswered}</b><span>open answers written</span></div>` : ""}
    </div>
    <h3>Questions students found most difficult</h3>
    <table class="t"><tr><th>Exercise</th><th>Question</th><th>Key</th><th>Correct</th><th>Most common mistakes</th></tr>${hardest.map(itemRow).join("")}</table>

    <h3>Results by student and exercise</h3>
    <p class="muted" style="font-size:13px">“—” – the student has not started the exercise. The total counts only the exercises the student has started.</p>
    <div class="tscroll"><table class="t stats-t"><tr><th>Student</th><th>Total</th>${exUsed.map((ex) => `<th title="${esc(ex.title)}">${esc(nums[ex.id] || ex.title.slice(0, 10))}</th>`).join("")}<th></th></tr>
    <tr class="muted"><td><i>Group</i></td><td class="num"><b>${avg}%</b></td>${exUsed.map((ex) => `<td class="heat num" style="background:${heat(exPct[ex.id], true)}"><b>${exPct[ex.id]}%</b></td>`).join("")}<td></td></tr>
    ${active.map((p) => `<tr><td>${esc(nameOf[p.s.uid] || p.s.uid)}${p.s.status === "submitted" ? ` <span class="pill on">submitted</span>` : ""}</td>
      <td class="num"><b>${p.score}/${p.max}</b> (${p.pct}%)</td>
      ${exUsed.map((ex) => { const c = p.byEx[ex.id]; return `<td class="heat num" style="background:${heat(c?.pct, true)}">${c ? c.pct + "%" : "—"}</td>`; }).join("")}
      <td><button class="btn small" data-act="view-unit-as" data-uid="${esc(p.s.uid)}" title="Open the unit with this student's answers">Answers</button></td></tr>`).join("")}
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
    <td>${u.status === "soon" ? "" : `<button class="btn small" data-act="docx" data-unit="${esc(u.id)}" data-ver="student" title="Student's Book in Word">Student .docx</button>
      <button class="btn small" data-act="docx" data-unit="${esc(u.id)}" data-ver="teacher" title="Teacher's Book in Word, with keys and notes">Teacher .docx</button>`}
      <button class="btn small danger" data-act="delete-unit" data-unit="${esc(u.id)}">Delete</button></td></tr>`).join("");
  return pageHead("Teaching tools", "Course content", "Units are imported from a JSON file that you keep on your computer.") + `
  <div class="box">
    <h3 style="margin-top:0">Import units from JSON</h3>
    <p class="muted">Keep the course file on your computer, not in the public repository. On import, the <code>answer</code> fields are removed from the exercises and stored separately as keys, and <code>teacher-note</code> blocks become teaching notes. Students receive neither.
    Importing a unit with an existing <code>id</code> replaces it; students' answers are kept.</p>
    <div class="row"><input type="file" id="import-file" accept=".json,application/json"></div>
    <textarea class="json" id="import-text" placeholder='{"units":[{"id":"u1","order":1,"title":"…","sections":[…]}]}'></textarea>
    <div class="row"><button class="btn primary" data-act="import" id="import-btn">Import</button><span id="import-status" class="muted">${T.importStatus || ""}</span></div>
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
    else if (b.kind === "open" && answer) keys[rest.id] = answer;   // model answer, teacher only
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

function setImportStatus(html) {
  T.importStatus = html;
  const el = $("#import-status");
  if (el) el.innerHTML = html;
}
async function importCourse() {
  const btn = $("#import-btn");
  if (btn) btn.disabled = true;
  setImportStatus("Importing…");
  // if the database does not confirm the import, say so instead of waiting silently
  const slow = setTimeout(() => setImportStatus("<b>Still waiting for the database…</b> Check the internet connection. If this message stays, reload the page and import again."), 20000);
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
    // the page may already have been redrawn by the database update: the field can be gone
    const ta = $("#import-text"); if (ta) ta.value = "";
    const summary = parts.filter((p) => p.content).map((p, i) => {
      const u = list[parts.indexOf(p)];
      const nEx = p.content.sections.reduce((n, sec) => n + sec.blocks.filter((b) => b.type === "exercise" || b.numbered).length, 0);
      return `Unit ${u.order || i + 1}: ${p.content.sections.length} ${p.content.sections.length === 1 ? "section" : "sections"}, ${nEx} exercises`;
    }).join("; ");
    setImportStatus(`<b style="color:var(--ok)">✓ Imported ${parts.length} units at ${fmtTime(new Date())}.</b> ${esc(summary)}`);
    toast(`Units imported: ${parts.length}`);
    ctxKey = ""; subscribeCtx(); render(true);
  });
  clearTimeout(slow);
  if (btn) btn.disabled = false;
  if (T.importStatus === "Importing…") setImportStatus(`<b style="color:var(--bad)">The import did not work:</b> ${esc(T.lastError || "unknown error")}`);
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
  // the list is refreshed every time the page is opened (new students may have registered meanwhile)
  if (!T.usersLoaded || Date.now() - (T.usersAt || 0) > 10000) setTimeout(loadAllUsers, 0);
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
  <table class="t"><tr><th>Name</th><th>Email</th><th>Group</th><th></th></tr>
  ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-move="${esc(u.uid)}">${T.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === u.groupId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></td>
    <td><button class="btn small danger" data-act="remove-student" data-uid="${esc(u.uid)}">Remove from course</button></td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">${T.usersLoaded ? "No students" : "Loading…"}</td></tr>`}</table>
  <p class="muted">Removing a student deletes their profile and all their answers, marks and test attempts. The student can no longer open the course with this account.</p>`;
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
  T.usersAt = Date.now();      // also after an error, so that the page does not retry in a loop
  render(true);
}

// Removing a student: their work first, the profile last (if something fails, the student is still listed and the teacher can try again).
// The sign-in account itself stays in Firebase Authentication; without a profile it cannot open any unit.
async function removeStudent(uid) {
  const st = T.users.find((u) => u.uid === uid);
  if (!st) return;
  const gname = T.groups.find((g) => g.id === st.groupId)?.name || st.groupId;
  if (!confirm(`Remove ${st.name} (${st.email}, group ${gname}) from the course?\n\nTheir profile and all their answers, marks and test attempts will be deleted. This cannot be undone.`)) return;
  await guard(async () => {
    const colls = ["submissions", "exerciseResults", "results", "testAttempts", "testResults"];
    const snaps = await Promise.all(colls.map((c) => getDocs(query(collection(db, c), where("uid", "==", uid)))));
    const refs = snaps.flatMap((sn, i) => sn.docs.map((d) => doc(db, colls[i], d.id)));
    let batch = writeBatch(db), n = 0;
    for (const r of refs) {
      batch.delete(r);
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    await batch.commit();
    await deleteDoc(doc(db, "users", uid));
    if (T.selected === uid) T.selected = null;
    toast(`${st.name} has been removed from the course.`);
    await loadAllUsers();
  });
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
