// Кабинет преподавателя: доступ к юнитам по группам, включение проверки,
// ручная проверка открытых ответов, аналитика, импорт контента, группы.
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, orderBy,
  writeBatch, arrayUnion, arrayRemove, serverTimestamp,
} from "./fb.js";
import { COURSE_TITLE } from "./firebase-config.js";
import {
  esc, renderBlocks, renderExercise, exercisesOf, isAuto, gradeAuto, buildResult, keyText, norm,
  fmtTime, friendlyError, authFormHTML, wireAuthForm, subId, itemMax, KIND_LABEL,
} from "./common.js";

const $ = (s) => document.querySelector(s);
const ls = {
  get: (k, d) => { try { return localStorage.getItem("t:" + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("t:" + k, v); } catch {} },
};
const T = {
  user: null, groups: [], units: [], users: [],
  gid: ls.get("gid", ""), unitId: ls.get("unit", ""), tab: ls.get("tab", "access"),
  students: [], subs: [], results: {},
  unitData: {},          // unitId -> {content, keys, notes}
  selected: null,        // uid выбранного студента во вкладке «Работы»
  preview: null,         // unitId для предпросмотра
  includeDrafts: false,
  showCorrect: ls.get("showCorrect", "1") === "1",
  unsub: [], ctxUnsub: [],
};

document.querySelectorAll("[data-course-title]").forEach((el) => (el.textContent = COURSE_TITLE));
function toast(t, ms = 3500) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = t;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast("Ошибка: " + friendlyError(e), 6000); }
}

// ------------------------------------------------------------------ auth
$("#auth-screen").innerHTML = authFormHTML({ title: "Кабинет преподавателя", allowRegister: false });
wireAuthForm($("#auth-screen"), {
  async login(f) { await signInWithEmailAndPassword(auth, f.email.trim(), f.password); },
  async reset(f) { await sendPasswordResetEmail(auth, f.email.trim()); return "Письмо отправлено."; },
});
$("#logout").addEventListener("click", () => signOut(auth));
$("#logout2").addEventListener("click", (e) => { e.preventDefault(); signOut(auth); });

