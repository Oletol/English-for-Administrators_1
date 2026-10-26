// Unit 2 (Warm-up + Reading) with the real course.json: import, open the unit, a student answers every auto task
// (all correct except item 1), the teacher checks each exercise; writing check of the open tasks; no keys, no arrows.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:5055";
const SHOTS = process.env.SHOTS || "/tmp/shots-u2";
mkdirSync(SHOTS, { recursive: true });
const mock = readFileSync(new URL("./mock-fb.js", import.meta.url), "utf8");
const courseText = readFileSync(new URL("../content-private/course.json", import.meta.url), "utf8");
const u2 = JSON.parse(courseText).units.find((u) => u.id === "u2");
// the fake microphone plays a recording of an answer (a synthetic voice reading a text with typical mistakes)
const WAV = process.env.WAV || new URL("./_card.wav", import.meta.url).pathname;
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
await ctx.route("**/js/fb.js*", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
let lt = 0;
await ctx.route("https://api.languagetool.org/**", async (r) => {
  lt++;
  const text = new URLSearchParams(r.request().postData()).get("text") || "";
  const i = text.indexOf("I will went");
  const matches = i < 0 ? [] : [{ offset: i, length: 11, message: "Use the base form after 'will'.", shortMessage: "Wrong verb form",
    replacements: [{ value: "I will go" }], rule: { issueType: "grammar", category: { name: "Grammar" } } }];
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
await t.click('[data-act="toggle-open"][data-unit="u2"]');
await t.waitForSelector("td .pill.on:text('open')");

const s = await page("/index.html");
await s.evaluate(() => sessionStorage.clear()); await s.reload();
await s.click("[data-mode=register]");
await s.fill("[name=name]", "Anna Ivanova"); await s.fill("[name=email]", "anna@uni.ru"); await s.fill("[name=password]", "pass123"); await s.fill("[name=group]", "PA-21");
await s.click("#auth-submit"); await s.waitForSelector(".cards .pg");

const first = (a) => (Array.isArray(a) ? a[0] : a);
for (const sec of u2.sections) {
  step("Student: " + sec.id);
  await s.evaluate((h) => { location.hash = h; }, "#u2/" + sec.id);
  await s.waitForSelector("#content .ex");
  const html = await s.content();
  for (const ch of ["→", "←", "›", "«", "»", "▶", "⤴"]) assert.ok(!html.includes(ch), "arrow " + ch + " in " + sec.id);
  assert.ok(!html.includes("Model answer"), "no model answers for students");
  assert.ok(!/teacher-note|Where to find the answers|Key:/.test(await s.textContent("#content")), "no teacher notes for students");
  for (const ex of sec.blocks.filter((b) => b.type === "exercise")) {
    for (const it of ex.items) {
      const loc = s.locator(`[data-ex="${ex.id}"][data-item="${it.id}"]`);
      if (ex.transcript) continue;
      if (ex.kind === "open") { await loc.fill(ex.id === "w7" && it.id === "1" ? "The last deadline I almost missed was my essay, and I will went to the library to finish it on time." : "On Monday at five, in the library, I will write the plan of my essay and take a break."); continue; }
      if (ex.graded === false) { if (it.choices) await loc.selectOption({ index: 1 }); else await loc.fill("10"); continue; }
      const want = first(it.answer);
      const wrong = it.id === "1";
      if (ex.kind === "mcq") { const L = wrong ? "ABCD".split("").find((x) => x !== want) : want; await s.locator(`[data-ex="${ex.id}"][data-item="${it.id}"][value="${L}"]`).check(); }
      else if (ex.kind === "match" && ex.display === "letters") await loc.fill(wrong ? (want === "a" ? "b" : "a") : want);
      else if (ex.kind === "match" || it.choices) {
        const vals = await loc.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
        assert.ok(vals.includes(want), `${ex.id}.${it.id}: key "${want}" is among the options`);
        await loc.selectOption(wrong ? vals.find((v) => v !== want) : want);
      } else await loc.fill(wrong ? "xxx" : want);
    }
  }
  await s.waitForTimeout(1500);
  await s.screenshot({ path: `${SHOTS}/student-${sec.id}.png`, fullPage: true });
}

step("Speaking 2.1.10: record 25 seconds, transcribe in the browser, the text and the measurements are saved");
await s.evaluate(() => { location.hash = "#u2/warmup"; });
await s.waitForSelector("#ex-w9 textarea.transcript[readonly]");
const spk = s.locator('.spk[data-tr="w9"]');
await spk.locator("[data-spk-act=rec]").click();
await s.waitForSelector('.spk[data-tr="w9"] .btn.rec.on');
await s.waitForTimeout(25000);
await spk.locator("[data-spk-act=rec]").click();
await s.waitForSelector('.spk[data-tr="w9"] [data-spk-act=tr]', { timeout: 8000 });
const t0 = Date.now();
await spk.locator("[data-spk-act=tr]").first().click();
await s.waitForSelector('.spk[data-tr="w9"] .spk-tr:has-text("Downloading the speech program")', { timeout: 20000 }).catch(() => {});
await spk.locator(".spk-tr").screenshot({ path: `${SHOTS}/speaking-progress.png` }).catch(() => {});
await s.waitForFunction(() => (document.querySelector('#ex-w9 textarea')?.value || "").length > 20, null, { timeout: 300000 });
const said = await s.inputValue("#ex-w9 textarea");
console.log(`   transcribed in ${Math.round((Date.now() - t0) / 1000)} s:`, said);
assert.ok(/difficult task/i.test(said), "the transcript is the recorded speech");
assert.ok(/\d+ words per minute|words/.test(await s.textContent('[data-sp-line="w9"]')), "measurements are shown");
await s.locator('.spk[data-tr="w9"]').screenshot({ path: `${SHOTS}/speaking-done.png` });
await s.locator("#ex-w9").screenshot({ path: `${SHOTS}/speaking-transcript.png` });
await s.waitForTimeout(2500);
const db = await s.evaluate(() => JSON.parse(localStorage.getItem("mock:db")));
const subDoc = Object.entries(db).find(([k]) => k.startsWith("submissions/u2__"))[1];
assert.equal(subDoc.answers.w9["1"], said, "the transcript is saved in the draft");
const mt = JSON.parse(subDoc.answers._speech.w9);
assert.ok(mt.words > 20 && mt.total > 20, "the measurements are saved: " + JSON.stringify(mt));
console.log("   measurements:", JSON.stringify(mt));

for (const sec of u2.sections) {
  await t.evaluate((h) => { location.hash = h; }, "#u2/" + sec.id);
  await t.waitForSelector(`#ex-${sec.blocks.find((b) => b.type === "exercise").id}`);
  for (const ex of sec.blocks.filter((b) => b.type === "exercise")) {
    if (ex.kind === "open" && ex.check === "teacher") {
      await t.click(`[data-act="check-writing"][data-ex="${ex.id}"]`);
      await t.waitForSelector(`[data-act="check-writing"][data-ex="${ex.id}"]:has-text("Check again")`, { timeout: 30000 });
    } else if (ex.graded !== false && ex.kind !== "open") {
      await t.click(`[data-act="check-ex"][data-ex="${ex.id}"]`);
      await t.waitForSelector(`[data-act="uncheck-ex"][data-ex="${ex.id}"]`, { timeout: 8000 });
    }
  }
  await t.screenshot({ path: `${SHOTS}/teacher-${sec.id}.png`, fullPage: true });
}
step("Student sees results: 14 of 15 (item 1 wrong) in every checked exercise");
for (const sec of u2.sections) {
  await s.evaluate((h) => { location.hash = h; }, "#u2/" + sec.id);
  for (const ex of sec.blocks.filter((b) => b.type === "exercise" && b.kind !== "open" && b.graded !== false)) {
    await s.waitForSelector(`#ex-${ex.id} .ex-score`, { timeout: 8000 });
    const sc = (await s.textContent(`#ex-${ex.id} .ex-score`)).trim();
    assert.equal(sc, `${ex.items.length - 1} / ${ex.items.length}`, ex.id + ": " + sc);
    console.log("   ", ex.id, sc);
  }
}
await s.evaluate(() => { location.hash = "#u2/warmup"; });
await s.waitForSelector("#ex-w9 .wfb", { timeout: 15000 });
const sfb = await s.textContent("#ex-w9 .wfb");
assert.ok(/Feedback on your speaking/.test(sfb) && /How you spoke:/.test(sfb) && /Unit phrases used/.test(sfb), "speaking feedback: " + sfb.slice(0, 300));
assert.ok(!/Is it better to do the most difficult task first/.test(sfb), "discussion cards are not counted as unit phrases");
await s.locator("#ex-w9").screenshot({ path: `${SHOTS}/speaking-feedback.png` });
await s.waitForSelector("#ex-w7 .wfb", { timeout: 15000 });
const fb = await s.textContent("#ex-w7 .wfb");
assert.ok(/gone|base form|Wrong verb/i.test(fb), "LanguageTool feedback is shown: " + fb.slice(0, 200));
await s.locator("#ex-w7").screenshot({ path: `${SHOTS}/student-w7-feedback.png` });
await s.setViewportSize({ width: 390, height: 844 });
await s.evaluate(() => { location.hash = "#u2/reading"; });
await s.waitForTimeout(800);
await s.screenshot({ path: `${SHOTS}/mobile-reading.png` });
console.log("LanguageTool requests:", lt);
await browser.close();
if (errors.length) { console.log("Page errors:\n" + errors.join("\n")); process.exit(1); }
console.log("\nU2 PASSED");
