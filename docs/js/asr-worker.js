// Speech recognition in the browser (a Web Worker, so that the page does not freeze).
// Model: OpenAI Whisper base.en (MIT licence), ONNX export by k2-fsa/sherpa-onnx (Apache 2.0), run with
// onnxruntime-web (MIT). Everything is served from this site: the audio never leaves the student's computer.
// The model files are kept in the browser's cache after the first download.
import * as ort from "./vendor/ort/ort.wasm.min.mjs";

const BASE = new URL("../models/whisper-base-en/", import.meta.url).href;
const CACHE = "asr-whisper-base-en-v1";
ort.env.wasm.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let M = null;          // { cfg, enc, dec, vocab }
const post = (m) => self.postMessage(m);

// ------------------------------------------------------------------ files (with progress and cache)
async function fetchPart(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; } } catch { cache = null; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download ${url.split("/").pop()} (${r.status})`);
  const chunks = []; let n = 0;
  const rd = r.body.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; onBytes(value.length); }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  try { await cache?.put(url, new Response(out.slice().buffer)); } catch {}
  return out.buffer;
}
async function load() {
  if (M) return M;
  const cfg = await (await fetch(BASE + "config.json")).json();
  const total = Object.values(cfg.files).reduce((s, f) => s + f.bytes, 0);
  let got = 0;
  const onBytes = (k) => { got += k; post({ type: "progress", stage: "load", loaded: got, total }); };
  const file = async (key) => {
    const parts = [];
    for (const p of cfg.files[key].parts) parts.push(new Uint8Array(await fetchPart(BASE + p, onBytes)));
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  };
  const tokText = new TextDecoder().decode(await file("tokens"));
  const vocab = [];
  for (const line of tokText.split("\n")) {
    const [b64, id] = line.trim().split(/\s+/);
    if (id === undefined) continue;
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    vocab[+id] = u;
  }
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const enc = await ort.InferenceSession.create(await file("encoder"), opts);
  const dec = await ort.InferenceSession.create(await file("decoder"), opts);
  post({ type: "progress", stage: "ready" });
  M = { cfg, enc, dec, vocab };
  return M;
}

// ------------------------------------------------------------------ log-mel spectrogram (as in Whisper)
const N_FFT = 400, HOP = 160, N_MELS = 80, N_FRAMES = 3000, N_SAMPLES = 480000, NB = N_FFT / 2 + 1;
const hz2mel = (f) => (f >= 1000 ? 15 + Math.log(f / 1000) / (Math.log(6.4) / 27) : f / (200 / 3));
const mel2hz = (m) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 / 3) * m);
const FILT = (() => {
  const W = new Float32Array(N_MELS * NB);
  const mmax = hz2mel(8000), pts = [];
  for (let i = 0; i < N_MELS + 2; i++) pts.push(mel2hz((mmax * i) / (N_MELS + 1)));
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (pts[m + 2] - pts[m]);
    for (let k = 0; k < NB; k++) {
      const f = (8000 * k) / (NB - 1);
      const lower = (f - pts[m]) / (pts[m + 1] - pts[m]), upper = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
      W[m * NB + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return W;
})();
const WIN = Float32Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
const COS = new Float32Array(NB * N_FFT), SIN = new Float32Array(NB * N_FFT);
for (let k = 0; k < NB; k++) for (let n = 0; n < N_FFT; n++) { const a = (2 * Math.PI * k * n) / N_FFT; COS[k * N_FFT + n] = Math.cos(a); SIN[k * N_FFT + n] = Math.sin(a); }

function logMel(audio) {
  const x = new Float32Array(N_SAMPLES + 2 * 200);          // up to 30 s, zero padded, reflect-padded edges
  const a = new Float32Array(N_SAMPLES); a.set(audio.subarray(0, N_SAMPLES));
  x.set(a, 200);
  for (let i = 1; i <= 200; i++) { x[200 - i] = a[i]; x[200 + N_SAMPLES - 1 + i] = a[N_SAMPLES - 1 - i]; }
  const mel = new Float32Array(N_MELS * N_FRAMES), fr = new Float32Array(N_FFT), pw = new Float32Array(NB);
  const used = Math.min(N_FRAMES, Math.ceil(audio.length / HOP) + 2);
  let mx = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    if (t < used) {
      for (let n = 0; n < N_FFT; n++) fr[n] = x[t * HOP + n] * WIN[n];
      for (let k = 0; k < NB; k++) {
        let re = 0, im = 0; const o = k * N_FFT;
        for (let n = 0; n < N_FFT; n++) { re += fr[n] * COS[o + n]; im += fr[n] * SIN[o + n]; }
        pw[k] = re * re + im * im;
      }
    } else pw.fill(0);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0; const o = m * NB;
      for (let k = 0; k < NB; k++) s += FILT[o + k] * pw[k];
      const v = Math.log10(Math.max(s, 1e-10));
      mel[m * N_FRAMES + t] = v; if (v > mx) mx = v;
    }
  }
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], mx - 8) + 4) / 4;
  return mel;
}

// ------------------------------------------------------------------ greedy decoding
async function transcribeChunk(audio) {
  const { cfg, enc, dec, vocab } = M;
  const { k: ck, v: cv } = await (async () => {
    const out = await enc.run({ mel: new ort.Tensor("float32", logMel(audio), [1, N_MELS, N_FRAMES]) });
    return { k: out.n_layer_cross_k, v: out.n_layer_cross_v };
  })();
  const shape = [cfg.n_layer, 1, cfg.n_ctx, cfg.n_state];
  let kc = new ort.Tensor("float32", new Float32Array(shape.reduce((a, b) => a * b)), shape);
  let vc = new ort.Tensor("float32", new Float32Array(shape.reduce((a, b) => a * b)), shape);
  let cur = [cfg.sot, cfg.no_timestamps], offset = 0;
  const out = [], banned = new Set(cfg.non_speech);
  let noSpeech = 0, sumLp = 0;
  for (let step = 0; step < 224; step++) {
    const r = await dec.run({
      tokens: new ort.Tensor("int64", BigInt64Array.from(cur.map(BigInt)), [1, cur.length]),
      in_n_layer_self_k_cache: kc, in_n_layer_self_v_cache: vc, n_layer_cross_k: ck, n_layer_cross_v: cv,
      offset: new ort.Tensor("int64", BigInt64Array.from([BigInt(offset)]), [1]),
    });
    kc = r.out_n_layer_self_k_cache; vc = r.out_n_layer_self_v_cache;
    offset += cur.length;
    const V = r.logits.dims[2], L = r.logits.data, last = (cur.length - 1) * V;
    if (step === 0) {                      // probability of "no speech" right after the start token
      let m = -Infinity, s = 0;
      for (let i = 0; i < V; i++) m = Math.max(m, L[i]);
      for (let i = 0; i < V; i++) s += Math.exp(L[i] - m);
      noSpeech = Math.exp(L[cfg.no_speech] - m) / s;
    }
    let best = -1, bv = -Infinity, m = -Infinity, s = 0;
    for (let i = 0; i < V; i++) {
      const x = L[last + i];
      if (x > m) m = x;
      if (banned.has(i) || (i > cfg.eot) || (step === 0 && (i === cfg.eot || i === cfg.blank))) continue;
      if (x > bv) { bv = x; best = i; }
    }
    for (let i = 0; i < V; i++) s += Math.exp(L[last + i] - m);
    sumLp += bv - m - Math.log(s);
    if (best === cfg.eot) break;
    out.push(best);
    cur = [best];
    // stop endless repetitions ("the the the …")
    const n = out.length;
    if (n >= 12 && out.slice(n - 4).join() === out.slice(n - 8, n - 4).join() && out.slice(n - 8, n - 4).join() === out.slice(n - 12, n - 8).join()) { out.length = n - 8; break; }
  }
  const bytes = out.flatMap((t) => Array.from(vocab[t] || []));
  const text = new TextDecoder().decode(new Uint8Array(bytes)).trim();
  return { text, noSpeech, avgLogProb: out.length ? sumLp / out.length : 0 };
}

self.onmessage = async (e) => {
  const { id, chunks } = e.data;
  try {
    await load();
    const texts = [];
    for (let i = 0; i < chunks.length; i++) {
      post({ type: "progress", stage: "run", part: i + 1, parts: chunks.length });
      const r = await transcribeChunk(chunks[i]);
      // silence: Whisper may invent a sentence ("Thank you.") when nobody speaks
      if (r.noSpeech > 0.6 && r.avgLogProb < -0.7) continue;
      if (r.text) texts.push(r.text);
    }
    post({ type: "done", id, text: texts.join(" ").replace(/\s+/g, " ").trim() });
  } catch (err) {
    post({ type: "error", id, message: String(err?.message || err) });
  }
};