onAuthStateChanged(auth, async (user) => {
  T.unsub.forEach((u) => u()); T.unsub = [];
  T.ctxUnsub.forEach((u) => u()); T.ctxUnsub = [];
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
    T.groups = snap.docs.map((d) => ({ id: d.id, openUnits: [], releasedUnits: [], ...d.data() }))
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

// ------------------------------------------------------------------ контекст (группа + юнит)
function fillCtx() {
  $("#ctx-group").innerHTML = T.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === T.gid ? "selected" : ""}>${esc(g.name || g.id)} (${esc(g.id)})</option>`).join("") || `<option value="">— нет групп —</option>`;
  $("#ctx-unit").innerHTML = T.units.map((u) => `<option value="${esc(u.id)}" ${u.id === T.unitId ? "selected" : ""}>${esc(u.title)}</option>`).join("") || `<option value="">— нет юнитов —</option>`;
}
$("#ctx-group").addEventListener("change", (e) => { T.gid = e.target.value; ls.set("gid", T.gid); T.selected = null; subscribeCtx(); render(); });
$("#ctx-unit").addEventListener("change", (e) => { T.unitId = e.target.value; ls.set("unit", T.unitId); T.selected = null; subscribeCtx(); render(); });

let ctxKey = "";
function subscribeCtx() {
  const key = T.gid + "|" + T.unitId;
  if (key === ctxKey) return;
  ctxKey = key;
  T.ctxUnsub.forEach((u) => u()); T.ctxUnsub = [];
  T.students = []; T.subs = []; T.results = {};
  if (!T.gid) return;
  // Студенты группы, их работы и результаты — в реальном времени
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

// ------------------------------------------------------------------ вкладки
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  T.tab = b.dataset.tab; ls.set("tab", T.tab); render();
});
const group = () => T.groups.find((g) => g.id === T.gid);
const unit = () => T.units.find((u) => u.id === T.unitId);

function render() {
  if (!T.user || $("#app").hidden) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === T.tab));
  // не перерисовываем вкладку, пока преподаватель печатает оценку/комментарий
  const a = document.activeElement;
  if (a && $("#view").contains(a) && (a.matches(".g-score,.g-comment,textarea.json,input[type=text],input:not([type])"))) return;
  const v = $("#view");
  const views = { access: viewAccess, works: viewWorks, stats: viewStats, content: viewContent, groups: viewGroups };
  v.innerHTML = (views[T.tab] || viewAccess)();
}

// ================================================================== 1. Доступ и проверка
function viewAccess() {
  const g = group();
  if (!g) return `<div class="box">Сначала создайте группу во вкладке «Группы и студенты».</div>`;
  const rows = T.units.map((u) => {
    const soon = u.status === "soon";
    const open = g.openUnits.includes(u.id), rel = g.releasedUnits.includes(u.id);
    return `<tr>
      <td>${esc(u.title)}<br><small class="muted">${esc(u.id)}</small></td>
      <td>${soon ? `<span class="pill off">в разработке</span>` : `<span class="pill ${open ? "on" : "off"}">${open ? "открыт" : "закрыт"}</span>
        <button class="btn small" data-act="toggle-open" data-unit="${esc(u.id)}">${open ? "Закрыть" : "Открыть"}</button>`}</td>
      <td>${soon ? "" : `<span class="pill ${rel ? "on" : "off"}">${rel ? "проверка включена" : "выключена"}</span>
        ${rel
          ? `<button class="btn small" data-act="release" data-unit="${esc(u.id)}" title="Пересчитать результаты (например, для поздно сданных работ)">Перепроверить</button>
             <button class="btn small danger" data-act="unrelease" data-unit="${esc(u.id)}">Скрыть результаты</button>`
          : `<button class="btn small good" data-act="release" data-unit="${esc(u.id)}" ${open ? "" : "disabled"}>Включить проверку</button>`}`}</td>
    </tr>`;
  }).join("");
  return `<h2>Доступ и проверка — группа «${esc(g.name || g.id)}»</h2>
  <p class="muted">Изменения видны студентам сразу, без перезагрузки страницы.
  «Включить проверку» проверяет все <b>сданные</b> работы группы по ключам, сохраняет результаты и показывает их студентам. После этого менять ответы нельзя.</p>
  <label class="row"><input type="checkbox" id="show-correct" ${T.showCorrect ? "checked" : ""}> Показывать студентам правильные ответы в их ошибках</label>
  <table><tr><th>Юнит</th><th>Доступ для группы</th><th>Проверка</th></tr>${rows}</table>`;
}

document.addEventListener("change", (e) => {
  if (e.target.id === "show-correct") { T.showCorrect = e.target.checked; ls.set("showCorrect", T.showCorrect ? "1" : "0"); }
  if (e.target.id === "inc-drafts") { T.includeDrafts = e.target.checked; render(); }
  if (e.target.matches("select[data-move]")) guard(async () => {
    await updateDoc(doc(db, "users", e.target.dataset.move), { groupId: e.target.value });
    toast("Студент переведён в группу " + e.target.value);
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
    "unrelease": () => guard(async () => {
      if (!confirm("Скрыть результаты от студентов? Студенты снова смогут править несданные черновики.")) return;
      await updateDoc(doc(db, "groups", T.gid), { releasedUnits: arrayRemove(u) });
    }),
    "select-student": () => { T.selected = b.dataset.uid; T.tab = "works"; ls.set("tab", "works"); render(); $("#detail")?.scrollIntoView({ behavior: "smooth" }); },
    "save-grades": () => saveGrades(b.dataset.uid),
    "return": () => guard(async () => {
      if (!confirm("Вернуть работу студенту на доработку?")) return;
      await updateDoc(doc(db, "submissions", subId(T.unitId, b.dataset.uid)), { status: "draft" });
      toast("Работа возвращена");
    }),
    "import": () => importCourse(),
    "preview": () => { T.preview = u; loadUnitData(u, true).then(render); },
    "delete-unit": () => deleteUnit(u),
    "create-group": () => createGroup(),
    "load-users": () => loadAllUsers(),
  };
  handlers[act]?.();
});

// Проверка выполняется в браузере преподавателя: только он может читать ключи.
async function releaseUnit(gid, unitId) {
  await guard(async () => {
    const { content, keys } = await loadUnitData(unitId, true);
    if (!content) throw new Error("У юнита нет контента.");
    const subs = (await getDocs(query(collection(db, "submissions"), where("groupId", "==", gid), where("unitId", "==", unitId))))
      .docs.map((d) => d.data()).filter((s) => s.status === "submitted");
    const drafts = T.unitId === unitId ? T.subs.filter((s) => s.status === "draft").length : 0;
    if (!confirm(`Проверить и показать результаты?\nСданных работ: ${subs.length}${drafts ? `\nНесданных черновиков: ${drafts} (они не будут проверены и станут недоступны для правки)` : ""}`)) return;
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
    toast(`Готово: проверено работ — ${subs.length}. Студенты уже видят результаты.`);
  });
}

// ================================================================== 2. Работы студентов
function viewWorks() {
  const g = group(), u = unit();
  if (!g || !u) return `<div class="box">Выберите группу и юнит вверху страницы.</div>`;
  const data = T.unitData[u.id];
  if (!data) return `<p class="muted">Загрузка…</p>`;
  if (!data.content) return `<div class="box">У юнита «${esc(u.title)}» нет контента.</div>`;
  const subBy = Object.fromEntries(T.subs.map((s) => [s.uid, s]));
  const exs = exercisesOf(data.content);
  const totalItems = exs.reduce((n, ex) => n + (ex.items || []).length, 0);
  const rows = T.students.map((st) => {
    const s = subBy[st.uid], r = T.results[st.uid];
    const filled = s ? exs.reduce((n, ex) => n + (ex.items || []).filter((it) => String(s.answers?.[ex.id]?.[it.id] ?? "").trim()).length, 0) : 0;
    const auto = s ? gradeAuto(data.content, s.answers, data.keys) : null;
    const status = !s ? `<span class="pill off">не начинал</span>` : s.status === "submitted" ? `<span class="pill on">сдано</span>` : `<span class="pill warn">черновик</span>`;
    const openTotal = exs.filter((ex) => !isAuto(ex)).reduce((n, ex) => n + ex.items.length, 0);
    const openDone = r ? openTotal - (r.manualPending ?? openTotal) : 0;
    return `<tr class="${T.selected === st.uid ? "sel" : ""}">
      <td>${esc(st.name)}<br><small class="muted">${esc(st.email)}</small></td>
      <td>${status}</td>
      <td>${s ? fmtTime(s.status === "submitted" ? s.submittedAt : s.updatedAt) : ""}</td>
      <td class="num">${filled} / ${totalItems}</td>
      <td class="num">${auto ? `${auto.score} / ${auto.max}` : ""}</td>
      <td class="num">${openTotal ? `${openDone} / ${openTotal}` : "—"}</td>
      <td class="num">${r ? `<b>${r.score} / ${r.max}</b>` : ""}</td>
      <td>${s ? `<button class="btn small" data-act="select-student" data-uid="${esc(st.uid)}">Открыть</button>` : ""}</td>
    </tr>`;
  }).join("");
  return `<h2>Работы: «${esc(u.title)}» — группа «${esc(g.name || g.id)}»</h2>
    <p class="muted">Таблица обновляется в реальном времени, пока студенты работают. «Авто» — предварительный подсчёт по ключам (студентам не виден до включения проверки).
    «Открытые» — сколько открытых ответов вы уже оценили.</p>
    <table><tr><th>Студент</th><th>Статус</th><th>Изменено</th><th>Заполнено</th><th>Авто</th><th>Открытые</th><th>Итог</th><th></th></tr>
    ${rows || `<tr><td colspan="8" class="muted">В группе пока нет студентов.</td></tr>`}</table>
    <div id="detail">${T.selected ? studentDetail(T.selected, data) : ""}</div>`;
}

function studentDetail(uid, data) {
  const st = T.students.find((s) => s.uid === uid);
  const sub = T.subs.find((s) => s.uid === uid);
  if (!st || !sub) return "";
  const r = T.results[uid];
  const auto = gradeAuto(data.content, sub.answers, data.keys);
  const body = data.content.sections.map((sec) => {
    const exs = (sec.blocks || []).filter((b) => b.type === "exercise");
    if (!exs.length) return "";
    return `<h3>${esc(sec.title)}</h3>` + exs.map((ex) => renderExercise(ex, {
      answers: sub.answers?.[ex.id] || {},
      readOnly: true,
      auto: isAuto(ex) ? auto.items[ex.id] : undefined,
      manual: r?.manual?.[ex.id],
      grading: !isAuto(ex),
    })).join("");
  }).join("");
  return `<div class="box">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0;border:0">${esc(st.name)} — ${auto.score}/${auto.max} автопроверка</h2>
      <div class="row">
        ${sub.status === "submitted" && !group()?.releasedUnits.includes(T.unitId) ? `<button class="btn small" data-act="return" data-uid="${esc(uid)}">Вернуть на доработку</button>` : ""}
        <button class="btn small primary" data-act="save-grades" data-uid="${esc(uid)}">Сохранить оценки</button>
      </div>
    </div>
    <p class="muted">Зелёным — верно, красным — ошибка (→ правильный ответ). Для открытых ответов поставьте балл и комментарий, затем «Сохранить оценки».
    Если проверка уже включена, студент увидит оценку сразу.</p>
    ${body}
    <div class="row"><button class="btn primary" data-act="save-grades" data-uid="${esc(uid)}">Сохранить оценки</button></div>
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
    toast("Оценки сохранены");
    render();
  });
}

