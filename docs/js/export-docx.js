// Export of a unit to Word (.docx): Student's Book (no keys) or Teacher's Book (keys, model answers, teaching notes).
// Loaded only when the teacher clicks a download button. Uses the docx library (MIT), kept locally in js/vendor.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle,
  ShadingType, ExternalHyperlink, AlignmentType, PageBreak,
} from "./vendor/docx.mjs";

const GAP = "__________";
const COLORS = { navy: "16233F", gold: "C08A2E", plum: "7B3F6B", teal: "1F7A72", mut: "6C7487", rule: "EEF4FB", disc: "E9F6F4", tnote: "F6EDF4", key: "FDF6E7" };

// ---------------------------------------------------------------- HTML to docx
const BLOCK = new Set(["P", "DIV", "DETAILS", "UL", "OL", "LI", "TABLE", "H1", "H2", "H3", "H4", "H5", "SECTION", "BLOCKQUOTE"]);

function inlineRuns(node, st = {}) {
  const out = [];
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      const t = n.textContent.replace(/\s+/g, " ");
      if (t) out.push(new TextRun({ text: t, bold: st.b, italics: st.i, strike: st.s, color: st.color, size: st.size }));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName, cls = n.classList;
    if (cls.contains("post-av") || cls.contains("d-ic") || cls.contains("tn-ic")) continue;
    if (tag === "BR") { out.push(new TextRun({ text: "", break: 1 })); continue; }
    if (BLOCK.has(tag)) { out.push(...inlineRuns(n, st)); continue; }
    const s2 = { ...st };
    if (tag === "B" || tag === "STRONG") s2.b = true;
    if (tag === "I" || tag === "EM") s2.i = true;
    if (tag === "S" || tag === "DEL") s2.s = true;
    if (cls.contains("cue")) { s2.i = true; s2.color = COLORS.plum; out.push(new TextRun({ text: " " })); }
    if (cls.contains("stem")) { s2.b = true; out.push(new TextRun({ text: " " })); }
    if (cls.contains("pnum") || cls.contains("gnum") || cls.contains("gn")) { s2.b = true; s2.color = COLORS.gold; }
    if (cls.contains("rt-meta")) { s2.i = true; s2.color = COLORS.mut; }
    if (tag === "A" && n.getAttribute("href")) {
      out.push(new ExternalHyperlink({ link: n.getAttribute("href"), children: [new TextRun({ text: n.textContent, style: "Hyperlink" })] }));
      continue;
    }
    out.push(...inlineRuns(n, s2));
    if (cls.contains("pnum") || cls.contains("gn")) out.push(new TextRun({ text: " " }));
  }
  return out;
}

function para(runs, o = {}) {
  return new Paragraph({ children: runs, spacing: { after: o.after ?? 120 }, ...o });
}

// converts an HTML fragment into a list of docx blocks
function htmlBlocks(html, o = {}) {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  return walk(doc.getElementById("r"), o);
}

function walk(el, o = {}, depth = 0) {
  const out = [];
  let pending = [];
  const flush = () => {
    const runs = [];
    for (const n of pending) runs.push(...inlineRuns({ childNodes: [n] }, o.st || {}));
    if (runs.length && pending.some((n) => n.textContent.trim() || n.tagName === "BR")) out.push(para(runs, o.p || {}));
    pending = [];
  };
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && BLOCK.has(n.tagName)) {
      flush();
      out.push(...blockOf(n, o, depth));
    } else pending.push(n);
  }
  flush();
  return out;
}

function boxed(children, fill, title, titleColor) {
  const head = title ? [para([new TextRun({ text: title, bold: true, color: titleColor, size: 18, allCaps: true })], { after: 60 })] : [];
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders(),
    rows: [new TableRow({ children: [new TableCell({
      shading: { type: ShadingType.CLEAR, color: "auto", fill },
      margins: { top: 120, bottom: 80, left: 160, right: 160 },
      children: [...head, ...(children.length ? children : [para([])])],
    })] })],
  }), para([], { after: 120 })];
}
function noBorders() {
  const n = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return { top: n, bottom: n, left: n, right: n, insideHorizontal: n, insideVertical: n };
}
function lineBorders() {
  const l = { style: BorderStyle.SINGLE, size: 4, color: "BFC7D5" };
  return { top: l, bottom: l, left: l, right: l, insideHorizontal: l, insideVertical: l };
}

