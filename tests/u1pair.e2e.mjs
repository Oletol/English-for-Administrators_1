// Unit 1 · 1.6 Step 3: one student records the pair discussion, transcribes it (Whisper in the browser),
// writes the partner's name; the teacher checks the writing (the name is not sent to LanguageTool and gets no
// points) and opens "Speaking progress", where the student's recordings are in order with the changes.
// Run: python3 -m http.server 5055 -d docs &  node tests/u1pair.e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055";
const SHOTS = process.env.SHOTS || "/tmp/shots-u1pair";
mkdirSync(SHOTS, { recursive: true });
const mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
const courseText = readFileSync(new URL("../content-private/course.json", import.meta.url), "utf8");
// the fake microphone plays a dialogue of two synthetic voices (Task 1, with two typical mistakes)
const WAV = process.env.WAV || new URL("./_dialogue.wav", import.meta.url).pathname;
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
const ltTexts = [];
await ctx.route("https://api.languagetool.org/**", async (r) => {
  const text = new URLSearchParams(r.request().postData()).get("text") || "";
  ltTexts.push(text);
  const i = text.search(/have misunderstood/i);
  const matches = i < 0 ? [] : [{ offset: i, length: 18, message: "Use the past simple with 'last week'.", shortMessage: "Tense",
    replacements: [{ value: "misunderstood" }], rule: { issueType: "grammar", category: { name: "Grammar" } } }];
  await r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ matches }) });
});
const errors = [];
const page = async (url) => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(url + ": " + e.message)); p.on("dialog", (d) => d.accept()); await p.goto(BASE + url); return p; };
const step = (t) => console.log("•", t);

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
await t.click('[data-act="toggle-open"][data-unit="u2"]');
await t.waitForTimeout(500);

const s = await page("/index.html");
await s.evaluate(() => sessionStorage.clear()); await s.reload();
await s.click("[data-mode=register]");
await s.fill("[name=name]", "Anna Ivanova"); await s.fill("[name=email]", "anna@uni.ru"); await s.fill("[name=password]", "pass123"); await s.fill("[name=group]", "PA-21");
await s.click("#auth-submit"); await s.waitForSelector(".cards .pg");

step("Student: 1.6 Step 4 is there, the transcript box is read-only, the goals are now 1.6.6");
await s.evaluate(() => { location.hash = "#u1/speaking"; });
await s.waitForSelector("#ex-s6 textarea.transcript[readonly]");
assert.equal((await s.textContent("#ex-s6 .ex-n")).trim(), "1.6.5");
assert.equal((await s.textContent("#ex-s5 .ex-n")).trim(), "1.6.6");
assert.equal(await s.locator('.spk[data-tr="s6"]').count(), 2, "both discussion recorders transcribe into 1.6.5");
const html = await s.content();
for (const ch of ["→", "←", "«", "»"]) assert.ok(!html.includes(ch), "arrow " + ch);

step("Student records Task 1 (about 50 s) and transcribes it");
const spk = s.locator('.spk[data-spk="blk-u1-sp-t1-disc"]').first();
await spk.locator("[data-spk-act=rec]").click();
await s.waitForSelector('.spk[data-spk="blk-u1-sp-t1-disc"] .btn.rec.on');
await s.waitForTimeout(52000);
await spk.locator("[data-spk-act=rec]").click();
await s.waitForSelector('.spk[data-spk="blk-u1-sp-t1-disc"] [data-spk-act=tr]', { timeout: 8000 });
const t0 = Date.now();
await spk.locator("[data-spk-act=tr]").first().click();
await s.waitForFunction(() => (document.querySelector('#ex-s6 textarea[data-item="1"]')?.value || "").length > 40, null, { timeout: 400000 });
const said = await s.inputValue('#ex-s6 textarea[data-item="1"]');
console.log(`   transcribed in ${Math.round((Date.now() - t0) / 1000)} s:\n   ${said}`);
assert.ok(/group chat/i.test(said) && /take your point/i.test(said), "the transcript is the discussion");
await s.fill('#ex-s6 [data-ex="s6"][data-item="2"]', "Ilya Petrov");
await s.waitForTimeout(2500);
await s.locator("#ex-s6").screenshot({ path: `${SHOTS}/student-s6.png` });
let db = await s.evaluate(() => JSON.parse(localStorage.getItem("mock:db")));
const subKey = Object.keys(db).find((k) => k.startsWith("submissions/u1__"));
const uid = subKey.split("__")[1];
const mt = JSON.parse(db[subKey].answers._speech.s6);
assert.ok(mt.at > 0 && mt.words > 30, "measurements with the date: " + JSON.stringify(mt));
assert.equal(db[subKey].answers.s6["2"], "Ilya Petrov");