// ================================================================== 3. Аналитика
function viewStats() {
  const g = group(), u = unit();
  if (!g || !u) return `<div class="box">Выберите группу и юнит вверху страницы.</div>`;
  const data = T.unitData[u.id];
  if (!data?.content) return `<p class="muted">Нет данных.</p>`;
  const subs = T.subs.filter((s) => s.status === "submitted" || T.includeDrafts);
  const exs = exercisesOf(data.content);
  const nameOf = Object.fromEntries(T.students.map((s) => [s.uid, s.name]));
  const header = `<h2>Аналитика: «${esc(u.title)}» — группа «${esc(g.name || g.id)}»</h2>
    <label class="row"><input type="checkbox" id="inc-drafts" ${T.includeDrafts ? "checked" : ""}> учитывать несданные черновики</label>`;
  if (!subs.length) return header + `<div class="box">Пока нет ${T.includeDrafts ? "работ" : "сданных работ"}.</div>`;

  // --- по вопросам
  const items = [];
  for (const ex of exs) {
    if (!isAuto(ex)) continue;
    for (const it of ex.items) {
      const key = data.keys?.[ex.id]?.[it.id];
      let ok = 0; const wrong = {};
      for (const s of subs) {
        const given = s.answers?.[ex.id]?.[it.id] ?? "";
        if (norm(given) && (Array.isArray(key) ? key : [key]).some((k) => norm(k) === norm(given))) ok++;
        else { const w = norm(given) || "(пусто)"; wrong[w] = (wrong[w] || 0) + 1; }
      }
      items.push({ ex, it, key, ok, n: subs.length, pct: Math.round((100 * ok) / subs.length), wrong: Object.entries(wrong).sort((a, b) => b[1] - a[1]) });
    }
  }
  // --- по студентам и упражнениям
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

  const wrongHTML = (w) => w.slice(0, 3).map(([ans, c]) => `«${esc(ans)}» ×${c}`).join(", ");
  const itemRow = (x) => `<tr>
      <td>${esc(x.ex.title)}<br><small class="muted">${esc(KIND_LABEL[x.ex.kind])}</small></td>
      <td>${esc(x.it.id)}. ${x.it.text.replace("___", "_____").replace(/<[^>]*>/g, "").slice(0, 90)}</td>
      <td><span class="keyhint">${esc(keyText(x.key))}</span></td>
      <td class="num">${x.pct}%<div class="bar"><i style="width:${x.pct}%;background:${heat(x.pct)}"></i></div></td>
      <td class="wrong-list">${wrongHTML(x.wrong)}</td></tr>`;
  const hardest = [...items].sort((a, b) => a.pct - b.pct).slice(0, 10);

  return header + `
    <div class="cards">
      <div class="card"><b>${subs.length} / ${T.students.length}</b><span>работ в выборке / студентов</span></div>
      <div class="card"><b>${avg}%</b><span>средний результат автопроверки</span></div>
      <div class="card"><b>${hardest[0] ? hardest[0].pct + "%" : "—"}</b><span>самый трудный вопрос</span></div>
      ${openItems ? `<div class="card"><b>${graded} / ${openItems * subs.length}</b><span>открытых ответов оценено</span></div>` : ""}
    </div>
    <h3>Вопросы, вызвавшие наибольшие трудности</h3>
    <table><tr><th>Упражнение</th><th>Вопрос</th><th>Ключ</th><th>Верно</th><th>Частые ошибки</th></tr>${hardest.map(itemRow).join("")}</table>

    <h3>Результаты по студентам и упражнениям</h3>
    <div style="overflow-x:auto"><table><tr><th>Студент</th><th>Итого</th>${autoEx.map((ex) => `<th title="${esc(ex.title)}">${esc(ex.title.slice(0, 22))}</th>`).join("")}<th></th></tr>
    ${perStudent.map((p) => `<tr><td>${esc(nameOf[p.s.uid] || p.s.uid)}${p.s.status !== "submitted" ? ` <span class="pill warn">черновик</span>` : ""}</td>
      <td class="num"><b>${p.a.score}/${p.a.max}</b> (${p.pct}%)</td>
      ${autoEx.map((ex) => `<td class="heat" style="background:${heat(p.byEx[ex.id], true)}">${p.byEx[ex.id] ?? "—"}%</td>`).join("")}
      <td><button class="btn small" data-act="select-student" data-uid="${esc(p.s.uid)}">Ответы</button></td></tr>`).join("")}
    </table></div>

    <details><summary>Все вопросы по порядку (${items.length})</summary>
    <table><tr><th>Упражнение</th><th>Вопрос</th><th>Ключ</th><th>Верно</th><th>Ответы с ошибками</th></tr>${items.map(itemRow).join("")}</table></details>`;
}
function heat(p, light) {
  if (p === null || p === undefined) return "transparent";
  const c = p >= 80 ? [31, 107, 59] : p >= 50 ? [138, 106, 31] : [140, 59, 59];
  return light ? `rgba(${c.join(",")},.15)` : `rgb(${c.join(",")})`;
}