function blockOf(n, o, depth) {
  const tag = n.tagName, cls = n.classList;
  if (/^H[1-5]$/.test(tag)) return [para(inlineRuns(n, { b: true, color: COLORS.navy, size: tag === "H3" ? 26 : 24 }), { after: 100, keepNext: true })];
  if (tag === "P") {
    if (cls.contains("eg")) return [para(inlineRuns(n, { i: true }), { indent: { left: 360 } })];
    if (cls.contains("lead")) return [para(inlineRuns(n, { i: true, color: COLORS.mut }))];
    return [para(inlineRuns(n, o.st || {}), o.p || {})];
  }
  if (tag === "UL" || tag === "OL") {
    const out = [];
    let i = 0;
    for (const li of n.children) {
      if (li.tagName !== "LI") continue;
      i += 1;
      const mark = tag === "OL" ? `${i}. ` : "• ";
      out.push(para([new TextRun({ text: mark, bold: tag === "OL" }), ...inlineRuns(li, o.st || {})], { indent: { left: 360 + depth * 360, hanging: 280 }, after: 60 }));
    }
    return out;
  }
  if (tag === "TABLE") return [tableOf(n), para([], { after: 80 })];
  if (tag === "DIV" || tag === "DETAILS") {
    if (cls.contains("rule")) {
      const tagEl = n.querySelector(".rule-tag");
      const h = n.querySelector(".rule-h")?.cloneNode(true);
      h?.querySelectorAll(".rule-tag,.rule-toggle").forEach((x) => x.remove());
      const title = h ? h.textContent.trim() : "";
      const body = n.querySelector(".rule-b");
      return boxed(body ? walk(body, {}, depth + 1) : [], COLORS.rule, `${tagEl?.textContent || "Rule"} · ${title}`, COLORS.navy);
    }
    if (cls.contains("discuss")) {
      const h = n.querySelector(".d-h");
      const title = h ? h.textContent.replace(/^\?/, "").trim() : "Talk about it";
      const rest = [...n.children].filter((c) => !c.classList.contains("d-h"));
      const kids = [];
      for (const c of rest) kids.push(...blockOf(c, {}, depth + 1));
      return boxed(kids, COLORS.disc, title, COLORS.teal);
    }
    if (cls.contains("rubric")) return boxed(walk(n, {}, depth + 1), "FBF6EA", "", COLORS.gold);
    if (cls.contains("rtext")) return boxed(walk(n, { p: { spacing: { after: 140, line: 300 } } }, depth + 1), "FDFDFB", "", COLORS.navy);
    if (cls.contains("gapped")) return boxed(walk(n, {}, depth + 1), "FBFCFE", "", COLORS.navy);
    if (cls.contains("post")) return boxed(walk(n, {}, depth + 1), "FFFFFF", "", COLORS.navy);
    if (cls.contains("sub-h")) {
      const h = n.querySelector("h3"), s = n.querySelector(".sub-h-s");
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: h?.textContent || "" })], spacing: { before: 280, after: 40 }, keepNext: true }),
        ...(s ? [para([new TextRun({ text: s.textContent, color: COLORS.mut })], { keepNext: true })] : [])];
    }
    return walk(n, o, depth);
  }
  if (tag === "LI") return [para(inlineRuns(n), { indent: { left: 360 } })];
  return walk(n, o, depth);
}

function tableOf(t) {
  const rows = [...t.querySelectorAll("tr")].map((tr) => new TableRow({
    children: [...tr.children].map((td) => new TableCell({
      shading: td.tagName === "TH" ? { type: ShadingType.CLEAR, color: "auto", fill: "EEF4FB" } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [para(inlineRuns(td, td.tagName === "TH" ? { b: true } : {}), { after: 40 })],
    })),
  }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: lineBorders(), rows });
}

// ---------------------------------------------------------------- exercises
const keyStr = (k) => (Array.isArray(k) ? k.join(" / ") : String(k ?? ""));
const longChoices = (it) => (it.choices || []).some((c) => c.length > 28);

function textWithGap(html) {
  return String(html || "").includes("___") ? html.replace(/_{3,}/g, GAP) : `${html || ""} ${GAP}`;
}

