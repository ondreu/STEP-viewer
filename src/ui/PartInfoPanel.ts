import { PartInfo } from "../viewer/ViewerController";

/**
 * Small overlay (bottom-right) showing details of the part under the cursor:
 * name, assembly path, material (from STEP metadata, when known), bounding-box
 * dimensions, approximate volume/area, colour and triangle count. Hidden when
 * nothing is hovered.
 */
export class PartInfoPanel {
  private el: HTMLElement;
  private nameEl: HTMLElement;
  private pathEl: HTMLElement;
  private matEl: HTMLElement;
  private matSwatch: HTMLElement;
  private matText: HTMLElement;
  private dimsEl: HTMLElement;
  private centerEl: HTMLElement;
  private volEl: HTMLElement;
  private trisEl: HTMLElement;

  constructor(host: HTMLElement) {
    this.el = host.createDiv({ cls: "step-viewer-info" });
    this.nameEl = this.el.createDiv({ cls: "step-viewer-info-name" });
    this.pathEl = this.el.createDiv({ cls: "step-viewer-info-meta step-viewer-info-path" });
    this.matEl = this.el.createDiv({ cls: "step-viewer-info-meta step-viewer-info-mat" });
    this.matSwatch = this.matEl.createSpan({ cls: "step-viewer-info-swatch" });
    this.matText = this.matEl.createSpan();
    this.dimsEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.centerEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.volEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.trisEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.el.hide();
  }

  update(part: PartInfo | null): void {
    if (!part) {
      this.el.hide();
      return;
    }
    this.nameEl.setText(part.name || "(unnamed)");

    this.pathEl.setText(part.path || "");
    this.pathEl.toggle(!!part.path && part.path !== part.name);

    // Material line: a colour swatch plus material name (or just the colour).
    const hasColor = !!part.color;
    if (part.color) this.matSwatch.style.background = part.color;
    this.matSwatch.toggle(hasColor);
    this.matText.setText(part.material ? `Material: ${part.material}` : hasColor ? "Colour" : "");
    this.matEl.toggle(!!part.material || hasColor);

    this.dimsEl.setText(
      `${fmt(part.size.x)} × ${fmt(part.size.y)} × ${fmt(part.size.z)} mm`,
    );

    this.centerEl.setText(
      `Centre  ${fmt(part.center.x)}, ${fmt(part.center.y)}, ${fmt(part.center.z)} mm`,
    );

    this.volEl.setText(`${volume(part.volume)}  ·  ${area(part.area)}`);
    this.volEl.toggle(part.volume > 0 || part.area > 0);

    this.trisEl.setText(`${part.triangles.toLocaleString()} triangles`);
    this.el.show();
  }
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** Volume in mm³, switching to cm³ for larger parts. */
function volume(mm3: number): string {
  if (mm3 >= 1000) return `${(mm3 / 1000).toFixed(2)} cm³`;
  return `${mm3.toFixed(1)} mm³`;
}

/** Surface area in mm², switching to cm² for larger parts. */
function area(mm2: number): string {
  if (mm2 >= 100) return `${(mm2 / 100).toFixed(2)} cm²`;
  return `${mm2.toFixed(1)} mm²`;
}