// ================================================================== 4. Контент и ключи
function viewContent() {
  const rows = T.units.map((u) => `<tr>
    <td class="num">${esc(u.order)}</td><td><code>${esc(u.id)}</code></td><td>${esc(u.title)}</td>
    <td>${u.status === "soon" ? `<span class="pill off">в разработке</span>` : `<span class="pill on">${(u.sections || []).length} разделов</span>`}</td>
    <td>${u.status === "soon" ? "" : `<button class="btn small" data-act="preview" data-unit="${esc(u.id)}">Просмотр с ключами</button>`}
        <button class="btn small danger" data-act="delete-unit" data-unit="${esc(u.id)}">Удалить</button></td></tr>`).join("");
  let preview = "";
  const pd = T.preview && T.unitData[T.preview];
  if (pd?.content) {
    const u = T.units.find((x) => x.id === T.preview);
    preview = `<div class="box"><h2>${esc(u?.title || T.preview)} — версия преподавателя</h2>` +
      pd.content.sections.map((s) => {
        const blocks = [...s.blocks];
        for (const n of [...(pd.notes[s.id] || [])].reverse()) blocks.splice(n.at, 0, { type: "teacher-note", html: n.html });
        return `<h2>${esc(s.title)}</h2>` + renderBlocks(blocks, (ex) => ({ key: pd.keys[ex.id] || {}, readOnly: true }));
      }).join("") + `</div>`;
  }
  return `<h2>Контент и ключи</h2>
  <div class="box">
    <h3 style="margin-top:0">Импорт курса из JSON</h3>
    <p class="muted">Файл курса хранится у вас локально (не в публичном репозитории!). При импорте поля <code>answer</code> вырезаются из заданий
    и сохраняются отдельно в <code>answerKeys</code>, а блоки <code>teacher-note</code> — в заметки преподавателя. Студенты не получают ни то, ни другое.
    Повторный импорт юнита с тем же <code>id</code> заменяет его (ответы студентов сохраняются).</p>
    <div class="row"><input type="file" id="import-file" accept=".json,application/json"></div>
    <textarea class="json" id="import-text" placeholder='{"units":[{"id":"u1","order":1,"title":"Unit 1","sections":[...]}]}'></textarea>
    <div class="row"><button class="btn primary" data-act="import">Импортировать</button></div>
  </div>
  <table><tr><th>#</th><th>id</th><th>Юнит</th><th>Состояние</th><th></th></tr>${rows || `<tr><td colspan="5" class="muted">Курс пуст — импортируйте JSON.</td></tr>`}</table>
  ${preview}`;
}

