import { DIRECTION_DELTA, type MapModel, type MapRoom } from "../core/map-model.js";

const CELL = 90;
const BOX_W = 70;
const BOX_H = 36;
const PAD = 30;
const STUB = CELL * 0.42;

export interface LaidBox { x: number; y: number; w: number; h: number; label: string; current: boolean; remains: boolean; }
export interface LaidLink { x1: number; y1: number; x2: number; y2: number; locked: boolean; }
export interface LaidStub { x1: number; y1: number; x2: number; y2: number; qx: number; qy: number; locked: boolean; }
export interface MapLayout { width: number; height: number; boxes: LaidBox[]; links: LaidLink[]; stubs: LaidStub[]; }

/** Pure layout: grid coords → pixel shapes, normalized to a PAD-margined origin. */
export function layoutMap(model: MapModel): MapLayout {
  const rooms = model.rooms();
  if (rooms.length === 0) return { width: BOX_W + 2 * PAD, height: BOX_H + 2 * PAD, boxes: [], links: [], stubs: [] };

  const minX = Math.min(...rooms.map((r) => r.x));
  const minY = Math.min(...rooms.map((r) => r.y));
  const maxX = Math.max(...rooms.map((r) => r.x));
  const maxY = Math.max(...rooms.map((r) => r.y));

  const left = (r: MapRoom) => (r.x - minX) * CELL + PAD;
  const top = (r: MapRoom) => (r.y - minY) * CELL + PAD;
  const cx = (r: MapRoom) => left(r) + BOX_W / 2;
  const cy = (r: MapRoom) => top(r) + BOX_H / 2;

  const current = model.currentId;
  const boxes: LaidBox[] = rooms.map((r) => ({
    x: left(r), y: top(r), w: BOX_W, h: BOX_H,
    label: r.name, current: r.id === current, remains: r.hasRemains,
  }));

  const byId = new Map(rooms.map((r) => [r.id, r]));
  const links: LaidLink[] = [];
  for (const e of model.edges()) {
    const a = byId.get(e.a); const b = byId.get(e.b);
    if (!a || !b) continue;
    links.push({ x1: cx(a), y1: cy(a), x2: cx(b), y2: cy(b), locked: e.locked });
  }

  const stubs: LaidStub[] = [];
  for (const r of rooms) {
    for (const s of model.stubsFor(r.id)) {
      const { dx, dy } = DIRECTION_DELTA[s.dir];
      const x1 = cx(r); const y1 = cy(r);
      const x2 = x1 + dx * STUB; const y2 = y1 + dy * STUB;
      stubs.push({ x1, y1, x2, y2, qx: x2 + dx * 8, qy: y2 + dy * 8, locked: s.locked });
    }
  }

  const width = (maxX - minX) * CELL + BOX_W + 2 * PAD;
  const height = (maxY - minY) * CELL + BOX_H + 2 * PAD;
  return { width, height, boxes, links, stubs };
}

const SVGNS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** Thin browser emitter: turn a layout into an <svg>. Styled via .map-* CSS classes. */
export function renderMapSvg(layout: MapLayout): SVGSVGElement {
  const svg = el("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, class: "map-svg", width: layout.width, height: layout.height });

  for (const s of layout.stubs) {
    svg.appendChild(el("line", { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, class: s.locked ? "map-stub locked" : "map-stub" }));
    const q = el("text", { x: s.qx, y: s.qy, class: "map-q", "text-anchor": "middle", "dominant-baseline": "middle" });
    q.textContent = "?";
    svg.appendChild(q);
  }
  for (const lk of layout.links) {
    svg.appendChild(el("line", { x1: lk.x1, y1: lk.y1, x2: lk.x2, y2: lk.y2, class: lk.locked ? "map-link locked" : "map-link" }));
  }
  for (const b of layout.boxes) {
    svg.appendChild(el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, class: b.current ? "map-box current" : "map-box" }));
    const label = el("text", { x: b.x + b.w / 2, y: b.y + b.h / 2, class: "map-label", "text-anchor": "middle", "dominant-baseline": "middle" });
    label.textContent = b.label;
    svg.appendChild(label);
    if (b.remains) {
      const r = el("text", { x: b.x + b.w - 8, y: b.y + 10, class: "map-remains", "text-anchor": "middle", "dominant-baseline": "middle" });
      r.textContent = "✕";
      svg.appendChild(r);
    }
  }
  return svg;
}
