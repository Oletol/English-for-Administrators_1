// Checking free writing: grammar and spelling (LanguageTool), vocabulary level (CEFR-J A1–B2,
// Octanove C1–C2, Google 10,000 frequency list as a fallback) and use of the unit's vocabulary.
// The check runs in the teacher's browser when the teacher clicks the button; the result is
// saved for each student in exerciseResults and shown under their text.
import { esc } from "./common.js";

const LT_URL = "https://api.languagetool.org/v2/check";
const LT_LANG = "en-GB";
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

// ------------------------------------------------------------------ word lists
let VOCAB = null;
export async function loadVocab() {
  if (VOCAB) return VOCAB;
  const r = await fetch("data/vocab-levels.json");
  const d = await r.json();
  VOCAB = { levels: d.levels, phrases: d.phrases, frequent: new Set(d.frequent) };
  return VOCAB;
}

// ------------------------------------------------------------------ lemmas
const IRREGULAR = Object.fromEntries(`be:am,is,are,was,were,been,being|have:has,had,having|do:does,did,done,doing|go:goes,went,gone|
get:got,gotten|make:made|take:took,taken|come:came|see:saw,seen|know:knew,known|give:gave,given|find:found|think:thought|
tell:told|become:became|leave:left|feel:felt|bring:brought|begin:began,begun|keep:kept|hold:held|write:wrote,written|
stand:stood|hear:heard|let:let|mean:meant|set:set|meet:met|run:ran|pay:paid|sit:sat|speak:spoke,spoken|lie:lay,lain|
lead:led|read:read|grow:grew,grown|lose:lost|fall:fell,fallen|send:sent|build:built|understand:understood|draw:drew,drawn|
break:broke,broken|spend:spent|cut:cut|rise:rose,risen|drive:drove,driven|buy:bought|wear:wore,worn|choose:chose,chosen|
seek:sought|throw:threw,thrown|catch:caught|deal:dealt|win:won|forget:forgot,forgotten|teach:taught|sell:sold|fight:fought|
eat:ate,eaten|sleep:slept|fly:flew,flown|drink:drank,drunk|sing:sang,sung|swim:swam,swum|forgive:forgave,forgiven|
hide:hid,hidden|shake:shook,shaken|steal:stole,stolen|wake:woke,woken|ring:rang,rung|feed:fed|hang:hung|shoot:shot|
light:lit|bite:bit,bitten|stick:stuck|lend:lent|bend:bent|swear:swore,sworn|tear:tore,torn|freeze:froze,frozen|
person:people|child:children|man:men|woman:women|foot:feet|tooth:teeth|mouse:mice|good:better,best|bad:worse,worst|
far:further,farther,furthest,farthest|i:me,my,mine|we:us,our,ours|he:him,his|she:her,hers|they:them,their,theirs`
  .replace(/\s/g, "").split("|").flatMap((g) => { const [base, forms] = g.split(":"); return forms.split(",").map((f) => [f, base]); }));

function candidates(w) {
  const c = [w];
  if (IRREGULAR[w]) c.push(IRREGULAR[w]);
  const add = (x) => x.length > 1 && c.push(x);
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (/(.)\1ed$/.test(w)) add(w.slice(0, -3)); }
  if (w.endsWith("ing")) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); if (/(.)\1ing$/.test(w)) add(w.slice(0, -4)); if (w.endsWith("ying")) add(w.slice(0, -4) + "ie"); }
  if (w.endsWith("er")) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.endsWith("ier")) add(w.slice(0, -3) + "y"); }
  if (w.endsWith("est")) { add(w.slice(0, -3)); add(w.slice(0, -2)); if (w.endsWith("iest")) add(w.slice(0, -4) + "y"); }
  if (w.endsWith("'s")) add(w.slice(0, -2));
  return c;
}
export function lemma(w, levels) {
  const c = candidates(w);
  return c.find((x) => levels?.[x]) || (IRREGULAR[w] || c[c.length > 1 ? 1 : 0]);
}

