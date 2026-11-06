// Teacher: Speaking / Writing progress (table, chart, In-Class vs HA, cards), "Answers shown" on a unit page,
// student switcher in Student work, Analytics with drafts. Students' work is put straight into the mock database.
// Run: python3 -m http.server 5055 -d docs &  node tests/progress.e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055";
const SHOTS = process.env.SHOTS || "/tmp/shots-progress";
mkdirSync(SHOTS, { recursive: true });
const mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
const courseText = readFileSync(new URL("../content-private/course.json", import.meta.url), "utf8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
await ctx.route("https://api.languagetool.org/**", (r) => r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"matches":[]}' }));
const errors = [];
const t = await ctx.newPage();
t.on("pageerror", (e) => errors.push(e.message)); t.on("dialog", (d) => d.accept());
const step = (x) => console.log("•", x);
await t.goto(BASE + "/teacher.html");
await t.evaluate(() => { localStorage.setItem("mock:auth", JSON.stringify({ "teacher@uni.ru": { uid: "T1", password: "secret1" } })); localStorage.setItem("mock:db", JSON.stringify({ "teachers/T1": { name: "Teacher" } })); });
await t.reload();
await t.fill("#auth-form [name=email]", "teacher@uni.ru"); await t.fill("#auth-form [name=password]", "secret1"); await t.click("#auth-submit");
await t.waitForSelector("#tool-nav .sb-item");
assert.ok(await t.isVisible('a[href="#tools/writing"]'), "Writing progress in the sidebar");
await t.click('a[href="#tools/content"]');
await t.evaluate((c) => { document.querySelector("#import-text").value = c; }, courseText);
await t.click("[data-act=import]"); await t.waitForSelector("text=Imported");
await t.click('a[href="#tools/groups"]'); await t.waitForSelector("#g-name");
await t.fill("#g-name", "PA-21"); await t.fill("#g-code", "PA-21"); await t.click("[data-act=create-group]");
await t.waitForSelector("td:has-text('PA-21')");

step("Seeding three students with drafts");
await t.evaluate(() => {
  const db = JSON.parse(localStorage.getItem("mock:db"));
  const gid = Object.keys(db).find((k) => k.startsWith("groups/")).split("/")[1];
  const g = db["groups/" + gid];
  g.openUnits = ["u1", "u2"];
  g.plan = { u1: { p12: { as: "class" }, x7: { as: "home" }, s6: { as: "class" } }, u2: { w9: { as: "home" } } };
  const day = (d) => ({ __ts: Date.parse(`2026-10-${d}T10:00:00Z`) });
  const studs = [["S1", "Anna Ivanova", 1], ["S2", "Boris Petrov", 0.6], ["S3", "Vera Smirnova", 0.3]];
  const letterA = "Dear Sir or Madam, I am writing to complain about the online service of the city council. Although the website is modern, it is difficult to find the forms. ";
  const letterB = "Dear Editor, I would like to respond to the article about digital communication, which was published last week. Because officials rarely answer messages, citizens lose trust. However, I believe that clear rules could change this situation. ";
  for (const [uid, name, q] of studs) {
    db["users/" + uid] = { name, email: uid.toLowerCase() + "@uni.ru", groupId: gid };
    const m3 = {}; for (let i = 1; i <= 15; i++) m3[i] = i / 15 <= q ? "x" : "";
    db[`submissions/u1__${uid}`] = { uid, groupId: gid, unitId: "u1", status: "draft", updatedAt: day(20),
      answers: {
        m3: { 1: "rapport", 2: "wrong", 3: q > 0.5 ? "touch" : "xx" },
        p12: { 1: letterA.repeat(q > 0.5 ? 2 : 1) },
        x7: { 1: letterB.repeat(q > 0.5 ? 3 : 2) },
        s6: { 1: "I think that video calls are useful because you can see the face. What do you think? I see where you are coming from, but sometimes it is tiring.", 2: "Boris" },
        _speech: { s6: JSON.stringify({ speech: 50 + 20 * q, total: 80, wpm: Math.round(90 + 40 * q), pauses: Math.round(8 - 5 * q), longest: 3, at: Date.parse("2026-10-21T10:00:00Z") }) },
        _done: { m3: "1", p12: "1" },
      } };
    db[`submissions/u2__${uid}`] = { uid, groupId: gid, unitId: "u2", status: "draft", updatedAt: day(28),
      answers: { w9: { 1: "In my opinion time management is a skill which every civil servant needs, because the workload is heavy and deadlines are strict. ".repeat(1 + Math.round(q * 2)) },
        w8: { 1: "I always put off the most difficult tasks until the last minute.", 2: "If you miss the deadline, you will get a lower mark.", 3: "How long does it take you to get to university?" },
        _speech: { w9: JSON.stringify({ speech: 60, total: 75, wpm: Math.round(100 + 50 * q), pauses: Math.round(6 - 4 * q), longest: 2, at: Date.parse("2026-10-28T10:00:00Z") }) } } };
  }
  // the writing check of a translation (three items) for Anna: two issues in total
  db["exerciseResults/u2__S1"] = { uid: "S1", groupId: gid, unitId: "u2", feedback: { w8: {
    1: { text: "I always put off the most difficult tasks until the last minute.", issues: [{ type: "grammar", category: "Grammar" }] },
    2: { text: "If you miss the deadline, you will get a lower mark.", issues: [] },
    3: { text: "How long does it take you to get to university?", issues: [{ type: "grammar", category: "Grammar" }] } } } };
  localStorage.setItem("mock:db", JSON.stringify(db));
});
await t.reload(); await t.waitForSelector("#tool-nav .sb-item");

step("Writing progress");
await t.click('a[href="#tools/writing"]');
await t.waitForSelector(".t.prog");
const wtxt = await t.textContent("#view");
assert.match(wtxt, /Writing progress/); assert.match(wtxt, /Anna Ivanova/); assert.match(wtxt, /In class and at home/);
assert.ok(await t.locator(".prog-chart svg").count(), "chart");
assert.equal(await t.locator(".spk-card").count(), 3, "a card for each student");
assert.match(wtxt, /Translate into English/, "translations are on the Writing progress page");
assert.match(wtxt, /translation/);
await t.selectOption("#prog-kind", "translation");
await t.waitForTimeout(200);
assert.match(await t.textContent(".t.prog tbody"), /Anna Ivanova/);
assert.ok(!(await t.textContent(".prog-tasks")).includes("Write your letter"), "only translations");
await t.screenshot({ path: SHOTS + "/1b-translations.png", fullPage: true });
await t.selectOption("#prog-kind", "");
await t.waitForTimeout(200);
await t.screenshot({ path: SHOTS + "/1-writing.png", fullPage: true });
await t.selectOption("#prog-student", { label: "Boris Petrov" });
await t.waitForSelector(".prog-chart .st.one");
assert.equal(await t.locator(".spk-card").count(), 1);
await t.screenshot({ path: SHOTS + "/2-writing-one.png", fullPage: true });
await t.click('[data-act=prog-set][data-set=home]');
await t.waitForTimeout(200);
assert.equal(await t.locator(".t.prog thead th").first().locator("xpath=..").locator("th").count(), 4, "1 HA writing task: student + T1 + change + trend");

step("Speaking progress");
await t.click('[data-act=prog-set][data-set=""]');
await t.click('a[href="#tools/speaking"]');
await t.waitForSelector(".t.prog");
await t.selectOption("#prog-student", "");
await t.waitForTimeout(200);
await t.click(".t.prog tbody a[data-act=prog-open]");
await t.waitForSelector("#prog-detail");
await t.screenshot({ path: SHOTS + "/3-speaking.png", fullPage: true });

step("Pair discussions: matching the partner, copies, feedback for the partner");
const ptxt = await t.textContent("#view");
assert.match(ptxt, /Pair discussions: who was the partner\?/);
assert.match(ptxt, /1 not matched/, "Boris typed his own name");
await t.selectOption("#prog-student", { label: "Boris Petrov" });
await t.waitForTimeout(200);
assert.match(await t.textContent(".spk-card"), /recorded by Anna Ivanova|recorded by Vera Smirnova/, "Boris has the copy of the pair recording");
await t.selectOption("#prog-student", "");
await t.waitForTimeout(200);
// the teacher says that Boris recorded the discussion with Vera
await t.selectOption('.pair-sel[data-pair="u1|s6|S2"]', "S3");
await t.waitForSelector("text=1 not matched", { state: "detached" });
assert.match(await t.textContent(".pair-box summary"), /all matched/);
await t.screenshot({ path: SHOTS + "/3b-pairs.png", fullPage: true });
// the writing check of 1.6.5 sends the partner a copy of the text and the feedback
await t.evaluate(() => { location.hash = "#u1/speaking"; });
await t.waitForSelector('[data-act="check-writing"][data-ex="s6"]');
await t.click('[data-act="check-writing"][data-ex="s6"]');
await t.waitForSelector("text=sent to partners", { timeout: 30000 });
const fbS2 = await t.evaluate(() => JSON.parse(localStorage.getItem("mock:db"))["exerciseResults/u1__S2"]);
assert.ok(fbS2?.feedback?.s6?._pair?.text, "Boris got the copy");
assert.ok(fbS2.feedback.s6["1"], "and his own feedback is kept");
await t.selectOption("#view-as", "S2");
await t.waitForSelector("#ex-s6 .pair-fb");
await t.locator("#ex-s6").screenshot({ path: SHOTS + "/3c-pair-copy.png" });
await t.click(".viewas-bar [data-act=view-as]:has-text('Back to my practice')");
await t.click('a[href="#tools/speaking"]');
await t.waitForSelector(".t.prog");

step("Analytics with drafts");
await t.click('a[href="#tools/stats"]');
await t.waitForSelector(".stats-t");
assert.match(await t.textContent("#view"), /students with answers to check/);
await t.screenshot({ path: SHOTS + "/4-analytics.png", fullPage: true });

step("Answers shown on the unit page");
await t.click('.stats-t [data-act=view-unit-as]');
await t.waitForSelector(".viewas-bar.on");
await t.evaluate(() => { location.hash = "#u1/vocabulary"; });
await t.waitForTimeout(400);
await t.screenshot({ path: SHOTS + "/5-unit-as.png" });
await t.evaluate(() => { location.hash = "#u1/warmup"; });
await t.waitForTimeout(300);
assert.ok(await t.locator("#ex-m3 .gap.bad").count() >= 2, "the student's wrong answers are marked red");
assert.ok(await t.locator("#ex-m3 .gap[disabled]").count() > 0, "read-only");
const before = await t.inputValue("#view-as");
await t.click(".viewas-bar [data-act=view-as]:has-text('Next')");
await t.waitForTimeout(200);
assert.notEqual(await t.inputValue("#view-as"), before, "Next switches the student");
await t.click(".viewas-bar [data-act=view-as]:has-text('Back to my practice')");
await t.waitForTimeout(200);
assert.equal(await t.inputValue("#view-as"), "");

step("Student work switcher");
await t.click('a[href="#tools/works"]');
await t.click("[data-act=select-student] >> nth=0");
await t.waitForSelector("#works-student");
await t.click("#detail [data-act=select-student]:has-text('Next')");
await t.waitForTimeout(300);
assert.match(await t.textContent("#detail h2"), /Boris|Vera/);
await t.screenshot({ path: SHOTS + "/6-works.png" });

const html = await t.content();
for (const ch of ["→", "←", "«", "»", "‹", "›"]) assert.ok(!html.includes(ch), "arrow " + ch);
assert.deepEqual(errors, []);
console.log("ALL OK");
await browser.close();
