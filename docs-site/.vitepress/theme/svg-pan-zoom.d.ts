// Minimal ambient types for svg-pan-zoom (ships no .d.ts). Only the surface
// the theme uses is declared.
declare module "svg-pan-zoom" {
  export interface SvgPanZoomInstance {
    resize(): void;
    fit(): void;
    center(): void;
    reset(): void;
    destroy(): void;
    zoomIn(): void;
    zoomOut(): void;
  }
  export interface SvgPanZoomOptions {
    zoomEnabled?: boolean;
    panEnabled?: boolean;
    controlIconsEnabled?: boolean;
    dblClickZoomEnabled?: boolean;
    mouseWheelZoomEnabled?: boolean;
    fit?: boolean;
    contain?: boolean;
    center?: boolean;
    minZoom?: number;
    maxZoom?: number;
    zoomScaleSensitivity?: number;
  }
  export default function svgPanZoom(
    element: SVGElement | string,
    options?: SvgPanZoomOptions,
  ): SvgPanZoomInstance;
}
