// Общие функции: отрисовка упражнений, автопроверка, подсчёт баллов.
// Используются и студенческой, и преподавательской страницей.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Нормализация ответа перед сравнением с ключом
export function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.!?;,]+$/, "");
}

export const KIND_LABEL = { gap: "Fill in the gaps", match: "Matching", mcq: "Multiple choice", open: "Open answer" };
export const isAuto = (ex) => ex.kind !== "open";

export const subId = (unitId, uid) => `${unitId}__${uid}`;

export function exercisesOf(content) {
  const out = [];
  for (const s of content?.sections || [])
    for (const b of s.blocks || [])
      if (b.type === "exercise") out.push({ ...b, sectionId: s.id, sectionTitle: s.title });
  return out;
}

export function itemMax(ex, item) {
  return isAuto(ex) ? 1 : Number(item.max ?? ex.max ?? 5);
}

export function keyText(key) {
  return Array.isArray(key) ? key.join(" / ") : String(key ?? "");
}

export function isCorrect(given, key) {
  if (given == null || norm(given) === "") return false;
  const variants = Array.isArray(key) ? key : [key];
  return variants.some((k) => norm(k) === norm(given));
}

// Автопроверка: answers = {exId:{itemId:value}}, keys = {exId:{itemId:answer}}
export function gradeAuto(content, answers, keys) {
  const items = {};
  let score = 0, max = 0;
  for (const ex of exercisesOf(content)) {
    if (!isAuto(ex)) continue;
    items[ex.id] = {};
    for (const it of ex.items || []) {
      const given = answers?.[ex.id]?.[it.id] ?? "";
      const key = keys?.[ex.id]?.[it.id];
      const ok = isCorrect(given, key);
      items[ex.id][it.id] = { given, ok, correct: keyText(key) };
      max += 1;
      if (ok) score += 1;
    }
  }
  return { items, score, max };
}

// Итоговый документ results/{unitId__uid}
export function buildResult({ sub, content, keys, manual = {}, showCorrect = true }) {
  const auto = gradeAuto(content, sub.answers, keys);
  if (!showCorrect)
    for (const ex of Object.values(auto.items)) for (const r of Object.values(ex)) delete r.correct;
  let mScore = 0, mMax = 0, pending = 0;
  for (const ex of exercisesOf(content)) {
    if (isAuto(ex)) continue;
    for (const it of ex.items || []) {
      mMax += itemMax(ex, it);
      const g = manual?.[ex.id]?.[it.id];
      if (g && g.score !== null && g.score !== "" && g.score !== undefined) mScore += Number(g.score);
      else pending += 1;
    }
  }
  return {
    uid: sub.uid, groupId: sub.groupId, unitId: sub.unitId,
    auto: auto.items, manual,
    autoScore: auto.score, autoMax: auto.max,
    manualScore: mScore, manualMax: mMax, manualPending: pending,
    score: auto.score + mScore, max: auto.max + mMax,
    showCorrect,
  };
}

// ---------------------------------------------------------------------
//  Отрисовка
//  opts: {
//    answers: {itemId: value}   — ответы студента на это упражнение
//    readOnly: bool
//    key:     {itemId: answer}  — показать ключ (преподаватель)
//    auto:    {itemId: {given, ok, correct}} — результат автопроверки
//    manual:  {itemId: {score, comment}}     — ручная оценка
//    grading: bool              — поля для выставления оценки (преподаватель)
//  }
// ---------------------------------------------------------------------
export function renderBlocks(blocks, exOpts) {
  return (blocks || []).map((b) => {
    if (b.type === "html") return `<div class="block-html">${b.html}</div>`;
    if (b.type === "teacher-note") return `<div class="panel tnote"><div class="panel-t">Teacher's note</div>${b.html}</div>`;
    if (b.type === "exercise") return renderExercise(b, exOpts(b));
    return "";
  }).join("\n");
}

