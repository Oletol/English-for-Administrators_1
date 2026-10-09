// Страница студента: вход/регистрация, навигация по открытым юнитам,
// упражнения с автосохранением черновика, сдача работы, просмотр результатов.
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, doc, getDoc, setDoc, onSnapshot, collection, query, orderBy,
  serverTimestamp,
} from "./fb.js";
import { COURSE_TITLE } from "./firebase-config.js";
import {
  esc, renderBlocks, readInput, fmtTime, friendlyError, authFormHTML, wireAuthForm, subId, exercisesOf, isAuto,
} from "./common.js";

const $ = (s) => document.querySelector(s);
const S = {
  user: null, profile: null, group: null, units: [],
  content: {},   // unitId -> content | null (нет доступа)
  sub: {},       // unitId -> {answers, status, updatedAt, dirty}
  result: {},    // unitId -> result | null
  unsub: [], unitUnsub: {}, resultUnsub: {},
  registering: false,
};
const SAVE_DELAY = 1000;
let saveTimer = null;

document.title = COURSE_TITLE;
document.querySelectorAll("[data-course-title]").forEach((el) => (el.textContent = COURSE_TITLE));

// ------------------------------------------------------------------ auth
$("#auth-screen").innerHTML = authFormHTML({ title: COURSE_TITLE, allowRegister: true });
wireAuthForm($("#auth-screen"), {
  async login(f) { await signInWithEmailAndPassword(auth, f.email.trim(), f.password); },
  async reset(f) {
    await sendPasswordResetEmail(auth, f.email.trim());
    return "Письмо со ссылкой для смены пароля отправлено (проверьте папку «Спам»).";
  },
  async register(f) {
    const name = (f.name || "").trim(), group = (f.group || "").trim().toUpperCase();
    if (!name) throw new Error("Укажите имя.");
    if (!group) throw new Error("Укажите код группы.");
    S.registering = true;
    const cred = await createUserWithEmailAndPassword(auth, f.email.trim(), f.password);
    try {
      // правила Firestore проверят, что группа с таким кодом существует
      await setDoc(doc(db, "users", cred.user.uid), {
        name, email: cred.user.email, groupId: group, createdAt: serverTimestamp(),
      });
    } catch (e) {
      await cred.user.delete().catch(() => {});
      throw new Error("Группа с таким кодом не найдена. Уточните код у преподавателя.");
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
        ? `<div class="panel"><p>Вы вошли как преподаватель. <a href="teacher.html">Открыть кабинет преподавателя →</a></p></div>`
        : `<div class="panel"><p>Профиль студента не найден. Обратитесь к преподавателю.</p></div>`;
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
  Object.assign(S, { profile: null, group: null, units: [], content: {}, sub: {}, result: {} });
}

let groupUnsub = null;
function subscribeGroup(gid) {
  groupUnsub?.();
  groupUnsub = onSnapshot(doc(db, "groups", gid), (snap) => {
    S.group = snap.exists() ? snap.data() : { openUnits: [], releasedUnits: [] };
    $("#me-group").textContent = S.group.name || gid;
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
    const id = key.replace(/^sub:/, "");
    if (!isOpen(id)) { S.unitUnsub[key](); delete S.unitUnsub[key]; delete S.content[id]; delete S.sub[id]; }
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
    renderMain();
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
  const r = route();
  $("#unit-nav").innerHTML = S.units.map((u) => {
    const open = isOpen(u.id), rel = isReleased(u.id);
    const badge = u.status === "soon" ? `<span class="soon">в разработке</span>`
      : !open ? `<span class="soon">🔒 закрыт</span>`
      : rel ? `<span class="soon good">✓ результаты</span>` : "";
    const sections = open && u.status !== "soon"
      ? `<ul class="section-list">${(u.sections || []).map((s) =>
          `<li><a href="#${esc(u.id)}/${esc(s.id)}" class="${r.unit === u.id && (r.section || u.sections[0]?.id) === s.id ? "active" : ""}">${esc(s.title)}</a></li>`).join("")}</ul>`
      : "";
    return `<div class="unit-block ${open ? "" : "locked"}"><div class="unit-title">${esc(u.title)}${badge}</div>${sections}</div>`;
  }).join("");
}

// ------------------------------------------------------------------ main
function renderMain() {
  if (!S.user || !S.group) return;
  const r = route();
  const unit = S.units.find((u) => u.id === r.unit);
  const content = $("#content");
  if (!unit) {
    const open = S.units.filter((u) => isOpen(u.id) && u.status !== "soon");
    $("#topbar-title").textContent = "Добро пожаловать";
    $("#unit-bar").innerHTML = "";
    content.innerHTML = `<h2>Добро пожаловать${S.profile ? ", " + esc(S.profile.name) : ""}!</h2>
      ${open.length ? `<p>Открытые разделы:</p><ul class="items">${open.map((u) => `<li><a href="#${esc(u.id)}">${esc(u.title)}</a></li>`).join("")}</ul>`
        : `<p class="lead">Пока нет открытых разделов. Они появятся здесь автоматически, когда преподаватель их откроет.</p>`}`;
    return;
  }
  $("#topbar-title").textContent = unit.title;
  if (!isOpen(unit.id) || unit.status === "soon") {
    $("#unit-bar").innerHTML = "";
    content.innerHTML = `<div class="locked-msg">🔒 Этот раздел пока закрыт. Он откроется автоматически, когда преподаватель даст доступ вашей группе.</div>`;
    return;
  }
  ensureUnit(unit.id);
  const c = S.content[unit.id], sub = S.sub[unit.id];
  if (c === undefined || !sub) { content.innerHTML = `<p class="muted">Загрузка…</p>`; return; }
  if (c === null) { content.innerHTML = `<div class="locked-msg">Нет доступа к разделу.</div>`; return; }

  const sec = c.sections.find((s) => s.id === r.section) || c.sections[0];
  const released = isReleased(unit.id);
  const res = released ? S.result[unit.id] : undefined;
  const readOnly = released || sub.status === "submitted";

  // если фокус в поле ввода — не перерисовываем (иначе собьём курсор)
  const active = document.activeElement;
  if (content.dataset.view === `${unit.id}/${sec.id}/${readOnly}/${!!res}` && active?.dataset?.item && content.contains(active)) {
    renderUnitBar(unit, sub, released, res);
    return;
  }
  content.dataset.view = `${unit.id}/${sec.id}/${readOnly}/${!!res}`;
  content.dataset.unit = unit.id;
  content.innerHTML = `<h2>${esc(sec.title)}</h2>` + renderBlocks(sec.blocks, (ex) => ({
    answers: sub.answers?.[ex.id] || {},
    readOnly,
    auto: res ? (isAuto(ex) ? res.auto?.[ex.id] || {} : null) : undefined,
    manual: res?.manual?.[ex.id],
    showPending: !!res,
  })) + pagerHTML(unit, c, sec);
  renderUnitBar(unit, sub, released, res);
}

function pagerHTML(unit, c, sec) {
  const i = c.sections.indexOf(sec);
  const prev = c.sections[i - 1], next = c.sections[i + 1];
  return `<div class="pager">
    ${prev ? `<a class="btn" href="#${unit.id}/${prev.id}">← ${esc(prev.title)}</a>` : "<span></span>"}
    ${next ? `<a class="btn" href="#${unit.id}/${next.id}">${esc(next.title)} →</a>` : "<span></span>"}
  </div>`;
}

function renderUnitBar(unit, sub, released, res) {
  const bar = $("#unit-bar");
  let html;
  if (released) {
    html = res
      ? `<div class="ub ub-res"><b>Результат: ${res.score} / ${res.max}</b>
         <span>автопроверка ${res.autoScore}/${res.autoMax}${res.manualMax ? ` · открытые ответы ${res.manualPending ? "проверяются" : res.manualScore + "/" + res.manualMax}` : ""}</span></div>`
      : `<div class="ub">Проверка включена, но ваша работа не была сдана.</div>`;
  } else if (sub.status === "submitted") {
    html = `<div class="ub ub-sub">✓ Работа сдана ${fmtTime(sub.submittedAt)} — ожидает проверки.</div>`;
  } else {
    html = `<div class="ub"><span id="save-state" class="muted">${sub.dirty ? "Есть несохранённые изменения" : sub.updatedAt ? "Черновик сохранён " + fmtTime(sub.updatedAt) : "Ответы сохраняются автоматически"}</span>
      <button class="btn primary" id="submit-unit">Сдать работу по юниту</button></div>`;
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
  setSaveState("Изменения…");
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
  setSaveState("Сохранение…");
  const p = setDoc(doc(db, "submissions", subId(unitId, S.user.uid)), data);
  // запись уже в локальном кэше (IndexedDB) — даже офлайн она не потеряется
  setSaveState("Сохранено на устройстве…");
  try {
    await p;
    sub.updatedAt = new Date();
    sub.status = status;
    if (status === "submitted") sub.submittedAt = new Date();
    clearLocal(unitId);
    setSaveState("✓ Сохранено " + fmtTime(new Date()));
  } catch (e) {
    sub.dirty = true;
    setSaveState("⚠ Не сохранено: " + friendlyError(e));
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
  if (!confirm(`Сдать работу? Заполнено ${filled} из ${total} заданий.\nПосле сдачи изменить ответы будет нельзя.`)) return;
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
