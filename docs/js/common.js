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

export const KIND_LABEL = { gap: "Gap fill", match: "Matching", mcq: "Multiple choice", open: "Open answer" };
// auto-checked: has keys (not "open", not marked "graded": false)
export const isAuto = (ex) => ex.kind !== "open" && ex.graded !== false;
// marked by the teacher by hand
export const isManual = (ex) => ex.kind === "open";
// checked by the teacher separately, exercise by exercise ("check": "teacher")
export const isTeacherChecked = (ex) => isAuto(ex) && ex.check === "teacher";
const NOAUTO = `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"`;

export const subId = (unitId, uid) => `${unitId}__${uid}`;

export function exercisesOf(content) {
  const out = [];
  for (const s of content?.sections || [])
    for (const b of s.blocks || [])
      if (b.type === "exercise") out.push({ ...b, sectionId: s.id, sectionTitle: s.title });
  return out;
}

export function itemMax(ex, item) {
  return isManual(ex) ? Number(item.max ?? ex.max ?? 5) : 1;
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

// Check one exercise (used when the teacher checks a single exercise)
export function gradeExercise(ex, answers, keys) {
  const items = {};
  let score = 0;
  for (const it of ex.items || []) {
    const given = answers?.[it.id] ?? "";
    const key = keys?.[it.id];
    const ok = isCorrect(given, key);
    items[it.id] = { given, ok, correct: keyText(key) };
    if (ok) score += 1;
  }
  return { items, score, max: (ex.items || []).length };
}

// Итоговый документ results/{unitId__uid}
export function buildResult({ sub, content, keys, manual = {}, showCorrect = true }) {
  const auto = gradeAuto(content, sub.answers, keys);
  if (!showCorrect)
    for (const ex of Object.values(auto.items)) for (const r of Object.values(ex)) delete r.correct;
  let mScore = 0, mMax = 0, pending = 0;
  for (const ex of exercisesOf(content)) {
    if (!isManual(ex)) continue;
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
export function renderBlocks(blocks, exOpts, numPrefix = "") {
  let n = 0;
  return (blocks || []).map((b) => {
    if (b.type === "html") return `<div class="block-html">${b.html}</div>`;
    if (b.type === "teacher-note") return `<div class="tnote"><div class="tn-h"><span class="tn-ic">T</span>Teaching notes</div><div class="tn-b">${b.html}</div></div>`;
    if (b.type === "flashcards") return renderFlashcards(b);
    if (b.type === "image") return renderImages([b], b.layout);
    if (b.type === "images") return renderImages(b.items || [], b.layout || "grid");
    if (b.type === "audio") return renderAudio(b);
    if (b.type === "exercise") { n += 1; return renderExercise(b, { num: numPrefix ? `${numPrefix}.${n}` : String(n), ...exOpts(b) }); }
    return "";
  }).join("\n");
}

export function renderExercise(ex, o = {}) {
  const a = o.answers || {};
  const dis = o.readOnly ? "disabled" : "";
  let scoreLine = "";
  if (o.auto && isAuto(ex)) {
    const vals = Object.values(o.auto);
    scoreLine = `<span class="ex-score">${vals.filter((v) => v.ok).length} / ${vals.length}</span>`;
  }
  const options = ex.kind === "match" && ex.showOptionList !== false
    ? `<div class="opt-list">${(ex.options || []).map((op) => `<b>${esc(op.id)}</b>&nbsp;${op.text}`).join(" &nbsp;&middot;&nbsp; ")}</div>` : "";

  const items = (ex.items || []).map((it) => {
    const val = a[it.id] ?? "";
    const r = o.auto?.[it.id];
    const mark = r ? (r.ok ? "ok" : "bad") : "";
    const attrs = `data-ex="${esc(ex.id)}" data-item="${esc(it.id)}" ${dis}`;
    const corr = r && !r.ok && r.correct ? `<span class="corr">→ ${esc(showAns(ex, r.correct))}</span>` : "";
    const keyHint = o.key && o.key[it.id] !== undefined ? `<span class="keyhint">✓ ${esc(showAns(ex, keyText(o.key[it.id])))}</span>` : "";
    let body = "";

    if (ex.kind === "gap") {
      const size = it.size || ex.size || 14;
      const input = `<input class="gap ${ex.box ? "box" : ""} ${mark}" ${attrs} value="${esc(val)}" size="${size}" ${ex.box ? `style="width:${size + 1}ch"` : ""} ${NOAUTO}>`;
      body = it.text.includes("___") ? it.text.replace("___", input) : `<span class="li-t">${it.text}</span>${input}`;
      body += corr + keyHint;
    } else if (ex.kind === "match") {
      const opts = (ex.options || []).map((op) =>
        `<option value="${esc(op.id)}" ${val === op.id ? "selected" : ""}>${esc(op.id)}. ${esc(stripTags(op.text))}</option>`).join("");
      body = `<span class="m-word">${it.text}</span> <select class="gap ${mark}" ${attrs}><option value="">choose…</option>${opts}</select>${corr}${keyHint}`;
    } else if (ex.kind === "mcq") {
      const name = `${ex.id}__${it.id}`;
      const letters = "ABCDEFGH";
      const opts = (it.options || []).map((t, i) => {
        const L = letters[i];
        const cls = r && val === L ? (r.ok ? "ok" : "bad") : (o.key && o.key[it.id] === L ? "right" : "");
        return `<label class="${cls}"><input type="radio" name="${esc(name)}" value="${L}" ${val === L ? "checked" : ""} ${attrs}><span class="l">${L}</span><span>${t}</span></label>`;
      }).join("");
      body = `${it.text}<div class="mcq">${opts}</div>${corr}`;
    } else if (ex.kind === "open") {
      const m = o.manual?.[it.id];
      const max = itemMax(ex, it);
      let grade = "";
      if (o.grading) {
        grade = `<div class="grade-box">
          <label>Score <input type="number" min="0" max="${max}" step="0.5" class="g-score" data-ex="${esc(ex.id)}" data-item="${esc(it.id)}" value="${esc(m?.score ?? "")}"> / ${max}</label>
          <textarea class="g-comment" rows="2" placeholder="Comment for the student" data-ex="${esc(ex.id)}" data-item="${esc(it.id)}">${esc(m?.comment ?? "")}</textarea>
        </div>`;
      } else if (m && (m.score !== undefined || m.comment)) {
        grade = `<div class="feedback"><b>${m.score ?? "—"} / ${max}</b>${m.comment ? ` · ${esc(m.comment)}` : ""}</div>`;
      } else if (o.auto !== undefined && o.showPending) {
        grade = `<div class="feedback muted">Waiting for the teacher's assessment</div>`;
      }
      body = `${it.text}<textarea class="open-answer" rows="${it.rows || 5}" ${attrs} ${NOAUTO} placeholder="${o.readOnly ? "" : "Type your answer here…"}">${esc(val)}</textarea>${grade}`;
    }
    return `<li>${body}</li>`;
  }).join("\n");

  const count = (ex.items || []).length;
  let body = `<ol class="items ${ex.layout === "two" ? "two" : ""}">${items}</ol>`;
  if (ex.kind === "match" && ex.display === "letters") {
    // as in the printed workbook: type the letter next to each phrase, meanings listed on the right
    const left = (ex.items || []).map((it) => {
      const val = a[it.id] ?? "";
      const r = o.auto?.[it.id];
      const mark = r ? (r.ok ? "ok" : "bad") : "";
      const corr = r && !r.ok && r.correct ? `<span class="corr">→ ${esc(r.correct)}</span>` : "";
      const keyHint = o.key && o.key[it.id] !== undefined ? `<span class="keyhint">✓ ${esc(keyText(o.key[it.id]))}</span>` : "";
      return `<li><span class="m-word">${it.text}</span> <input class="gap ${mark}" style="width:5ch" maxlength="2" data-ex="${esc(ex.id)}" data-item="${esc(it.id)}" ${dis} value="${esc(val)}" ${NOAUTO}>${corr}${keyHint}</li>`;
    }).join("");
    const right = (ex.options || []).map((op) => `<li>${op.text}</li>`).join("");
    body = `<div class="match"><ol class="m-left">${left}</ol><ol class="m-right" type="a">${right}</ol></div>`;
  }
  const tag = o.tag ? `<span class="ex-tag">${o.tag}</span>` : "";
  return `${o.before || ""}<section class="ex" id="ex-${esc(ex.id)}">
  <div class="ex-h">${o.num ? `<span class="ex-n">${esc(o.num)}</span>` : ""}<span class="ex-t">${esc(ex.title || "")}</span><span class="ex-c">${count} ${count === 1 ? "item" : "items"}</span>${tag}${scoreLine}</div>
  ${ex.rubric ? `<p class="ex-i">${ex.rubric}</p>` : ""}
  ${ex.display === "letters" ? "" : options}
  ${body}
</section>`;
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
  return d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function friendlyError(e) {
  const c = e?.code || "";
  const map = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "No account with this email.",
    "auth/email-already-in-use": "This email is already registered.",
    "auth/weak-password": "The password is too short (at least 6 characters).",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "permission-denied": "You do not have permission to do this.",
    "unavailable": "No connection. Your changes will be saved when the connection is back.",
  };
  return map[c] || e?.message || String(e);
}

// Форма входа / регистрации / восстановления пароля (общая разметка)
export function authFormHTML({ title, eyebrow = "", allowRegister }) {
  return `
  <div class="auth-card">
    ${eyebrow ? `<div class="crs">${esc(eyebrow)}</div>` : ""}
    <h1>${esc(title)}</h1>
    <div class="auth-tabs">
      <button data-mode="login" class="on">Sign in</button>
      ${allowRegister ? `<button data-mode="register">Create account</button>` : ""}
      <button data-mode="reset">Forgot password?</button>
    </div>
    <form id="auth-form" novalidate>
      <label class="f-register">Full name<input name="name" autocomplete="name"></label>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label class="f-pass">Password<input name="password" type="password" autocomplete="current-password" minlength="6"></label>
      <label class="f-register">Group code (from your teacher)<input name="group" autocomplete="off"></label>
      <button type="submit" class="btn primary" id="auth-submit">Sign in</button>
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
    root.querySelector("#auth-submit").textContent = { login: "Sign in", register: "Create account", reset: "Send reset link" }[m];
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

// ---------------------------------------------------------------------
//  Flashcards: word on the front; translation and an example on the back
// ---------------------------------------------------------------------
export function renderFlashcards(b) {
  const cards = b.cards || [];
  const data = esc(JSON.stringify(cards));
  return `<section class="fc" data-cards="${data}" data-i="0">
    <div class="fc-h"><span class="ic">🃏</span><span class="ex-t">${esc(b.title || "Flashcards")}</span><span class="ex-c">${cards.length} words</span></div>
    ${b.rubric ? `<p class="ex-i">${b.rubric}</p>` : ""}
    <div class="fc-stage">${fcCard(cards[0], 0, cards.length)}</div>
    <div class="fc-nav">
      <button class="btn small" type="button" data-fc="prev">← Previous</button>
      <span class="fc-count">1 / ${cards.length}</span>
      <button class="btn small" type="button" data-fc="next">Next →</button>
      <button class="btn small" type="button" data-fc="shuffle" title="Mix the cards">⤮ Shuffle</button>
    </div>
    <div class="fc-dots">${cards.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>
  </section>`;
}
function fcCard(c, i, n) {
  if (!c) return "";
  return `<button type="button" class="fc-card" data-fc="flip" aria-label="Turn the card over">
    <span class="fc-inner">
      <span class="fc-face fc-front"><span class="w">${esc(c.front)}</span><span class="hint">Click to see the translation</span></span>
      <span class="fc-face fc-back"><span class="w2">${esc(c.front)}</span><span class="tr">${esc(c.back)}</span>${c.example ? `<span class="eg">${esc(c.example)}</span>` : ""}</span>
    </span></button>`;
}
let fcWired = false;
export function wireFlashcards(root = document) {
  if (fcWired) return;
  fcWired = true;
  const go = (fc, delta, shuffle) => {
    let cards = JSON.parse(fc.dataset.cards);
    let i = Number(fc.dataset.i);
    if (shuffle) {
      for (let k = cards.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [cards[k], cards[j]] = [cards[j], cards[k]]; }
      fc.dataset.cards = JSON.stringify(cards);
      i = 0;
    } else i = (i + delta + cards.length) % cards.length;
    fc.dataset.i = i;
    fc.querySelector(".fc-stage").innerHTML = fcCard(cards[i], i, cards.length);
    fc.querySelector(".fc-count").textContent = `${i + 1} / ${cards.length}`;
    fc.querySelectorAll(".fc-dots i").forEach((d, k) => d.classList.toggle("on", k === i));
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fc]");
    if (!b) return;
    const fc = b.closest(".fc");
    const act = b.dataset.fc;
    if (act === "flip") b.classList.toggle("flip");
    if (act === "next") go(fc, 1);
    if (act === "prev") go(fc, -1);
    if (act === "shuffle") go(fc, 0, true);
  });
  root.addEventListener("keydown", (e) => {
    const fc = e.target.closest?.(".fc");
    if (!fc) return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(fc, 1); fc.querySelector(".fc-card")?.focus(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(fc, -1); fc.querySelector(".fc-card")?.focus(); }
  });
}

// ---------------------------------------------------------------------
//  Pictures and audio. Files live on GitHub Pages in docs/media/…,
//  the unit only stores the path, e.g. "media/u1/listening-1.mp3".
// ---------------------------------------------------------------------
const mediaSrc = (src) => esc(String(src || "").replace(/^\/+/, ""));
function renderImages(items, layout) {
  const figs = items.map((it) => `<figure class="pic">
      <img src="${mediaSrc(it.src)}" alt="${esc(it.alt || it.caption || "")}" loading="lazy" draggable="false">
      ${it.caption || it.label ? `<figcaption class="cap">${it.label ? `<b>${esc(it.label)}</b>` : ""}${it.caption ? esc(it.caption) : ""}</figcaption>` : ""}
    </figure>`).join("");
  return `<div class="pics ${items.length > 1 ? (layout === "row" ? "row" : "grid") : "one"}">${figs}</div>`;
}
function renderAudio(b) {
  return `<div class="audio"><div class="au-ic">🎧</div><div class="au-b">
      <div class="au-t">${esc(b.title || "Listen")}</div>
      <audio controls preload="none" controlslist="nodownload noplaybackrate" src="${mediaSrc(b.src)}"></audio>
      ${b.note ? `<div class="au-n">${esc(b.note)}</div>` : ""}
    </div></div>`;
}
