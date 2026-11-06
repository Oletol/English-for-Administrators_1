// Pair discussion: the partner is chosen from a list of the group (names kept by the Teacher's Edition in groups/{gid}.roster).
// Run: python3 -m http.server 5055 -d docs &  node tests/partner.e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055";
const SHOTS = process.env.SHOTS || "/tmp/shots-partner";
mkdirSync(SHOTS, { recursive: true });
const mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
const courseText = readFileSync(new URL("../content-private/course.json", import.meta.url), "utf8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
const errors = [];
const page = async (url) => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(url + ": " + e.message)); p.on("dialog", (d) => d.accept()); await p.goto(BASE + url); return p; };
const step = (x) => console.log("•", x);

const t = await page("/teacher.html");
await t.evaluate(() => { localStorage.setItem("mock:auth", JSON.stringify({ "teacher@uni.ru": { uid: "T1", password: "secret1" } })); localStorage.setItem("mock:db", JSON.stringify({ "teachers/T1": { name: "Teacher" } })); });
await t.reload();
await t.fill("#auth-form [name=email]", "teacher@uni.ru"); await t.fill("#auth-form [name=password]", "secret1"); await t.click("#auth-submit");
await t.waitForSelector("#tool-nav .sb-item");
await t.click('a[href="#tools/content"]');
await t.evaluate((c) => { document.querySelector("#import-text").value = c; }, courseText);
await t.click("[data-act=import]"); await t.waitForSelector("text=Imported");
await t.click('a[href="#tools/groups"]'); await t.waitForSelector("#g-name");
await t.fill("#g-name", "PA-21"); await t.fill("#g-code", "PA-21"); await t.click("[data-act=create-group]");
await t.waitForSelector("td:has-text('PA-21')");
await t.click('a[href="#tools/access"]');
await t.click('[data-act="toggle-open"][data-unit="u1"]');
await t.waitForTimeout(300);

step("Two students register");
const s = await page("/index.html");
for (const [name, email] of [["Boris Petrov", "boris@uni.ru"], ["Anna Ivanova", "anna@uni.ru"]]) {
  await s.evaluate(() => sessionStorage.clear()); await s.reload();
  await s.click("[data-mode=register]");
  await s.fill("[name=name]", name); await s.fill("[name=email]", email); await s.fill("[name=password]", "pass123"); await s.fill("[name=group]", "PA-21");
  await s.click("#auth-submit"); await s.waitForSelector(".cards .pg");
}

step("The Teacher's Edition keeps the names of the group");
await t.reload(); await t.waitForSelector("#tool-nav .sb-item");
await t.click('a[href="#tools/works"]');
await t.waitForTimeout(800);
const roster = await t.evaluate(() => { const db = JSON.parse(localStorage.getItem("mock:db")); const g = Object.entries(db).find(([k]) => k.startsWith("groups/"))[1]; return g.roster; });
assert.deepEqual(roster.map((r) => r.name), ["Anna Ivanova", "Boris Petrov"]);
assert.ok(!JSON.stringify(roster).includes("@"), "no e-mails in the roster");

step("Anna chooses Boris from the list in 1.6.5");
await s.reload(); await s.waitForSelector(".cards .pg");
await s.evaluate(() => { location.hash = "#u1/speaking"; });
await s.waitForSelector("#ex-s6 select.partner-sel");
const opts = await s.$$eval("#ex-s6 select.partner-sel option", (o) => o.map((x) => x.textContent));
assert.deepEqual(opts, ["choose your partner…", "Boris Petrov"], "only the classmates, not Anna herself");
await s.selectOption("#ex-s6 select.partner-sel", { label: "Boris Petrov" });
await s.waitForTimeout(1500);
await s.locator("#ex-s6").screenshot({ path: SHOTS + "/student-partner.png" });
const saved = await s.evaluate(() => { const db = JSON.parse(localStorage.getItem("mock:db")); const k = Object.keys(db).find((x) => x.startsWith("submissions/u1__")); return db[k]?.answers?.s6?.["2"]; });
const boris = roster.find((r) => r.name === "Boris Petrov").uid;
assert.equal(saved, boris, "the partner is saved as Boris's id");

const html = await s.content();
for (const ch of ["→", "←", "«", "»", "‹", "›"]) assert.ok(!html.includes(ch), "arrow " + ch);
assert.deepEqual(errors, []);
console.log("ALL OK");
await browser.close();