export function tokens(text) {
  return (String(text || "").toLowerCase().replace(/[’‘]/g, "'").match(/[a-z]+(?:'[a-z]+)?/g) || [])
    .filter((t) => !/^'/.test(t));
}

// ------------------------------------------------------------------ vocabulary profile
const NOT_WORDS = new Set(["s", "t", "ll", "re", "ve", "d", "m"]);
export function vocabProfile(text, V, unitPhrases = []) {
  const toks = tokens(text).map((t) => t.replace(/'(s|t|ll|re|ve|d|m)$/, "")).filter((t) => t && !NOT_WORDS.has(t));
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const high = new Map(), off = new Set();
  const lemmas = toks.map((t) => {
    const lm = lemma(t, V.levels);
    const lv = V.levels[lm];
    if (lv) { counts[lv]++; if (lv >= "B2") high.set(lm, lv); }
    else if (!V.frequent.has(t) && !V.frequent.has(lm) && t.length > 2) off.add(t);
    return lm;
  });
  return {
    words: toks.length,
    counts,
    high: [...high].map(([w, l]) => ({ w, l })).sort((a, b) => b.l.localeCompare(a.l) || a.w.localeCompare(b.w)),
    offList: [...off].slice(0, 30),
    unitUsed: unitPhrases.filter((p) => phraseUsed(p, toks)),
  };
}

// Multi-word unit vocabulary: "have something in common" matches "have a lot in common",
// "mute a chat" matches "muted the noisy group chat", "lose touch" matches "lost touch".
const WILD = new Set(["something", "somebody", "someone", "sb", "sth", "one's"]);
const DET = new Set(["a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those", "some", "any"]);
export function phraseUsed(phrase, toks) {
  const p = tokens(phrase).map((t) => (WILD.has(t) ? "*" : DET.has(t) ? "?" : new Set(candidates(t))));
  const sets = toks.map((t) => new Set(candidates(t)));
  const same = (a, b) => [...a].some((x) => b.has(x));
  const match = (i, j) => {
    if (j === p.length) return true;
    if (i >= toks.length) return p.slice(j).every((x) => x === "?");
    const pj = p[j];
    if (pj === "*") { for (let k = 1; k <= 4 && i + k <= toks.length; k++) if (match(i + k, j + 1)) return true; return false; }
    if (pj === "?") { for (let k = 0; k <= 3 && i + k <= toks.length; k++) if (match(i + k, j + 1)) return true; return false; }
    return same(pj, sets[i]) && match(i + 1, j + 1);
  };
  for (let i = 0; i < toks.length; i++) if (match(i, 0)) return true;
  return false;
}

// The unit's vocabulary database: flashcard fronts + any "vocab" lists in exercises
export function unitVocabulary(content) {
  const out = new Set();
  for (const s of content?.sections || [])
    for (const b of s.blocks || []) {
      if (b.type === "flashcards") (b.cards || []).forEach((c) => out.add(c.front));
      if (Array.isArray(b.vocab)) b.vocab.forEach((v) => out.add(v));
    }
  return [...out];
}

// ------------------------------------------------------------------ grammar (LanguageTool)
// One request per student: all items of the exercise are sent together and split back.
export async function grammarCheck(texts) {
  const SEP = "\n\n";
  const parts = Object.entries(texts).filter(([, t]) => String(t || "").trim());
  if (!parts.length) return {};
  let full = "", spans = [];
  for (const [id, t] of parts) { spans.push({ id, start: full.length, end: full.length + t.length }); full += t + SEP; }
  const body = new URLSearchParams({ text: full, language: LT_LANG, enabledOnly: "false" });
  const r = await fetch(LT_URL, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!r.ok) throw new Error(`LanguageTool answered ${r.status}`);
  const data = await r.json();
  const out = Object.fromEntries(parts.map(([id]) => [id, []]));
  for (const m of data.matches || []) {
    const sp = spans.find((s) => m.offset >= s.start && m.offset < s.end);
    if (!sp) continue;
    out[sp.id].push({
      offset: m.offset - sp.start, length: m.length,
      message: m.message, short: m.shortMessage || "",
      fix: (m.replacements || []).slice(0, 3).map((x) => x.value),
      type: m.rule?.issueType || "", category: m.rule?.category?.name || "",
    });
  }
  return out;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ feedback shown under the text
export function wordCount(text) { return tokens(text).length; }

export function feedbackHTML(fb, { checkedAt } = {}) {
  if (!fb) return "";
  const text = String(fb.text || "");
  // highlighted text
  let html = "", pos = 0;
  for (const is of [...(fb.issues || [])].sort((a, b) => a.offset - b.offset)) {
    if (is.offset < pos) continue;
    html += esc(text.slice(pos, is.offset));
    html += `<mark class="lt ${is.type === "misspelling" ? "sp" : ""}" title="${esc(is.message)}">${esc(text.substr(is.offset, is.length))}</mark>`;
    pos = is.offset + is.length;
  }
  html += esc(text.slice(pos));
  const issues = (fb.issues || []).map((is) => `<li><b>${esc(text.substr(is.offset, is.length))}</b> – ${esc(is.message)}${is.fix?.length ? ` <span class="fix">Try: ${is.fix.map((f) => `“${esc(f)}”`).join(", ")}</span>` : ""}</li>`).join("");
  const v = fb.vocab;
  const total = v ? LEVELS.reduce((n, l) => n + v.counts[l], 0) || 1 : 1;
  const bars = v ? LEVELS.map((l) => `<span class="lvchip lv-${l}" title="${l}: ${v.counts[l]} words">${l} <b>${Math.round((100 * v.counts[l]) / total)}%</b></span>`).join("") : "";
  return `<div class="wfb">
    <div class="wfb-h">Feedback on your text${checkedAt ? ` <span class="muted">· checked ${esc(checkedAt)}</span>` : ""}</div>
    ${fb.grammarError ? `<p class="muted">The grammar check was not available this time.</p>` : ""}
    <div class="wfb-text">${html}</div>
    ${issues ? `<ul class="wfb-issues">${issues}</ul>` : fb.grammarError ? "" : `<p class="wfb-ok">No grammar or spelling problems were found.</p>`}
    ${v ? `<div class="wfb-v"><span class="muted">${v.words} words</span> ${bars}</div>
      ${v.high.length ? `<p class="wfb-line"><b>Words at B2 and above:</b> ${v.high.map((x) => `${esc(x.w)} <small>${x.l}</small>`).join(", ")}</p>` : ""}
      ${fb.unitTotal ? `<p class="wfb-line"><b>Unit phrases used (${v.unitUsed.length} of ${fb.unitTotal}):</b> ${v.unitUsed.length ? v.unitUsed.map(esc).join(", ") : "none yet"}</p>` : ""}
      ${v.offList.length ? `<p class="wfb-line muted">Not in the word lists (names, rare words or misspellings): ${v.offList.map(esc).join(", ")}</p>` : ""}` : ""}
    <p class="wfb-src">Grammar suggestions by <a href="https://languagetool.org" target="_blank">LanguageTool</a> · vocabulary levels from the CEFR-J Wordlist and the Octanove Vocabulary Profile</p>
  </div>`;
}