function splitUnit(u) {
  if (!u.id || !/^[A-Za-z0-9_-]+$/.test(u.id)) throw new Error(`Некорректный id юнита: «${u.id}» (допустимы латиница, цифры, - и _)`);
  if (!u.title) throw new Error(`У юнита ${u.id} нет title`);
  const hasContent = Array.isArray(u.sections) && u.sections.some((s) => (s.blocks || []).length);
  const meta = {
    title: u.title, order: Number(u.order ?? 0),
    status: u.status || (hasContent ? "ready" : "soon"),
    sections: (u.sections || []).map((s) => ({ id: s.id, title: s.title })),
  };
  if (!hasContent) return { meta };
  const keys = {}, notes = {}, seen = new Set();
  const sections = u.sections.map((s) => {
    if (!s.id || !s.title) throw new Error(`Раздел без id/title в юните ${u.id}`);
    const blocks = [];
    for (const b of s.blocks || []) {
      if (b.type === "teacher-note") { (notes[s.id] ??= []).push({ at: blocks.length, html: b.html }); continue; }
      if (b.type !== "exercise") { blocks.push(b); continue; }
      if (!b.id || seen.has(b.id)) throw new Error(`Повторяющийся или пустой id упражнения: «${b.id}» (${u.id})`);
      seen.add(b.id);
      if (!KIND_LABEL[b.kind]) throw new Error(`Упражнение ${b.id}: неизвестный kind «${b.kind}» (gap | match | mcq | open)`);
      keys[b.id] = {};
      const items = (b.items || []).map((it) => {
        const { answer, ...rest } = it;
        if (it.id === undefined) throw new Error(`Упражнение ${b.id}: у пункта нет id`);
        rest.id = String(it.id);
        if (b.kind !== "open") {
          if (answer === undefined || answer === "") throw new Error(`Упражнение ${b.id}, пункт ${it.id}: нет answer`);
          keys[b.id][rest.id] = answer;
        }
        return rest;
      });
      blocks.push({ ...b, items });
    }
    return { id: s.id, title: s.title, blocks };
  });
  return { meta, content: { sections }, keys: { exercises: keys, notes } };
}