function exerciseBlocks(ex, num, keys, teacher) {
  const out = [];
  out.push(new Paragraph({
    keepNext: true, spacing: { before: 240, after: 80 },
    children: [new TextRun({ text: `${num}  `, bold: true, color: "FFFFFF", shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.navy } }),
      new TextRun({ text: " " + (ex.title || ""), bold: true, color: COLORS.navy, size: 24 })],
  }));
  if (ex.rubric) out.push(...htmlBlocks(ex.rubric, { st: { i: false } }));
  const items = ex.items || [];
  const k = keys || {};

  if (ex.kind === "match" && ex.showOptionList !== false) {
    out.push(...(ex.options || []).map((op) => para([new TextRun({ text: `${op.id}  `, bold: true, color: COLORS.gold }), ...inlineRuns(parse(op.text))], { indent: { left: 360 }, after: 40 })));
    out.push(para([], { after: 60 }));
  }

  if (ex.inline) {
    const map = {};
    for (const it of items) map[it.id] = it;
    const html = ex.inline.replace(/\{\{([\w-]+)\}\}/g, (m, id) => (ex.inlineNums === false ? GAP : `<b class="gn">${id}</b> ${GAP}`));
    out.push(...htmlBlocks(html));
    const withChoices = items.filter((it) => it.choices);
    if (withChoices.length) {
      out.push(para([new TextRun({ text: "Choose:", bold: true })], { after: 40 }));
      for (const it of withChoices) out.push(para([new TextRun({ text: `${it.id}  `, bold: true, color: COLORS.gold }), new TextRun({ text: it.choices.join("  /  ") })], { indent: { left: 360 }, after: 40 }));
    }
  } else {
    items.forEach((it, i) => {
      const n = `${i + 1}. `;
      if (ex.kind === "gap") {
        const long = longChoices(it);
        const runs = [new TextRun({ text: n, bold: true }), ...inlineRuns(parse(textWithGap(it.text)))];
        if (it.choices && !long) runs.push(new TextRun({ text: `   (${it.choices.join(" / ")})`, color: COLORS.mut }));
        out.push(para(runs, { indent: { left: 360, hanging: 300 }, after: 60 }));
        if (it.choices && long) it.choices.forEach((c, j) => out.push(para([new TextRun({ text: `${"abcdefgh"[j]})  ${c}` })], { indent: { left: 720 }, after: 30 })));
        if (ex.wide) out.push(para([new TextRun({ text: GAP + GAP + GAP + GAP })], { indent: { left: 360 } }));
      } else if (ex.kind === "match") {
        out.push(para([new TextRun({ text: n, bold: true }), ...inlineRuns(parse(it.text)), new TextRun({ text: "   " + "_____" })], { indent: { left: 360, hanging: 300 }, after: 60 }));
      } else if (ex.kind === "mcq") {
        out.push(para([new TextRun({ text: n, bold: true }), ...inlineRuns(parse(it.text))], { indent: { left: 360, hanging: 300 }, after: 40, keepNext: true }));
        (it.options || []).forEach((t, j) => out.push(para([new TextRun({ text: `${"ABCDEFGH"[j]}   `, bold: true, color: COLORS.gold }), ...inlineRuns(parse(t))], { indent: { left: 720 }, after: 30 })));
      } else if (ex.kind === "open") {
        out.push(para([new TextRun({ text: n, bold: true }), ...inlineRuns(parse(it.text))], { indent: { left: 360, hanging: 300 }, after: 40 }));
        const rows = Math.min(Math.max(it.rows || ex.rows || 3, 2), 10);
        for (let r = 0; r < rows; r++) out.push(para([new TextRun({ text: "_".repeat(78), color: "B0B7C3" })], { indent: { left: 360 }, after: 60 }));
        const mw = it.minWords || ex.minWords;
        if (mw) out.push(para([new TextRun({ text: `At least ${mw} words.`, italics: true, color: COLORS.mut })], { indent: { left: 360 } }));
      }
    });
  }

  if (teacher) {
    const keyed = items.filter((it) => k[it.id] !== undefined && k[it.id] !== "");
    if (keyed.length) {
      const kids = [];
      if (ex.kind === "open") {
        keyed.forEach((it) => kids.push(para([new TextRun({ text: `${ex.inline ? it.id : items.indexOf(it) + 1}. `, bold: true }), new TextRun({ text: keyStr(k[it.id]) })], { after: 60 })));
        out.push(...boxed(kids, COLORS.key, "Model answers", COLORS.gold));
      } else {
        const parts = keyed.map((it) => `${ex.inline ? it.id : items.indexOf(it) + 1} ${keyStr(k[it.id])}`);
        out.push(...boxed([para([new TextRun({ text: parts.join("  ·  ") })])], COLORS.key, "Key", COLORS.gold));
      }
    }
  }
  return out;
}
const parse = (html) => new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html").body.firstChild;

