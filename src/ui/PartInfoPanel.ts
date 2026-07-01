import { PartInfo } from "../viewer/ViewerController";

/**
 * Small overlay (bottom-right) showing details of the part under the cursor:
 * name, bounding-box dimensions and triangle count. Hidden when nothing is
 * hovered.
 */
export class PartInfoPanel {
  private el: HTMLElement;
  private nameEl: HTMLElement;
  private dimsEl: HTMLElement;
  private trisEl: HTMLElement;

  constructor(host: HTMLElement) {
    this.el = host.createDiv({ cls: "step-viewer-info" });
    this.nameEl = this.el.createDiv({ cls: "step-viewer-info-name" });
    this.dimsEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.trisEl = this.el.createDiv({ cls: "step-viewer-info-meta" });
    this.el.hide();
  }

  update(part: PartInfo | null): void {
    if (!part) {
      this.el.hide();
      return;
    }
    this.nameEl.setText(part.name || "(unnamed)");
    this.dimsEl.setText(
      `${fmt(part.size.x)} × ${fmt(part.size.y)} × ${fmt(part.size.z)} mm`,
    );
    this.trisEl.setText(`${part.triangles.toLocaleString()} triangles`);
    this.el.show();
  }
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}
