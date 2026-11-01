// Курсор не должен пропадать из поля, а страница не должна прыгать, пока студент печатает:
// ни после автосохранения (пауза в наборе), ни когда преподаватель меняет метки или проверяет упражнение.
// Запуск: python3 -m http.server 5055 -d docs &  node tests/focus.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055";
let mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
// как настоящий Firestore: поля map приходят с сервера отсортированными по ключу
mock = mock.replace("const snapDoc = (path, data) => ({", `const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" && !("__ts" in v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const snapDoc = (path, data0, data = sortKeys(data0)) => ({`);
const course = readFileSync(new URL("../content-private/test-fixture.json", import.meta.url), "utf8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
const errors = [];
const page = async (url) => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept()); await p.goto(BASE + url); return p; };
const sel = (ex, it) => `[data-ex="${ex}"][data-item="${it}"]`;

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
await s.waitForSelector("#ex-m4");

// студент отмечает Done сначала у m3, потом у m2 (не по алфавиту)
for (const ex of ["m3", "m2"]) { await s.click(`[data-done="${ex}"]`); await s.waitForTimeout(400); }
await s.waitForTimeout(1500);

const state = () => s.evaluate(() => ({ ex: document.activeElement?.dataset?.ex, item: document.activeElement?.dataset?.item, y: Math.round(document.querySelector('[data-ex="m4"][data-item="2"]').getBoundingClientRect().top), caret: document.activeElement?.selectionStart }));
const field = s.locator(sel("m4", "2"));
await field.scrollIntoViewIfNeeded(); await s.mouse.wheel(0, 120); await s.waitForTimeout(200);
await field.click(); await s.keyboard.type("wi");
const before = await state();
let fails = [];
const check = async (label) => {
  const now = await state();
  console.log(label, JSON.stringify(now));
  if (now.ex !== "m4" || now.item !== "2") fails.push(label + ": курсор пропал");
  if (Math.abs(now.y - before.y) > 2) fails.push(label + `: поле сдвинулось на экране ${before.y} > ${now.y}`);
};
console.log("before", JSON.stringify(before));
await s.waitForTimeout(2500); await check("1. пауза в наборе (автосохранение)");
await s.keyboard.type("t"); await s.waitForTimeout(2500); await check("2. ещё одна пауза");

// преподаватель ставит метку In-Class у другого упражнения
await t.click('.sb-uh[data-unit="u1"]').catch(() => {});
await t.click('.sb-item:has-text("Warm-up")');
await t.waitForSelector('[data-act="plan-as"][data-ex="m5"]');
await t.click('[data-act="plan-as"][data-ex="m5"][data-as="class"]');
await s.waitForTimeout(1200); await check("3. преподаватель поставил In-Class");
// преподаватель проверяет другое упражнение
await t.click('[data-act="check-ex"][data-ex="m1"]');
await s.waitForTimeout(1500); await check("4. преподаватель проверил 1.1.1");
await s.keyboard.type("h");
await s.waitForTimeout(1500);
const v = await field.inputValue();
console.log("value:", v);
if (v !== "with") fails.push("значение поля: " + v);
console.log(fails.length ? "FAIL\n - " + fails.join("\n - ") : "OK");
if (errors.length) console.log("page errors:", errors);
await browser.close();
process.exit(fails.length ? 1 : 0);
