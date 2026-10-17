// Гонка: преподаватель проверяет упражнение, пока у студента есть несохранённые ответы в нём.
// Запуск: python3 -m http.server 5055 -d docs &  node tests/race.e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055", SHOTS = process.env.SHOTS || "/tmp/shots-race";
mkdirSync(SHOTS, { recursive: true });
let mock = readFileSync(new URL("../tests/mock-fb.js", import.meta.url), "utf8");
// правило Firestore: ответы в уже проверенных упражнениях менять нельзя
mock = mock.replace("export async function setDoc(ref, data, opts) {\n  await tick();", `export async function setDoc(ref, data, opts) {
  await tick();
  if (ref.coll === "submissions" && !sessionStorage.getItem("mock:teacher")) {
    const all = load(LS_DB), old = all[ref.path];
    const g = all["groups/" + data.groupId] || {};
    for (const ex of (g.releasedEx || {})[data.unitId] || [])
      if (JSON.stringify(old?.answers?.[ex] ?? null) !== JSON.stringify(data.answers?.[ex] ?? null)) throw err("permission-denied");
  }`);
const course = readFileSync(new URL("../content-private/test-fixture.json", import.meta.url), "utf8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
const errors = [];
const page = async (url) => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept()); await p.goto(BASE + url); return p; };
const sel = (ex, it) => `[data-ex="${ex}"][data-item="${it}"]`;
const db = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("mock:db")));

const t = await page("/teacher.html");
await t.evaluate(() => { localStorage.setItem("mock:auth", JSON.stringify({ "teacher@uni.ru": { uid: "T1", password: "secret1" } })); localStorage.setItem("mock:db", JSON.stringify({ "teachers/T1": { name: "T" } })); sessionStorage.setItem("mock:teacher", "1"); });
await t.reload();
await t.fill("#auth-form [name=email]", "teacher@uni.ru"); await t.fill("#auth-form [name=password]", "secret1"); await t.click("#auth-submit");
await t.waitForSelector("#tool-nav .sb-item");
await t.click('a[href="#tools/content"]'); await t.waitForSelector("#import-text");
await t.evaluate((c) => { document.querySelector("#import-text").value = c; }, course);
await t.click("[data-act=import]"); await t.waitForSelector('td:has-text("Modern Technologies")');
await t.click('a[href="#tools/groups"]'); await t.waitForSelector("#g-name");
await t.fill("#g-name", "PA"); await t.fill("#g-code", "PA-21"); await t.click("[data-act=create-group]"); await t.waitForSelector("code:text('PA-21')");
await t.click('a[href="#tools/access"]'); await t.click("[data-act=toggle-open][data-unit=u1]");

const s = await page("/index.html");
await s.click("[data-mode=register]");
await s.fill("[name=name]", "Anna"); await s.fill("[name=email]", "anna@uni.ru"); await s.fill("[name=password]", "pass123"); await s.fill("[name=group]", "pa-21");
await s.click("#auth-submit");
await s.waitForSelector('.sb-uh[data-unit="u1"][data-can-open="1"]');
await s.click('.sb-uh[data-unit="u1"]'); await s.click('.sb-item:has-text("Warm-up")');
await s.waitForSelector("#ex-m1");
const m1key = "b d e f a j n m h o i g l k c".split(" ");
for (let i = 1; i <= 5; i++) await s.fill(sel("m1", String(i)), m1key[i - 1]);
await s.waitForTimeout(2000); await s.screenshot({ path: SHOTS + "/s0.png" }); console.log("st0", await s.textContent("#unit-bar"));

// 1) студент вписывает ещё два ответа в 1.1.1, и преподаватель нажимает «Check» раньше, чем они сохранились
await t.click('.sb-uh[data-unit="u1"]').catch(() => {});
await t.click('.sb-item:has-text("Warm-up")');
await t.waitForSelector('[data-act="check-ex"][data-ex="m1"]');
await s.fill(sel("m1", "6"), m1key[5]);
await s.fill(sel("m1", "7"), m1key[6]);
await t.click('[data-act="check-ex"][data-ex="m1"]');
await s.waitForSelector("#ex-m1 .ex-score", { timeout: 5000 });
// 2) студент продолжает работу в другом упражнении
await s.fill(sel("m4", "1"), "with");
await s.fill(sel("m4", "2"), "out");
await s.waitForTimeout(2500);
await s.screenshot({ path: SHOTS + "/after.png", fullPage: false });
const st = await s.textContent("#save-state").catch(() => "");
console.log("save state:", st);
const d = await db(s);
const sub = Object.entries(d).find(([k]) => k.startsWith("submissions/"))[1];
console.log("server m4:", JSON.stringify(sub.answers.m4), "server m1:", JSON.stringify(sub.answers.m1));
assert.equal(sub.answers.m4?.["2"], "out", "ответы после проверки сохраняются");
// на экране в 1.1.1 — именно те ответы, которые проверены
assert.equal(await s.inputValue(sel("m1", "6")), sub.answers.m1?.["6"] ?? "", "в проверенном упражнении показано то, что проверено");
const score = (await s.textContent("#ex-m1 .ex-score")).trim();
const okCount = await s.locator("#ex-m1 .ok").count();
console.log("m1 score", score, "ok marks", okCount);
// 3) черновик в localStorage со «старыми» ответами в проверенном упражнении не ломает сохранение
await s.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("draft:")) { const v = JSON.parse(localStorage.getItem(k)); v.ts = Date.now() + 60000; v.answers.m1 = { "1": "z" }; v.answers.m4 = { ...(v.answers.m4 || {}), "3": "to" }; localStorage.setItem(k, JSON.stringify(v)); } });
const anyDraft = await s.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("draft:")).length);
if (!anyDraft) await s.evaluate(() => { const uid = JSON.parse(sessionStorage.getItem("mock:session")).uid; localStorage.setItem(`draft:${uid}:u1`, JSON.stringify({ ts: Date.now() + 60000, answers: { m1: { "1": "z" }, m4: { "1": "with", "2": "out", "3": "to" } } })); });
await s.reload();
await s.click('.sb-item:has-text("Warm-up")').catch(() => {});
await s.waitForSelector("#ex-m1 .ex-score");
await s.waitForTimeout(2500);
const d2 = await db(s);
const sub2 = Object.entries(d2).find(([k]) => k.startsWith("submissions/"))[1];
assert.equal(sub2.answers.m4?.["3"], "to", "локальный черновик сохранён");
assert.equal(sub2.answers.m1?.["1"], "b", "проверенное упражнение не изменилось");
assert.equal(await s.inputValue(sel("m1", "1")), "b");
assert.deepEqual(errors, []);
console.log("RACE TEST PASSED");
await browser.close();
