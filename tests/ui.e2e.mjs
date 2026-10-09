// Сквозной UI-сценарий на мок-Firebase: преподаватель + два студента.
// Запуск: python3 -m http.server 5055 -d docs &  node tests/ui.e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = "http://127.0.0.1:5055";
const SHOTS = process.env.SHOTS || "/tmp/shots";
mkdirSync(SHOTS, { recursive: true });
const mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
const course = readFileSync(new URL("../content-private/course.json", import.meta.url), "utf8");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route("**/js/fb.js", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
const errors = [];
const page = async (url) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(url + ": " + e.message));
  p.on("dialog", (d) => d.accept());
  await p.goto(BASE + url);
  return p;
};
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false });
const step = (t) => console.log("•", t);

// --- seed: аккаунт преподавателя (в реальном проекте — через консоль Firebase)
const t = await page("/teacher.html");
await t.evaluate(() => {
  localStorage.setItem("mock:auth", JSON.stringify({ "teacher@uni.ru": { uid: "T1", password: "secret1" } }));
  localStorage.setItem("mock:db", JSON.stringify({ "teachers/T1": { name: "Teacher" } }));
});
await t.reload();

step("Преподаватель входит");
await t.fill("#auth-form [name=email]", "teacher@uni.ru");
await t.fill("#auth-form [name=password]", "secret1");
await t.click("#auth-submit");
await t.waitForSelector("#tool-nav .sb-item");

step("Импорт курса");
await t.click('a[href="#tools/content"]');
await t.waitForSelector("#import-text");
await t.evaluate((c) => { document.querySelector("#import-text").value = c; }, course);
await t.click("[data-act=import]");
await t.waitForSelector("td:has-text(\"Modern Technologies\")");
const stored = await t.evaluate(() => JSON.parse(localStorage.getItem("mock:db")));
assert.ok(!JSON.stringify(stored["unitContent/u1"]).includes('"answer"'), "в unitContent не должно быть ключей");
assert.ok(!JSON.stringify(stored["unitContent/u1"]).includes("Demo teacher's note"), "заметки преподавателя не должны попадать в unitContent");
assert.equal(stored["answerKeys/u1"].exercises.g1["1"], "sends");
await t.click('.sb-uh[data-unit="u1"]');
await t.click('.sb-item:has-text("Reading")');
await t.waitForSelector(".keyhint");
await t.waitForSelector(".tnote");
await shot(t, "01-teacher-preview-keys");

step("Создание группы");
await t.click('a[href="#tools/groups"]');
await t.waitForSelector("#g-name");
await t.fill("#g-name", "Public Administration 21");
await t.fill("#g-code", "pa-21");
await t.click("[data-act=create-group]");
await t.waitForSelector("code:text('PA-21')");

step("Студент 1 регистрируется");
const s1 = await page("/index.html");
await s1.click("[data-mode=register]");
await s1.fill("[name=name]", "Anna Ivanova");
await s1.fill("[name=email]", "anna@uni.ru");
await s1.fill("[name=password]", "pass123");
await s1.fill("[name=group]", "pa-21");
await s1.click("#auth-submit");
await s1.waitForSelector("text=No units are open yet");
assert.equal(await s1.locator(".sb-item").count(), 0);
assert.equal(await s1.locator(".sb-uh").count(), 16);
await shot(s1, "02-student-locked");

step("Преподаватель открывает Unit 1 → у студента появляется без перезагрузки");
await t.click('a[href="#tools/access"]');
await t.click("[data-act=toggle-open][data-unit=u1]");
await s1.waitForSelector('.sb-uh[data-unit="u1"][data-can-open="1"]', { timeout: 5000 });
await s1.click('.sb-uh[data-unit="u1"]');
await s1.click('.sb-item:has-text("Reading")');
await s1.waitForSelector("#ex-r2");

step("Студент 1 отвечает; черновик сохраняется");
const sel = (ex, it) => `[data-ex="${ex}"][data-item="${it}"]`;
for (const [i, v] of [["1", "c"], ["2", "b"], ["3", "f"], ["4", "d"]]) await s1.selectOption(sel("r2", i), v);
await s1.check(`${sel("r3", "1")}[value=B]`);
await s1.check(`${sel("r3", "2")}[value=A]`);
await s1.click('.sb-item:has-text("Grammar in Use")');
await s1.fill(sel("g1", "1"), "sends");
await s1.fill(sel("g1", "2"), "gives");
await s1.fill(sel("g1", "5"), "dont understand");
await s1.fill(sel("g1", "10"), "Are you avoiding");
await s1.click('.sb-item:has-text("Writing")');
await s1.fill(sel("w2", "1"), "Miscommunication often starts with the wrong channel. Last year our dean's office sent exam changes by email only...");
await s1.locator("#save-state", { hasText: /Saved|saved/ }).waitFor({ timeout: 5000 });
await s1.reload();
await s1.click('.sb-item:has-text("Grammar in Use")');
assert.equal(await s1.inputValue(sel("g1", "2")), "gives", "черновик восстановлен после перезагрузки");

