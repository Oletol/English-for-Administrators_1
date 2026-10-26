// Turning a recording into text in the student's browser, plus simple measurements of the speech
// (how long the student spoke, speed, pauses). Used by speaking.js for blocks with "transcribe".
const SR = 16000;
let worker = null, seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./asr-worker.js?v=20261026a", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    for (const w of waiting.values()) if (m.type === "progress") w.onProgress?.(m);
    const w = waiting.get(m.id);
    if (!w) return;
    if (m.type === "done") { waiting.delete(m.id); w.resolve(m.text); }
    if (m.type === "error") { waiting.delete(m.id); w.reject(new Error(m.message)); }
  };
  worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || "The speech model could not start.")); waiting.clear(); worker = null; };
  return worker;
}

// any recording (webm, ogg, mp4) becomes 16 kHz mono
export async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let ab;
  try { ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); }); }
  finally { try { ctx.close(); } catch {} }
  const n = ab.length, ch = ab.numberOfChannels, mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  const r = ab.sampleRate / SR;
  if (r === 1) return mono;
  const out = new Float32Array(Math.floor(n / r));
  if (Number.isInteger(r)) { for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < r; j++) s += mono[i * r + j]; out[i] = s / r; } }
  else {
    // average over the source samples that fall into each output sample (a simple low-pass), then pick
    for (let i = 0; i < out.length; i++) {
      const a = i * r, b = Math.min(n, a + r); let s = 0, k = 0;
      for (let j = Math.floor(a); j < b; j++) { s += mono[j]; k++; }
      out[i] = k ? s / k : 0;
    }
  }
  return out;
}

// voice activity: 30 ms frames, a threshold between the noise floor and the loudest frames
export function speechStats(a) {
  const F = 480, n = Math.floor(a.length / F), db = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < F; j++) { const x = a[i * F + j]; s += x * x; } db[i] = 10 * Math.log10(s / F + 1e-12); }
  const sorted = Array.from(db).sort((x, y) => x - y);
  const floor = sorted[Math.floor(n * 0.1)] ?? -100, peak = sorted[Math.floor(n * 0.98)] ?? 0;
  const thr = Math.max(floor + 10, peak - 35);
  const voiced = Array.from(db, (v) => v > thr);
  // close very short gaps (between words) so that only real pauses remain
  const minGap = Math.round(0.25 / 0.03);
  for (let i = 0; i < n;) {
    if (voiced[i]) { i++; continue; }
    let j = i; while (j < n && !voiced[j]) j++;
    if (i > 0 && j < n && j - i < minGap) for (let k = i; k < j; k++) voiced[k] = true;
    i = j;
  }
  const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  const pauses = [];
  if (first >= 0) for (let i = first; i <= last;) {
    if (voiced[i]) { i++; continue; }
    let j = i; while (j <= last && !voiced[j]) j++;
    const len = (j - i) * 0.03;
    if (len >= 1.0) pauses.push(+len.toFixed(1));
    i = j;
  }
  return {
    total: +(a.length / SR).toFixed(1),
    speech: first >= 0 ? +(((last - first + 1) * 0.03) - pauses.reduce((s, p) => s + p, 0)).toFixed(1) : 0,
    span: first >= 0 ? +((last - first + 1) * 0.03).toFixed(1) : 0,
    pauses: pauses.length,
    longest: pauses.length ? Math.max(...pauses) : 0,
    db, thr, voiced,
  };
}

// split into pieces of at most 30 s, cutting at the quietest moment between 20 and 29 s
export function chunks(a, st) {
  const out = [];
  let s = 0;
  const frame = 480;
  while (a.length - s > 30 * SR) {
    const lo = Math.floor((s + 20 * SR) / frame), hi = Math.floor((s + 29 * SR) / frame);
    let best = hi, bv = Infinity;
    for (let i = lo; i < hi; i++) {
      let v = 0; for (let k = -5; k <= 5; k++) v += st.db[Math.min(st.db.length - 1, Math.max(0, i + k))];
      if (v < bv) { bv = v; best = i; }
    }
    const cut = best * frame;
    out.push(a.slice(s, cut)); s = cut;
  }
  out.push(a.slice(s));
  // pieces with almost no voice are not sent to the model
  return out.filter((c) => {
    const st2 = speechStats(c);
    return st2.speech >= 0.8;
  });
}

export async function transcribeBlob(blob, onProgress) {
  onProgress?.({ stage: "prepare" });
  const a = await decodeTo16k(blob);
  const st = speechStats(a);
  const parts = chunks(a, st);
  let text = "";
  if (parts.length) {
    const id = ++seq;
    text = await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, chunks: parts }, parts.map((p) => p.buffer));
    });
  }
  const words = (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || []).length;
  const metrics = {
    total: st.total, speech: st.speech, words,
    wpm: st.span > 3 ? Math.round(words / (st.span / 60)) : 0,
    pauses: st.pauses, longest: st.longest,
  };
  return { text, metrics };
}

export function metricsLine(m) {
  if (!m) return "";
  const t = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return `Recording ${t(m.total)} · you spoke for about ${t(m.speech)} · ${m.words} words`
    + (m.wpm ? ` · about ${m.wpm} words per minute` : "")
    + ` · ${m.pauses} ${m.pauses === 1 ? "pause" : "pauses"} longer than 1 second${m.pauses ? ` (longest ${m.longest} s)` : ""}`;
}
