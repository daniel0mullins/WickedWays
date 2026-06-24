// Makes the wide Mermaid ER diagrams on /guide/data-model readable: each rendered
// diagram becomes a fixed-height, scroll-to-zoom / drag-to-pan viewport with
// zoom controls (svg-pan-zoom).
//
// vitepress-plugin-mermaid renders `<div class="mermaid"><svg/></div>` on the
// client, and *re-renders* (replacing the div's innerHTML) on every dark-mode
// toggle. So this enhancer is self-healing: a MutationObserver re-attaches to any
// `svg` that lacks our marker, and detached instances are destroyed to avoid leaks.
import svgPanZoom, { type SvgPanZoomInstance } from "svg-pan-zoom";

const FRAME_CLASS = "mermaid-zoom-frame";
const instances = new Map<SVGSVGElement, SvgPanZoomInstance>();
let started = false;

export function setupMermaidZoom(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  const scan = (): void => {
    pruneDetached();
    document
      .querySelectorAll<SVGSVGElement>("div.mermaid > svg:not([data-zoom])")
      // rAF so the frame's CSS height is laid out before svg-pan-zoom measures it.
      .forEach((svg) => requestAnimationFrame(() => enhance(svg)));
  };

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      pruneDetached();
      // .resize() recomputes the viewport while preserving the user's zoom/pan.
      instances.forEach((inst) => {
        try {
          inst.resize();
        } catch {
          /* detached mid-resize; pruned on next pass */
        }
      });
    }, 150);
  });
}

function enhance(svg: SVGSVGElement): void {
  if (svg.dataset.zoom || !svg.isConnected) return;
  const frame = svg.closest<HTMLElement>("div.mermaid");
  if (!frame) return;

  svg.dataset.zoom = "1";
  frame.classList.add(FRAME_CLASS);
  // Let the diagram fill the frame; mermaid otherwise caps it with inline max-width.
  svg.style.maxWidth = "none";
  svg.style.width = "100%";
  svg.style.height = "100%";
  addHint(frame);

  try {
    const inst = svgPanZoom(svg, {
      zoomEnabled: true,
      panEnabled: true,
      // svg-pan-zoom's built-in icons are SVG paths drawn in the diagram's
      // coordinate space; against mermaid's viewBox-less SVG they render huge and
      // cover the frame. Render our own HTML controls instead (see addControls).
      controlIconsEnabled: false,
      dblClickZoomEnabled: true,
      mouseWheelZoomEnabled: true,
      fit: true,
      contain: true,
      center: true,
      minZoom: 0.5,
      maxZoom: 12,
      zoomScaleSensitivity: 0.35,
    });
    instances.set(svg, inst);
    addControls(frame, inst);
  } catch {
    // Initialization failed — leave the static diagram in place rather than break the page.
    delete svg.dataset.zoom;
  }
}

function addControls(frame: HTMLElement, inst: SvgPanZoomInstance): void {
  if (frame.querySelector(".mermaid-zoom-controls")) return;
  const bar = document.createElement("div");
  bar.className = "mermaid-zoom-controls";

  const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  };

  bar.append(
    button("+", "Zoom in", () => inst.zoomIn()),
    button("−", "Zoom out", () => inst.zoomOut()),
    button("↺", "Reset view", () => inst.reset()),
  );
  frame.appendChild(bar);
}

function addHint(frame: HTMLElement): void {
  if (frame.querySelector(".mermaid-zoom-hint")) return;
  const hint = document.createElement("span");
  hint.className = "mermaid-zoom-hint";
  hint.textContent = "scroll to zoom · drag to pan";
  frame.appendChild(hint);
}

function pruneDetached(): void {
  instances.forEach((inst, svg) => {
    if (svg.isConnected) return;
    try {
      inst.destroy();
    } catch {
      /* already torn down by mermaid's re-render */
    }
    instances.delete(svg);
  });
}