step("Преподаватель видит черновик в реальном времени");
await t.selectOption("#ctx-unit", "u1");
await t.click('a[href="#tools/works"]');
await t.waitForSelector("text=Anna Ivanova");
await t.waitForSelector(".pill.warn:text('draft')");

step("Студент 1 сдаёт работу");
await s1.click("#submit-unit");
await s1.waitForSelector(".ub-sub");
assert.equal(await s1.locator(sel("g1", "1")).isDisabled(), true);

step("Студент 2 регистрируется, отвечает и сдаёт");
const s2 = await page("/index.html");
await s2.evaluate(() => sessionStorage.clear());
await s2.reload();
await s2.click("[data-mode=register]");
await s2.fill("[name=name]", "Boris Petrov");
await s2.fill("[name=email]", "boris@uni.ru");
await s2.fill("[name=password]", "pass123");
await s2.fill("[name=group]", "PA-21");
await s2.click("#auth-submit");
await s2.click('.sb-uh[data-unit="u1"]');
await s2.click('.sb-item:has-text("Grammar in Use")');
await s2.fill(sel("g1", "1"), "sends");
await s2.fill(sel("g1", "2"), "is give");
await s2.click("#submit-unit");
await s2.waitForSelector(".ub-sub");

step("Преподаватель оценивает открытый ответ");
await t.waitForSelector("text=Boris Petrov");
await t.click("tr:has-text('Anna Ivanova') [data-act=select-student]");
await t.waitForSelector("#detail .g-score");
await t.fill("#detail .g-score", "8");
await t.fill("#detail .g-comment", "Good topic sentence; add one more example.");
await t.click("#detail [data-act=save-grades] >> nth=0");
await t.waitForSelector("text=Marks saved");
await shot(t, "03-teacher-works");

step("Результаты не видны студенту до включения проверки");
assert.equal(await s1.locator(".ub-res").count(), 0);

step("Преподаватель включает проверку → студент видит результат сразу");
await t.click('a[href="#tools/access"]');
await t.click("[data-act=release][data-unit=u1]");
await s1.waitForSelector(".ub-res", { timeout: 5000 });
const bar = await s1.textContent(".ub-res");
console.log("   студент 1:", bar.replace(/\s+/g, " ").trim());
await s1.click('.sb-item:has-text("Grammar in Use")');
await s1.waitForSelector(".gap.bad");
assert.equal(await s1.locator(`${sel("g1", "1")}.ok`).count(), 1);
assert.equal(await s1.locator(`${sel("g1", "5")}.ok`).count(), 0, "«dont understand» — неверно");
assert.equal(await s1.locator(`${sel("g1", "10")}.ok`).count(), 1, "регистр не важен");
await shot(s1, "04-student-results-grammar");
await s1.click('.sb-item:has-text("Writing")');
await s1.waitForSelector(".feedback:text('Good topic sentence')");
await shot(s1, "05-student-feedback");
await s2.waitForSelector(".ub-res");

step("Аналитика");
await t.selectOption("#ctx-unit", "u1");
await t.click('a[href="#tools/stats"]');
await t.waitForSelector("text=most difficult");
await shot(t, "06-teacher-stats");
const statsText = await t.textContent("#view");
assert.ok(statsText.includes("“is give” ×1"), "частые ошибки показаны");

step("Боковая панель сворачивается");
await t.click(".topbar .burger");
await t.waitForTimeout(400);
assert.equal(await t.evaluate(() => document.body.classList.contains("sb-collapsed")), true);
assert.equal(await t.evaluate(() => getComputedStyle(document.querySelector(".main")).marginLeft), "0px");
await shot(t, "08-teacher-collapsed");
await t.click(".topbar .burger");
await t.waitForTimeout(300);
await t.click('.sb-uh[data-unit="u1"]');
await t.click('.sb-item:has-text("Grammar in Use")');
await t.waitForSelector(".keyhint");
await shot(t, "09-teacher-unit-keys");

step("Мобильная ширина");
await s1.setViewportSize({ width: 390, height: 800 });
await s1.waitForTimeout(500);
await shot(s1, "07-student-mobile");
await s1.click(".topbar .burger");
await s1.waitForTimeout(400);
await shot(s1, "10-student-mobile-menu");
const overflow = await s1.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
assert.equal(overflow, false, "нет горизонтальной прокрутки");

assert.deepEqual(errors, [], "JS-ошибки на страницах");
console.log("\nВСЕ ШАГИ ПРОЙДЕНЫ");
await browser.close();