async function importCourse() {
  await guard(async () => {
    const raw = $("#import-text").value.trim();
    if (!raw) throw new Error("Вставьте JSON или выберите файл.");
    let json;
    try { json = JSON.parse(raw); } catch (e) { throw new Error("Ошибка в JSON: " + e.message); }
    const list = json.units || [json];
    const parts = list.map(splitUnit);          // сначала валидируем всё
    const batch = writeBatch(db);
    for (const p of parts) {
      const id = list[parts.indexOf(p)].id;
      batch.set(doc(db, "units", id), p.meta);
      if (p.content) {
        batch.set(doc(db, "unitContent", id), p.content);
        batch.set(doc(db, "answerKeys", id), p.keys);
      }
    }
    await batch.commit();
    for (const l of list) delete T.unitData[l.id];
    $("#import-text").value = "";
    toast(`Импортировано юнитов: ${parts.length}`);
    ctxKey = ""; subscribeCtx(); render();
  });
}

async function deleteUnit(u) {
  if (!confirm(`Удалить юнит «${u}» вместе с ключами? Работы студентов останутся в базе.`)) return;
  await guard(async () => {
    await Promise.all(["units", "unitContent", "answerKeys"].map((c) => deleteDoc(doc(db, c, u))));
    toast("Юнит удалён");
  });
}

