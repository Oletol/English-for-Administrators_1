// Мок Firebase для UI-тестов в браузере (без сети и эмуляторов).
// Подменяет docs/js/fb.js. Данные — в localStorage, «реальное время» между
// вкладками — через событие storage. Правила безопасности НЕ проверяются
// (их проверяют tests/rules.test.mjs в эмуляторе Firestore).
const LS_DB = "mock:db", LS_AUTH = "mock:auth";
const load = (k) => JSON.parse(localStorage.getItem(k) || "{}");
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

class Timestamp {
  constructor(ms) { this.ms = ms; }
  toDate() { return new Date(this.ms); }
  toMillis() { return this.ms; }
}
const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    if ("__ts" in v) return new Timestamp(v.__ts);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};
const SENT = Symbol("sentinel");
export const serverTimestamp = () => ({ [SENT]: "ts" });
export const arrayUnion = (...a) => ({ [SENT]: "union", a });
export const arrayRemove = (...a) => ({ [SENT]: "remove", a });
function resolve(v, old) {
  if (v && v[SENT] === "ts") return { __ts: Date.now() };
  if (v && v[SENT] === "union") { const r = [...(old || [])]; v.a.forEach((x) => r.includes(x) || r.push(x)); return r; }
  if (v && v[SENT] === "remove") return (old || []).filter((x) => !v.a.includes(x));
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map((x) => resolve(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, old?.[k])]));
  return v;
}

// ---------------- auth ----------------
const authListeners = new Set();
const session = () => JSON.parse(sessionStorage.getItem("mock:session") || "null");
export const auth = { get currentUser() { return session(); } };
const fire = () => authListeners.forEach((cb) => cb(mkUser(session())));
function mkUser(u) {
  if (!u) return null;
  return { ...u, async delete() { const a = load(LS_AUTH); delete a[u.email]; save(LS_AUTH, a); sessionStorage.removeItem("mock:session"); fire(); } };
}
export function onAuthStateChanged(_a, cb) { authListeners.add(cb); setTimeout(() => cb(mkUser(session())), 0); return () => authListeners.delete(cb); }
const err = (code) => Object.assign(new Error(code), { code });
export async function signInWithEmailAndPassword(_a, email, password) {
  const u = load(LS_AUTH)[email];
  if (!u || u.password !== password) throw err("auth/invalid-credential");
  sessionStorage.setItem("mock:session", JSON.stringify({ uid: u.uid, email }));
  fire();
  return { user: mkUser(session()) };
}
export async function createUserWithEmailAndPassword(_a, email, password) {
  const a = load(LS_AUTH);
  if (a[email]) throw err("auth/email-already-in-use");
  if ((password || "").length < 6) throw err("auth/weak-password");
  a[email] = { uid: "u" + Math.random().toString(36).slice(2, 10), password };
  save(LS_AUTH, a);
  sessionStorage.setItem("mock:session", JSON.stringify({ uid: a[email].uid, email }));
  fire();
  return { user: mkUser(session()) };
}
export async function sendPasswordResetEmail() {}
export async function signOut() { sessionStorage.removeItem("mock:session"); fire(); }

// ---------------- firestore ----------------
export const db = {};
export const doc = (_db, coll, id) => ({ kind: "doc", coll, id, path: `${coll}/${id}` });
export const collection = (_db, coll) => ({ kind: "coll", coll });
export const where = (field, op, value) => ({ t: "where", field, op, value });
export const orderBy = (field) => ({ t: "order", field });
export const query = (c, ...cons) => ({ kind: "query", coll: c.coll, cons });

const snapDoc = (path, data) => ({
  id: path.split("/")[1], exists: () => data !== undefined, data: () => (data === undefined ? undefined : revive(structuredClone(data))),
  metadata: { hasPendingWrites: false },
});
function runQuery(q) {
  const all = load(LS_DB);
  let rows = Object.entries(all).filter(([p]) => p.startsWith(q.coll + "/"));
  for (const c of q.cons || []) {
    if (c.t === "where") rows = rows.filter(([, d]) => (c.op === "==" ? d[c.field] === c.value : true));
  }
  for (const c of q.cons || []) if (c.t === "order") rows.sort((a, b) => (a[1][c.field] > b[1][c.field] ? 1 : -1));
  return { docs: rows.map(([p, d]) => snapDoc(p, d)), empty: !rows.length };
}
export async function getDoc(ref) { await tick(); return snapDoc(ref.path, load(LS_DB)[ref.path]); }
export async function getDocs(q) { await tick(); return runQuery(q.kind === "coll" ? { coll: q.coll } : q); }

function write(mutator) { const all = load(LS_DB); mutator(all); save(LS_DB, all); notify(); }
function deepMerge(old, add) {
  if (!old || typeof old !== "object" || Array.isArray(old) || !add || typeof add !== "object" || Array.isArray(add) || "__ts" in add) return add;
  const out = { ...old };
  for (const [k, v] of Object.entries(add)) out[k] = deepMerge(old[k], v);
  return out;
}
function applyPaths(obj, data) {
  const out = structuredClone(obj || {});
  for (const [k, v] of Object.entries(data)) {
    const parts = k.split(".");
    let cur = out;
    for (const p of parts.slice(0, -1)) { cur[p] ??= {}; cur = cur[p]; }
    const last = parts.at(-1);
    cur[last] = resolve(v, cur[last]);
  }
  return out;
}
export async function setDoc(ref, data, opts) {
  await tick();
  write((all) => { all[ref.path] = opts?.merge ? deepMerge(all[ref.path] || {}, resolve(data, all[ref.path])) : resolve(data); });
}
export async function updateDoc(ref, data) {
  await tick();
  const all = load(LS_DB);
  if (!all[ref.path]) throw err("not-found");
  write((a) => { a[ref.path] = applyPaths(a[ref.path], data); });
}
export async function deleteDoc(ref) { await tick(); write((all) => { delete all[ref.path]; }); }
export function writeBatch() {
  const ops = [];
  return {
    set: (r, d, o) => ops.push(() => setDoc(r, d, o)),
    update: (r, d) => ops.push(() => updateDoc(r, d)),
    delete: (r) => ops.push(() => deleteDoc(r)),
    async commit() { for (const op of ops) await op(); },
  };
}

const listeners = new Set();
export function onSnapshot(ref, next) {
  const run = () => {
    if (ref.kind === "doc") next(snapDoc(ref.path, load(LS_DB)[ref.path]));
    else next(runQuery(ref.kind === "coll" ? { coll: ref.coll } : ref));
  };
  const l = { run, last: null };
  l.check = () => { const key = ref.kind === "doc" ? JSON.stringify(load(LS_DB)[ref.path] ?? null) : JSON.stringify(runQuery(ref.kind === "coll" ? { coll: ref.coll } : ref).docs.map((d) => [d.id, d.data()])); if (key !== l.last) { l.last = key; run(); } };
  listeners.add(l);
  setTimeout(l.check, 0);
  return () => listeners.delete(l);
}
function notify() { setTimeout(() => listeners.forEach((l) => l.check()), 0); }
window.addEventListener("storage", (e) => { if (e.key === LS_DB) notify(); });
const tick = () => new Promise((r) => setTimeout(r, 5));