export function renderExercise(ex, o = {}) {
  const a = o.answers || {};
  const dis = o.readOnly ? "disabled" : "";
  let head = esc(ex.title || "");
  let scoreLine = "";
  if (o.auto && isAuto(ex)) {
    const vals = Object.values(o.auto);
    scoreLine = `<span class="ex-score">${vals.filter((v) => v.ok).length} / ${vals.length}</span>`;
  }
  const options = ex.kind === "match" && ex.showOptionList !== false
    ? `<p class="opt-list">${(ex.options || []).map((op) => `<b>${esc(op.id)}.</b> ${op.text}`).join(" &middot; ")}</p>` : "";

  const items = (ex.items || []).map((it) => {
    const val = a[it.id] ?? "";
    const r = o.auto?.[it.id];
    const mark = r ? (r.ok ? "ok" : "bad") : "";
    const attrs = `data-ex="${esc(ex.id)}" data-item="${esc(it.id)}" ${dis}`;
    const corr = r && !r.ok && r.correct ? `<span class="corr">→ ${esc(showAns(ex, r.correct))}</span>` : "";
    const keyHint = o.key && o.key[it.id] !== undefined ? `<span class="keyhint">✓ ${esc(showAns(ex, keyText(o.key[it.id])))}</span>` : "";
    let body = "";

    if (ex.kind === "gap") {
      const input = `<input class="gap ${mark}" ${attrs} value="${esc(val)}" size="${it.size || 14}" autocomplete="off" spellcheck="false">`;
      body = it.text.includes("___") ? it.text.replace("___", input) : `${it.text} ${input}`;
      body += corr + keyHint;
    } else if (ex.kind === "match") {
      const opts = (ex.options || []).map((op) =>
        `<option value="${esc(op.id)}" ${val === op.id ? "selected" : ""}>${esc(op.id)}. ${esc(stripTags(op.text))}</option>`).join("");
      body = `<span class="term">${it.text}</span> <select class="gap ${mark}" ${attrs}><option value="">—</option>${opts}</select>${corr}${keyHint}`;
    } else if (ex.kind === "mcq") {
      const name = `${ex.id}__${it.id}`;
      const letters = "ABCDEFGH";
      const opts = (it.options || []).map((t, i) => {
        const L = letters[i];
        const cls = r && val === L ? (r.ok ? "ok" : "bad") : (o.key && o.key[it.id] === L ? "right" : "");
        return `<label class="${cls}"><input type="radio" name="${esc(name)}" value="${L}" ${val === L ? "checked" : ""} ${attrs}> ${L}&nbsp;${t}</label>`;
      }).join("");
      body = `${it.text}<div class="mcq">${opts}</div>${corr}`;
    } else if (ex.kind === "open") {
      const m = o.manual?.[it.id];
      const max = itemMax(ex, it);
      let grade = "";
      if (o.grading) {
        grade = `<div class="grade-box">
          <label>Балл <input type="number" min="0" max="${max}" step="0.5" class="g-score" data-ex="${esc(ex.id)}" data-item="${esc(it.id)}" value="${esc(m?.score ?? "")}"> / ${max}</label>
          <textarea class="g-comment" rows="2" placeholder="Комментарий студенту" data-ex="${esc(ex.id)}" data-item="${esc(it.id)}">${esc(m?.comment ?? "")}</textarea>
        </div>`;
      } else if (m && (m.score !== undefined || m.comment)) {
        grade = `<div class="feedback"><b>${m.score ?? "—"} / ${max}</b>${m.comment ? ` · ${esc(m.comment)}` : ""}</div>`;
      } else if (o.auto !== undefined && o.showPending) {
        grade = `<div class="feedback muted">Ожидает проверки преподавателем</div>`;
      }
      body = `${it.text}<textarea class="open-answer" rows="${it.rows || 5}" ${attrs}>${esc(val)}</textarea>${grade}`;
    }
    return `<li>${body}</li>`;
  }).join("\n");

  return `<div class="exercise" id="ex-${esc(ex.id)}">
  <div class="ex-h">${head} <span class="kind">${KIND_LABEL[ex.kind] || ""}</span>${scoreLine}</div>
  <div class="ex-b">
    ${ex.rubric ? `<p class="rubric">${ex.rubric}</p>` : ""}
    ${options}
    <ol class="nums">${items}</ol>
  </div></div>`;
}

// Для matching показываем не только букву, но и текст варианта
function showAns(ex, v) {
  if (ex.kind !== "match") return v;
  const op = (ex.options || []).find((o) => o.id === v);
  return op ? `${v}. ${stripTags(op.text)}` : v;
}

function stripTags(s) { return String(s ?? "").replace(/<[^>]*>/g, ""); }

// Значение поля ответа из DOM-элемента
export function readInput(el) {
  if (el.type === "radio") return el.checked ? el.value : null;
  return el.value;
}

export function fmtTime(ts) {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!d) return "";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function friendlyError(e) {
  const c = e?.code || "";
  const map = {
    "auth/invalid-credential": "Неверный email или пароль.",
    "auth/wrong-password": "Неверный email или пароль.",
    "auth/user-not-found": "Пользователь не найден.",
    "auth/email-already-in-use": "Этот email уже зарегистрирован.",
    "auth/weak-password": "Пароль слишком короткий (минимум 6 символов).",
    "auth/invalid-email": "Некорректный email.",
    "auth/too-many-requests": "Слишком много попыток. Попробуйте позже.",
    "permission-denied": "Недостаточно прав для этого действия.",
    "unavailable": "Нет связи с сервером. Изменения сохранятся, когда связь восстановится.",
  };
  return map[c] || e?.message || String(e);
}

// Форма входа / регистрации / восстановления пароля (общая разметка)
export function authFormHTML({ title, allowRegister }) {
  return `
  <div class="auth-card">
    <h1>${esc(title)}</h1>
    <div class="auth-tabs">
      <button data-mode="login" class="on">Вход</button>
      ${allowRegister ? `<button data-mode="register">Регистрация</button>` : ""}
      <button data-mode="reset">Забыли пароль?</button>
    </div>
    <form id="auth-form" novalidate>
      <label class="f-register">Имя и фамилия<input name="name" autocomplete="name"></label>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label class="f-pass">Пароль<input name="password" type="password" autocomplete="current-password" minlength="6"></label>
      <label class="f-register">Код группы (выдаёт преподаватель)<input name="group" autocomplete="off"></label>
      <button type="submit" class="btn primary" id="auth-submit">Войти</button>
      <p class="auth-msg" id="auth-msg"></p>
    </form>
  </div>`;
}

export function wireAuthForm(root, handlers) {
  let mode = "login";
  const form = root.querySelector("#auth-form");
  const msg = root.querySelector("#auth-msg");
  const setMode = (m) => {
    mode = m;
    root.querySelectorAll(".auth-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    root.querySelectorAll(".f-register").forEach((el) => (el.hidden = m !== "register"));
    root.querySelector(".f-pass").hidden = m === "reset";
    root.querySelector("#auth-submit").textContent = { login: "Войти", register: "Зарегистрироваться", reset: "Отправить ссылку" }[m];
    msg.textContent = "";
    msg.className = "auth-msg";
  };
  root.querySelectorAll(".auth-tabs button").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setMode(b.dataset.mode); }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form).entries());
    msg.className = "auth-msg";
    msg.textContent = "…";
    try {
      const text = await handlers[mode](f);
      msg.textContent = text || "";
      msg.className = "auth-msg good";
    } catch (err) {
      msg.textContent = friendlyError(err);
      msg.className = "auth-msg bad";
    }
  });
  setMode("login");
}