// ================================================================== 5. Группы и студенты
function viewGroups() {
  const counts = {};
  T.users.forEach((u) => (counts[u.groupId] = (counts[u.groupId] || 0) + 1));
  const filter = T.groupFilter ?? T.gid;
  const list = T.users.filter((u) => !filter || u.groupId === filter).sort((a, b) => a.name.localeCompare(b.name));
  return `<h2>Группы</h2>
  <div class="box"><div class="row">
    <input id="g-name" placeholder="Название группы, напр. ГМУ-21">
    <input id="g-code" placeholder="Код (необязательно)" style="width:12em">
    <button class="btn primary" data-act="create-group">Создать группу</button>
  </div><p class="muted" style="margin-bottom:0">Код группы студенты вводят при регистрации. Если не указать — будет сгенерирован.</p></div>
  <table><tr><th>Код</th><th>Название</th><th>Студентов</th><th>Открытые юниты</th></tr>
  ${T.groups.map((g) => `<tr><td><code>${esc(g.id)}</code></td><td>${esc(g.name)}</td><td class="num">${T.users.length ? counts[g.id] || 0 : "…"}</td><td>${g.openUnits.map(esc).join(", ")}</td></tr>`).join("")}</table>

  <h2>Студенты</h2>
  <div class="row">Фильтр: <select id="g-filter"><option value="">все группы</option>${T.groups.map((g) => `<option value="${esc(g.id)}" ${filter === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
  <button class="btn small" data-act="load-users">Обновить список</button></div>
  <table><tr><th>Имя</th><th>Email</th><th>Группа</th></tr>
  ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-move="${esc(u.uid)}">${T.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === u.groupId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">${T.usersLoaded ? "Нет студентов" : "Загрузка…"}</td></tr>`}</table>`;
}
document.addEventListener("change", (e) => { if (e.target.id === "g-filter") { T.groupFilter = e.target.value; render(); } });
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab === "groups") loadAllUsers(); });
if (T.tab === "groups") setTimeout(loadAllUsers, 0);

async function loadAllUsers() {
  if (!T.user) return setTimeout(loadAllUsers, 500);
  await guard(async () => {
    const snap = await getDocs(collection(db, "users"));
    T.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    T.usersLoaded = true;
    render();
  });
}

async function createGroup() {
  await guard(async () => {
    const name = $("#g-name").value.trim();
    let code = $("#g-code").value.trim().toUpperCase();
    if (!name) throw new Error("Укажите название группы");
    if (!code) {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      code = "G-" + Array.from(crypto.getRandomValues(new Uint8Array(5)), (x) => abc[x % abc.length]).join("");
    }
    if (!/^[A-Z0-9-]{3,24}$/.test(code)) throw new Error("Код: 3–24 символа, латиница, цифры и дефис");
    if ((await getDoc(doc(db, "groups", code))).exists()) throw new Error("Группа с таким кодом уже есть");
    await setDoc(doc(db, "groups", code), { name, openUnits: [], releasedUnits: [], createdAt: serverTimestamp() });
    toast(`Группа создана. Код для студентов: ${code}`, 8000);
    $("#g-name").value = ""; $("#g-code").value = "";
  });
}