step("An earlier recording (u2 2.1.10, alone, 3 weeks before) is put into the database to see the changes");
await s.evaluate(({ uid }) => {
  const all = JSON.parse(localStorage.getItem("mock:db"));
  all[`submissions/u2__${uid}`] = { uid, groupId: all[`users/${uid}`].groupId, unitId: "u2", status: "draft", updatedAt: { __ts: Date.now() - 864e5 * 21 },
    answers: { w9: { 1: "I have card number five. I think I usually put off my work. Er, I waste time on my phone and I am behind schedule always." },
      _speech: { w9: JSON.stringify({ total: 60, speech: 40, words: 26, wpm: 70, pauses: 9, longest: 3.1, at: Date.now() - 864e5 * 21 }) } } };
  localStorage.setItem("mock:db", JSON.stringify(all));
}, { uid });

step("Teacher: Check the writing in 1.6.5; the partner's name is not checked and gets no points");
await t.evaluate(() => { location.hash = "#u1/speaking"; });
await t.waitForSelector('[data-act="check-writing"][data-ex="s6"]');
await t.click('[data-act="check-writing"][data-ex="s6"]');
await t.waitForSelector('[data-act="check-writing"][data-ex="s6"]:has-text("Check again")', { timeout: 30000 });
assert.ok(ltTexts.length >= 1 && ltTexts.every((x) => !x.includes("Ilya Petrov")), "the partner's name is not sent to LanguageTool");
db = await t.evaluate(() => JSON.parse(localStorage.getItem("mock:db")));
const fb = db[`exerciseResults/u1__${uid}`].feedback.s6;
assert.ok(fb["1"] && !fb["2"], "feedback only for the discussion text");
console.log("   discussion phrases found:", fb["1"].vocab.unitUsed.join(", "));
await s.waitForSelector("#ex-s6 .wfb", { timeout: 15000 });
assert.ok(/Feedback on your speaking/.test(await s.textContent("#ex-s6 .wfb")));
await s.locator("#ex-s6").screenshot({ path: `${SHOTS}/student-s6-feedback.png` });

step("Teacher: Student work shows a score box only for the discussion text");
await t.click('a[href="#tools/works"]');
await t.waitForSelector(`[data-act="select-student"][data-uid="${uid}"]`);
await t.click(`[data-act="select-student"][data-uid="${uid}"]`);
await t.waitForSelector('#detail .g-score[data-ex="s6"]', { timeout: 10000 });
assert.equal(await t.locator('#detail .g-score[data-ex="s6"]').count(), 1);
assert.equal(await t.locator('#detail .g-score[data-ex="s6"][data-item="1"]').getAttribute("max"), "3");

step("Teacher: Speaking progress");
await t.click('a[href="#tools/speaking"]');
await t.waitForSelector(".spk-card", { timeout: 20000 });
const txt = await t.textContent("#view");
console.log("   " + txt.replace(/\s+/g, " ").match(/Anna Ivanova.{0,700}/)[0]);
assert.ok(/2 recordings/.test(txt) && /pair with Ilya Petrov/.test(txt) && /alone/.test(txt), "both recordings are listed");
assert.ok(/First and last recording \(2\.1\.10 and 1\.6\.5\)/.test(txt), "the change line compares the first and the last recording");
assert.ok(/grammar per 100 words|not checked/.test(txt));
for (const ch of ["→", "←", "↑", "↓"]) assert.ok(!(await t.content()).includes(ch), "arrow " + ch);
await t.screenshot({ path: `${SHOTS}/teacher-progress.png`, fullPage: true });
await browser.close();
if (errors.length) { console.log("Page errors:\n" + errors.join("\n")); process.exit(1); }
console.log("\nU1 PAIR PASSED");
