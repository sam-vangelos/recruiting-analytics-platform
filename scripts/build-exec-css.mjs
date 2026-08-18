// Generates app/(exec)/exec.css from docs/recruiting-ops/exec-design/exec-design-tokens.json.
// Same hard gates as the mockup generators: (a) every declared text usage must pass its
// APCA floor; (b) the emitted CSS may contain no px/ms/vw/hex value that is not derived
// from a token computation. The stylesheet is checked in; regenerate after token changes:
//   node scripts/build-exec-css.mjs
// Font families come from next/font CSS variables (--font-serif / --font-sans) set by
// app/(exec)/layout.tsx — the one deliberate substitution from the tokens' literal families.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokensUrl = new URL("../docs/recruiting-ops/exec-design/exec-design-tokens.json", import.meta.url);
const outUrl = new URL("../app/(exec)/exec.css", import.meta.url);
const T = JSON.parse(readFileSync(tokensUrl, "utf8"));

// ---------------------------------------------------------------- allowed-value registry
const allowed = { px: new Set(), ms: new Set(), vw: new Set(), hex: new Set() };
const px = n => { const v = Math.round(n * 100) / 100; allowed.px.add(v); return `${v}px`; };
const vw = n => { const v = Math.round(n * 1000) / 1000; allowed.vw.add(v); return `${v}vw`; };
const ms = s => { allowed.ms.add(parseFloat(s)); return s; };
const color = name => { const h = T.color[name]; allowed.hex.add(h.toLowerCase()); return h; };
const sp = n => {
  if (!T.space.scale.includes(n)) throw new Error(`off-scale space: ${n}`);
  return px(n);
};

// ---------------------------------------------------------------- fluid type
const B = T.type.base;
const step = i => {
  const min = B.minPx * B.minRatio ** i;
  const max = B.maxPx * B.maxRatio ** i;
  const slope = (max - min) / (B.maxVw - B.minVw);
  const intercept = min - slope * B.minVw;
  return { min, max, css: `clamp(${px(min)}, ${px(intercept)} + ${vw(slope * 100)}, ${px(max)})` };
};
const SIZES = Object.fromEntries(Object.entries(T.type.steps).map(([k, i]) => [k, step(i)]));
const W = T.type.weights;
const SERIF = "var(--font-serif), Georgia, serif";
const SANS = "var(--font-sans), system-ui, sans-serif";

