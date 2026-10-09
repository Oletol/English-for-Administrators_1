// Page shell shared by the student and teacher pages:
// collapsible sidebar (desktop: slides away; mobile: drawer) and the unit accordion.
import { esc } from "./common.js";

const LS_KEY = "sbCollapsed";

export function initShell() {
  try { if (localStorage.getItem(LS_KEY) === "1") document.body.classList.add("sb-collapsed"); } catch {}
  const mobile = () => window.matchMedia("(max-width:980px)").matches;
  const toggle = () => {
    if (mobile()) { document.body.classList.toggle("nav-open"); return; }
    const c = document.body.classList.toggle("sb-collapsed");
    try { localStorage.setItem(LS_KEY, c ? "1" : "0"); } catch {}
  };
  document.querySelectorAll("[data-sb-toggle]").forEach((b) => b.addEventListener("click", toggle));
  document.querySelector(".scrim")?.addEventListener("click", () => document.body.classList.remove("nav-open"));
  // on mobile, close the drawer after choosing a page
  document.querySelector(".sb-nav")?.addEventListener("click", (e) => {
    if (mobile() && e.target.closest("a.sb-item")) document.body.classList.remove("nav-open");
  });
}

// Units whose sections are expanded in the sidebar. The unit being studied is always open;
// others open only when the user clicks their header, and close again on navigation.
const manual = new Set();
let lastUnit = null;

/**
 * units:  [{id, title, order, status, sections:[{id,title,subtitle}]}]
 * state(u) -> { locked: bool, note: string, noteClass: string }
 * route:  { unit, section }
 */
export function renderUnitNav(el, { units, state, route, hrefPrefix = "", empty = "" }) {
  if (route.unit !== lastUnit) { manual.clear(); lastUnit = route.unit; }
  if (!units.length) { el.innerHTML = `<div class="sb-empty">${empty}</div>`; return; }
  el.innerHTML = units.map((u, i) => {
    const st = state(u);
    const num = u.order || i + 1;
    const current = route.unit === u.id;
    const canOpen = !st.locked && (u.sections || []).length && u.status !== "soon";
    const open = canOpen && (current || manual.has(u.id));
    const secs = canOpen ? (u.sections || []).map((s, j) => {
      const on = current && (route.section || u.sections[0]?.id) === s.id;
      return `<a class="sb-item ${on ? "on" : ""}" href="#${hrefPrefix}${esc(u.id)}/${esc(s.id)}">
        <span class="n">${num}.${j + 1}</span><span class="t">${esc(s.title)}${s.subtitle ? `<span class="s">${esc(s.subtitle)}</span>` : ""}</span></a>`;
    }).join("") : "";
    return `<div class="sb-unit ${open ? "open" : ""} ${st.locked ? "locked" : ""} ${current ? "current" : ""}">
      <button class="sb-uh" type="button" data-unit="${esc(u.id)}" data-can-open="${canOpen ? 1 : 0}">
        <span class="u-n">${num}</span>
        <span class="u-t">${esc(u.title)}${st.note ? `<span class="u-s ${st.noteClass || ""}">${st.note}</span>` : ""}</span>
        ${canOpen ? `<span class="chev">▼</span>` : ""}
      </button>
      ${secs ? `<div class="sb-secs">${secs}</div>` : ""}
    </div>`;
  }).join("");
}

// Click on a unit header: expand/collapse it; locked or empty units open their info page.
export function wireUnitNav(el, rerender, hrefPrefix = "") {
  el.addEventListener("click", (e) => {
    const h = e.target.closest(".sb-uh");
    if (!h) return;
    const id = h.dataset.unit;
    if (h.dataset.canOpen !== "1") { location.hash = `#${hrefPrefix}${id}`; return; }
    if (id === lastUnit) { location.hash = `#${hrefPrefix}${id}`; return; }   // current unit stays open
    manual.has(id) ? manual.delete(id) : manual.add(id);
    rerender();
  });
}