function flashcardBlocks(b, num) {
  const out = [];
  out.push(new Paragraph({ keepNext: true, spacing: { before: 240, after: 80 }, children: [
    ...(num ? [new TextRun({ text: `${num}  `, bold: true, color: "FFFFFF", shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.navy } }), new TextRun({ text: " " })] : []),
    new TextRun({ text: b.title || "Flashcards", bold: true, color: COLORS.navy, size: 24 })] }));
  if (b.rubric) out.push(...htmlBlocks(b.rubric));
  const cards = b.cards || [];
  if (b.style === "discussion") {
    cards.forEach((c, i) => out.push(para([new TextRun({ text: `Card ${i + 1}.  `, bold: true, color: COLORS.teal }), new TextRun({ text: c.front })], { indent: { left: 360, hanging: 300 }, after: 60 })));
    return out;
  }
  const head = ["Word", "Transcription", "Translation", "Example"];
  const rows = [new TableRow({ tableHeader: true, children: head.map((h) => new TableCell({ shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEF4FB" }, children: [para([new TextRun({ text: h, bold: true })], { after: 20 })] })) })];
  for (const c of cards) rows.push(new TableRow({ children: [
    new TableCell({ children: [para([new TextRun({ text: c.front, bold: true })], { after: 20 })] }),
    new TableCell({ children: [para([new TextRun({ text: c.ipa || "" })], { after: 20 })] }),
    new TableCell({ children: [para([new TextRun({ text: c.back || "" })], { after: 20 })] }),
    new TableCell({ children: [para([new TextRun({ text: c.example || "", italics: true })], { after: 20 })] }),
  ] }));
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: lineBorders(), rows }), para([], { after: 120 }));
  return out;
}

function mediaBlocks(b) {
  const file = (s) => String(s || "").split("/").pop();
  if (b.type === "audio") return [para([new TextRun({ text: "Audio · ", bold: true, color: COLORS.teal }), new TextRun({ text: `${b.title || ""}` }),
    new TextRun({ text: `  (${file(b.src)})`, color: COLORS.mut })])];
  if (b.type === "speaking") {
    const s = Number(b.sec || 0);
    return [para([new TextRun({ text: "Speaking · ", bold: true, color: COLORS.teal }), new TextRun({ text: b.label || "Your turn" }),
      ...(s ? [new TextRun({ text: `  (${Math.floor(s / 60) ? Math.floor(s / 60) + " min " : ""}${s % 60 ? (s % 60) + " sec" : ""})`.replace(" )", ")"), color: COLORS.mut })] : [])])];
  }
  if (b.type === "video") return [para([new TextRun({ text: "Video · ", bold: true, color: COLORS.teal }), new TextRun({ text: (b.title || "") + "  " }),
    ...(b.url ? [new ExternalHyperlink({ link: b.url, children: [new TextRun({ text: b.url, style: "Hyperlink" })] })] : [])])];
  const pics = b.type === "images" ? b.items || [] : [b];
  return pics.map((p) => para([new TextRun({ text: `[${p.label || "Picture"}: ${file(p.src)}]`, italics: true, color: COLORS.mut })]));
}

// ---------------------------------------------------------------- whole unit
export async function exportUnitDocx({ courseTitle, unitNum, unitTitle, sections, keys = {}, notes = {}, teacher = false }) {
  const body = [];
  body.push(para([new TextRun({ text: courseTitle, bold: true, color: COLORS.gold, size: 22, allCaps: true })], { after: 60 }));
  body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `Unit ${unitNum} · ${unitTitle}` })], spacing: { after: 80 } }));
  body.push(para([new TextRun({ text: teacher ? "Teacher's Book · with keys, model answers and teaching notes" : "Student's Book", italics: true, color: teacher ? COLORS.plum : COLORS.mut, size: 24 })], { after: 240 }));

  sections.forEach((sec, si) => {
    if (si > 0) body.push(new Paragraph({ children: [new PageBreak()] }));
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${unitNum}.${si + 1}  ${sec.title}` })], spacing: { after: 60 } }));
    if (sec.subtitle) body.push(para([new TextRun({ text: sec.subtitle, italics: true, color: COLORS.mut })], { after: 200 }));
    const blocks = [...(sec.blocks || [])];
    if (teacher) for (const nt of [...(notes[sec.id] || [])].reverse()) blocks.splice(nt.at, 0, { type: "teacher-note", html: nt.html });
    let n = 0;
    for (const b of blocks) {
      if (b.type === "html") body.push(...htmlBlocks(b.html));
      else if (b.type === "teacher-note") { if (teacher) body.push(...boxed(htmlBlocks(b.html), COLORS.tnote, "Teaching notes", COLORS.plum)); }
      else if (b.type === "flashcards") { if (b.numbered) n += 1; body.push(...flashcardBlocks(b, b.numbered ? `${unitNum}.${si + 1}.${n}` : "")); }
      else if (b.type === "exercise") { n += 1; body.push(...exerciseBlocks(b, `${unitNum}.${si + 1}.${n}`, keys[b.id], teacher)); }
      else if (["audio", "video", "image", "images", "speaking"].includes(b.type)) body.push(...mediaBlocks(b));
    }
  });

  const doc = new Document({
    creator: courseTitle, title: `${courseTitle} – Unit ${unitNum}`,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { size: 40, bold: true, color: COLORS.navy, font: "Georgia" } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { size: 32, bold: true, color: COLORS.navy, font: "Georgia" } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", run: { size: 26, bold: true, color: COLORS.navy, font: "Georgia" } },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children: body }],
  });
  return Packer.toBlob(doc);
}

export function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