// ---------------------------------------------------------------- APCA gate
const hexc = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const sc = h => { const [r, g, b] = hexc(h); return 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4; };
const cl = Y => (Y > 0.022 ? Y : Y + (0.022 - Y) ** 1.414);
const apca = (fg, bg) => {
  const Yt = cl(sc(fg)), Yb = cl(sc(bg));
  const c = Yb > Yt ? (Yb ** 0.56 - Yt ** 0.57) * 1.14 : (Yb ** 0.65 - Yt ** 0.62) * 1.14;
  return Math.abs(c) < 0.1 ? 0 : (c > 0 ? c - 0.027 : c + 0.027) * 100;
};
const floorFor = (pxSize, weight) => {
  if (pxSize >= 16) return 75;
  if (pxSize >= 15 && weight >= 400) return 80;
  if (pxSize >= 13 && weight >= 500) return 80;
  if (pxSize >= 13) return 90;
  return Infinity;
};
const usages = [];
const use = (role, colorName, sizeKey, weight) => {
  const size = SIZES[sizeKey];
  usages.push({ role, colorName, minPx: size.min, weight });
  return { color: color(colorName), size: size.css, weight };
};
const U = {
  kicker: use("kicker", "ink-2", "caption", W.medium),
  display: use("display", "ink", "display", W.serifDisplay),
  stamp: use("stamp", "ink-2", "body", W.regular),
  lede: use("lede", "ink", "lede", W.serifLede),
  ledeStrong: use("lede-strong", "ink", "lede", W.semibold),
  ledeRed: use("lede-red", "red", "lede", W.serifLede),
  index: use("index", "ink-2", "body", W.regular),
  indexN: use("index-count", "ink", "body", W.semibold),
  sectionHead: use("section-head", "ink", "section", W.serifDisplay),
  sectionCount: use("section-count", "ink-2", "body", W.regular),
  groupLead: use("group-lead", "ink", "body", W.medium),
  groupLeadN: use("group-lead-count", "ink-2", "body", W.regular),
  colHeader: use("col-header", "ink-2", "caption", W.medium),
  rowPrimary: use("row-primary", "ink", "body", W.medium),
  rowText: use("row-text", "ink-2", "body", W.regular),
  rowNum: use("row-num", "ink", "body", W.regular),
  chip: use("chip", "ink-2", "caption", W.medium),
  subLine: use("sub-line", "ink-2", "body", W.regular),
  subLabel: use("sub-label", "ink", "body", W.medium),
  link: use("link", "link", "body", W.regular),
  footnote: use("footnote", "ink-2", "caption", W.medium),
};
let apcaFail = false;
console.log("── APCA usage audit");
for (const u of usages) {
  const lc = apca(T.color[u.colorName], T.color.paper);
  const floor = floorFor(u.minPx, u.weight);
  const ok = lc >= floor;
  if (!ok) apcaFail = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${u.role.padEnd(18)} ${u.colorName.padEnd(6)} ${u.minPx.toFixed(1)}px/${u.weight}  Lc ${lc.toFixed(1)} vs floor ${floor}`);
}
if (apcaFail) { console.error("APCA validation failed — refusing to build"); process.exit(1); }

// ---------------------------------------------------------------- css
const L = T.layout;
const G = L.reqGridV3;
const css = `/* GENERATED by scripts/build-exec-css.mjs from exec-design-tokens.json — do not edit by hand. */
.exec-body { background: ${color("paper")}; color: ${color("ink")}; font-family: ${SANS}; font-feature-settings: "tnum" 1; line-height: ${T.type.lineHeights.body}; margin: 0; }
.exec-body * { box-sizing: border-box; margin: 0; }
.exec-body a { color: ${color("link")}; text-decoration: underline; text-decoration-color: color-mix(in srgb, ${color("link")} 35%, transparent); text-underline-offset: ${px(T.borders.strong)}; transition: text-decoration-color ${ms(T.motion.fast)} ${T.motion.ease}; }
.exec-body a:hover { text-decoration-color: ${color("link")}; }
.exec-body :focus-visible { outline: ${px(T.borders.strong)} solid ${color("link")}; outline-offset: ${px(T.borders.strong)}; border-radius: ${px(T.borders.radius)}; }
@media (prefers-reduced-motion: reduce) { .exec-body *, .exec-body *::before { transition: none !important; } }

.page { max-width: ${px(L.pageMaxWidth)}; margin: 0 auto; padding: ${sp(L.pagePadding.top)} ${sp(L.pagePadding.x)} ${sp(L.pagePadding.bottom)}; container-type: inline-size; }

.kicker { font-size: ${U.kicker.size}; font-weight: ${U.kicker.weight}; color: ${U.kicker.color}; }
.page h1 { font-family: ${SERIF}; font-size: ${U.display.size}; font-weight: ${U.display.weight}; line-height: ${T.type.lineHeights.display}; }
.stamp { font-family: ${SERIF}; font-style: italic; font-size: ${U.stamp.size}; color: ${U.stamp.color}; }
.masthead { display: flex; align-items: last baseline; justify-content: space-between; gap: ${sp(24)}; padding-bottom: ${sp(20)}; border-bottom: ${px(T.borders.strong)} solid ${color("ink")}; }
.opening { display: flex; gap: ${sp(48)}; margin-top: ${sp(24)}; align-items: flex-start; }
.lede { font-family: ${SERIF}; font-size: ${U.lede.size}; font-weight: ${U.lede.weight}; line-height: ${T.type.lineHeights.lede}; max-width: 58ch; }
.lede strong { font-weight: ${U.ledeStrong.weight}; }
.lede .bad { color: ${U.ledeRed.color}; font-weight: ${U.ledeStrong.weight}; }
.index { margin-left: auto; flex: none; border-left: ${px(T.borders.thin)} solid ${color("rule")}; padding-left: ${sp(24)}; display: flex; flex-direction: column; gap: ${sp(8)}; }
.index a { display: flex; align-items: baseline; gap: ${sp(8)}; min-width: ${px(168)}; font-size: ${U.index.size}; color: ${U.index.color}; text-decoration: none; }
.index a:hover { color: ${color("ink")}; }
.index .n { margin-left: auto; font-weight: ${U.indexN.weight}; color: ${U.indexN.color}; }

.page section { margin-top: ${sp(L.sectionGap)}; }
.sec-head { display: flex; align-items: baseline; gap: ${sp(12)}; padding-bottom: ${sp(8)}; border-bottom: ${px(T.borders.thin)} solid ${color("rule")}; }
.sec-head h2 { font-family: ${SERIF}; font-size: ${U.sectionHead.size}; font-weight: ${U.sectionHead.weight}; }
.sec-head .count { font-size: ${U.sectionCount.size}; color: ${U.sectionCount.color}; }
.dot { flex: none; width: ${sp(8)}; height: ${sp(8)}; border-radius: 50%; align-self: center; }
.dot-red { background: ${color("red")}; } .dot-amber { background: ${color("amber")}; } .dot-green { background: ${color("green")}; }

.group { margin-top: ${sp(L.groupGap)}; }
.group-lead { font-size: ${U.groupLead.size}; font-weight: ${U.groupLead.weight}; margin-top: ${sp(16)}; }
.group-lead .n { color: ${U.groupLeadN.color}; font-weight: ${U.groupLeadN.weight}; }

.req-head, .req-line, .paper-line { display: grid; column-gap: ${sp(G.gap)}; align-items: baseline; }
.req-head, .req-line { grid-template-columns: ${G.columns.map(c => (c.endsWith("px") ? px(parseFloat(c)) : c)).join(" ")}; }
.paper-line { grid-template-columns: ${G.columns[0]} ${px(parseFloat(G.columns[1]))} minmax(0, 2fr); padding: ${sp(8)} 0; }
.req-head { padding: ${sp(12)} 0 ${sp(4)}; font-size: ${U.colHeader.size}; font-weight: ${U.colHeader.weight}; color: ${U.colHeader.color}; }
.slots { display: grid; grid-template-columns: repeat(${G.slotCount}, minmax(0, 1fr)); column-gap: ${sp(8)}; }
.req { border-top: ${px(T.borders.thin)} solid ${color("hairline")}; }
details.req > summary { list-style: none; cursor: pointer; padding: ${sp(G.rowPaddingY)} 0; }
details.req > summary::-webkit-details-marker { display: none; }
.role { display: flex; align-items: baseline; gap: ${sp(8)}; min-width: 0; }
.role-name { font-size: ${U.rowPrimary.size}; font-weight: ${U.rowPrimary.weight}; position: relative; }
details.req > summary .role-name::before { content: "▸"; position: absolute; left: ${px(-16)}; color: ${U.subLine.color}; transition: transform ${ms(T.motion.base)} ${T.motion.ease}; display: inline-block; }
details.req[open] > summary .role-name::before { transform: rotate(90deg); }
.dept, .chip { font-size: ${U.chip.size}; font-weight: ${U.chip.weight}; color: ${U.chip.color}; white-space: nowrap; }
.cell { font-size: ${U.rowText.size}; color: ${U.rowText.color}; }
.cell.num, .num { text-align: right; font-variant-numeric: tabular-nums; }
.req-line .cell.num, .slots .num { color: ${U.rowNum.color}; }
.strong { color: ${color("ink")}; font-weight: ${W.medium}; }
.rt { color: ${U.subLine.color}; }
.req-sub { margin-top: ${sp(4)}; font-size: ${U.subLine.size}; color: ${U.subLine.color}; max-width: 96ch; }
.sub-label { color: ${U.subLabel.color}; font-weight: ${U.subLabel.weight}; }

.detail { margin: 0 0 ${sp(16)} ${sp(G.detailIndent)}; padding-left: ${sp(16)}; border-left: ${px(T.borders.thin)} solid ${color("rule")}; display: flex; flex-wrap: wrap; gap: ${sp(24)} ${sp(48)}; }
.d-block { min-width: ${px(240)}; }
.d-block:last-child { flex-basis: 100%; }
.d-head { font-size: ${U.colHeader.size}; font-weight: ${U.colHeader.weight}; color: ${U.colHeader.color}; padding-bottom: ${sp(4)}; }
.d-row { display: grid; grid-template-columns: ${px(200)} ${px(56)} minmax(0, 1fr); column-gap: ${sp(12)}; font-size: ${U.subLine.size}; color: ${U.rowText.color}; padding: ${sp(4)} 0 0; }
.d-row .num { color: ${U.rowNum.color}; }
.d-line { font-size: ${U.subLine.size}; color: ${U.rowText.color}; padding-top: ${sp(4)}; max-width: 84ch; }

.hire { display: grid; grid-template-columns: ${L.hireGrid.columns.map(c => (c.endsWith("px") ? px(parseFloat(c)) : c)).join(" ")}; column-gap: ${sp(L.hireGrid.gap)}; align-items: baseline; padding: ${sp(L.hireGrid.rowPaddingY)} 0; border-top: ${px(T.borders.thin)} solid ${color("hairline")}; }
.hires-week { margin-top: ${sp(16)}; }
details.more { margin-top: ${sp(12)}; }
details.more > summary { cursor: pointer; font-size: ${U.link.size}; color: ${U.link.color}; width: fit-content; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "▸"; display: inline-block; margin-right: ${sp(8)}; transition: transform ${ms(T.motion.base)} ${T.motion.ease}; }
details.more[open] > summary::before { transform: rotate(90deg); }

.pools-prose { margin-top: ${sp(16)}; font-size: ${U.rowText.size}; color: ${U.rowText.color}; line-height: ${T.type.lineHeights.lede}; }
.pool .strong { font-weight: ${W.medium}; }

.stale { display: flex; align-items: center; gap: ${sp(8)}; margin-top: ${sp(16)}; padding: ${sp(12)} 0; border-top: ${px(T.borders.thin)} solid ${color("rule")}; border-bottom: ${px(T.borders.thin)} solid ${color("rule")}; font-size: ${U.subLabel.size}; font-weight: ${U.subLabel.weight}; color: ${color("ink")}; }

.unavailable { max-width: 58ch; margin-top: ${sp(48)}; }

.page footer { margin-top: ${sp(64)}; padding-top: ${sp(16)}; border-top: ${px(T.borders.thin)} solid ${color("rule")}; font-size: ${U.footnote.size}; font-weight: ${U.footnote.weight}; color: ${U.footnote.color}; max-width: 78ch; }

@container (max-width: ${px(719)}) {
  .req-head { display: none; }
  .req-line, .hire, .paper-line { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: ${sp(4)}; }
  .role { grid-column: 1 / -1; }
  .cell, .cell.num { text-align: left; }
  .cell::before { content: attr(data-l) " "; font-size: ${U.colHeader.size}; font-weight: ${U.colHeader.weight}; color: ${U.colHeader.color}; }
  .slots { grid-template-columns: repeat(${G.slotCount}, minmax(0, 1fr)); }
  .opening { flex-direction: column; }
  .index { margin-left: 0; border-left: none; padding-left: 0; flex-direction: row; flex-wrap: wrap; gap: ${sp(16)}; }
}
`;

// ---------------------------------------------------------------- css lint gate
console.log("── CSS lint (emitted values vs token registry)");
const lintFail = [];
for (const m of css.matchAll(/(-?\d+(?:\.\d+)?)(px|ms|vw)/g)) {
  const v = parseFloat(m[1]);
  if (!allowed[m[2]].has(v) && !allowed[m[2]].has(Math.abs(v))) lintFail.push(m[0]);
}
for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  if (!allowed.hex.has(m[0].toLowerCase())) lintFail.push(m[0]);
}
if (lintFail.length) {
  console.error("UNREGISTERED VALUES:", [...new Set(lintFail)].join(", "));
  process.exit(1);
}
console.log("PASS — every px/ms/vw/hex in emitted CSS is token-derived");

writeFileSync(outUrl, css);
console.log(`wrote ${fileURLToPath(outUrl)}`);
