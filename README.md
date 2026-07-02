# STEP Viewer for Obsidian

View STEP (`.step` / `.stp`) CAD models directly inside Obsidian in an
interactive 3D viewer. Click a STEP file in the file explorer and it opens in a
[`three.js`](https://threejs.org/)-powered viewer with orbit / pan / zoom, model
colours, edges, measurement, annotations and a navigation cube — or embed a
model inline in any note.

Parsing is done with [`occt-import-js`](https://www.npmjs.com/package/occt-import-js)
(OpenCASCADE compiled to WASM). Built to the specification in
[`obsidian-step-viewer-design-doc.md`](./obsidian-step-viewer-design-doc.md).

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B7K822EW68)

> **Mobile support (beta).** The plugin also runs on Obsidian mobile: the
> layout adapts to small touchscreens and orbit / pan / pinch-zoom work with
> touch (tap a part to see its info). Because the WASM parser can run out of
> memory on large models in the mobile webview, opening a large file first
> shows a warning you can dismiss to continue (design doc §2.4).

## Install

This plugin isn't in the community store yet. Install the beta with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. BRAT → **Add beta plugin** → enter `ondreu/step-viewer`.
3. Enable **STEP Viewer** in Community plugins.

BRAT installs `main.js`, `manifest.json` and `styles.css` from the latest
release. The `occt-import-js` WASM is **inlined into `main.js`**, so the plugin
is self-contained — no extra files to copy (design doc §6.1).

### Manual install

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/ondreu/step-viewer/releases/latest) into
`<vault>/.obsidian/plugins/step-viewer/`, then enable the plugin.

## Features

- **Open `.step` / `.stp`** files straight from the file explorer.
- **3D rendering** with `three.js`: orbit / pan / zoom, per-face colours from
  the model (default material otherwise), edge display, and auto-fit on load.
- **Navigation cube** (top-right) that tracks the camera — click a face to snap
  to a standard view (front / back / top / bottom / left / right), with
  **↶ / ↷ arrows** that animate a 90° roll.
- **Wireframe** and **transparency** toggles (transparency reveals internals).
- **Perspective / orthographic** projection toggle (orthographic is often better
  for judging CAD proportions).
- **Section plane** — a movable clipping plane (X / Y / Z axis, flip side, and a
  position slider) that cuts into the model to inspect internal dimensions.
- **Explode view** — a slider that spreads an assembly's top-level parts outward
  from its centre.
- **Isolate** — hide everything except the part selected in the structure tree.
- **Hover highlight + info** — the part under the cursor is highlighted and an
  info panel shows its name, bounding-box size and triangle count; the matching
  node is revealed in the structure tree.
- **Structure tree** — the STEP assembly hierarchy, with per-part visibility
  toggles and click-to-frame.
- **Measurement types** — choose from a strip below the ruler button:
  - **Distance** — two points: straight-line distance **plus per-axis X / Y / Z
    components**, as colour-coded legs and numbers beside each line.
  - **Angle** — three points (the corner is the 2nd).
  - **Radius / diameter** — three points around a circular edge (circle fit).
  - **Thickness** — a point on a face; a ray through the solid finds the far side.
  - **Point → face** — perpendicular distance from a point to a face's plane.
  - **Face → face** — distance between two faces along the first face's normal.
- **Pinned measurements** — press the 📌 **pin** button in the readout to keep a
  measurement. Pinned measurements are parented to the model (so they follow
  rolls) and are saved per file; each has a distance label with a delete button.
- **Snap to corners / edges** — the magnet toggle snaps both measurement and
  annotation picks to the nearest visible vertex/edge, with a live preview
  marker (green when snapping, orange when free).
- **Annotations** — pin editable notes to points on the model; they follow the
  part through rolls and are saved per file. An annotations list panel shows
  each note and the part it's attached to, with show/hide and opacity controls.
  Each note has per-note controls:
  - **Hover-only** — collapse the note to a dot and reveal the text on hover.
  - **Leader** — place the note off to the side with a dashed leader line and
    arrowhead pointing back to its anchor; drag the note to reposition it.
  - **Category colour** — a swatch opens a palette (Note / Issue / OK / Info);
    the list panel can filter by category.
  - **Markdown** — note text renders as Markdown in read state (click to edit).
  - **Link** — attach an Obsidian note (wikilink); a ↗ chip opens it.
- **Screenshot** — capture the current view (model + measurement/note captions)
  as a PNG saved next to the model, with an embed link copied to the clipboard.
- **Note embeds** — render a model inline in any note (see below).

> **Measurement and annotations are approximate.** They run against the
> tessellated mesh, not the exact B-rep geometry, so readings are close to — but
> not exactly — the true CAD dimensions. The measurement readout is labelled
> `(approx.)` accordingly (design doc §1).

## Usage

Open any `.step` or `.stp` file from the file explorer. The toolbar (top-right,
below the navigation cube) provides:

| Button | Action |
| --- | --- |
| Fit | Reset / fit the camera to the model |
| Wireframe | Toggle wireframe rendering |
| Edges | Toggle edge display |
| Transparency | Make surfaces translucent to see inside |
| Projection | Switch perspective ↔ orthographic |
| Section | Show the clipping-plane control (axis / flip / position) |
| Explode | Show the explode slider |
| Measure | Enable measuring; pick a type from the strip that appears |
| Snap | Snap measurement/annotation picks to corners & edges |
| Annotate | Click a point to pin an editable note |
| Screenshot | Save a PNG of the current view next to the model |
| Annotations | Open the annotations list panel |
| Structure | Open the assembly structure tree |

The buttons are grouped (framing · appearance · inspect · measure/annotate ·
output/panels) with thin dividers. The ↶ / ↷ arrows below the cube roll the view
90°.

In the **structure tree**, hover a row to highlight that part in 3D, click it to
select and frame it, and use the header controls to expand/collapse all, toggle
all visibility, filter by name, or **isolate** the selected part (hide the rest).

### Embedding a model in a note

````markdown
```step
path: Models/bracket.step
height: 320
view: front          # optional: front/back/left/right/top/bottom/iso
rotate: 90           # optional: initial roll in degrees (or `roll: 1` in quarter turns)
annotations: false   # optional: hide saved notes in this embed (default true)
```
````

`path` accepts a wikilink target (`[[bracket.step]]`) or a vault-relative path;
`height` is optional (pixels, default 400). Each embed mounts its own viewer
when it scrolls into view and is disposed when it scrolls away, so a note with
many embeds doesn't exhaust the browser's limited WebGL contexts.

Annotations **and pinned measurements** are keyed by file path, so notes and
measurements added in the full view also appear in embeds of the same model, and
vice versa.

## Development

```bash
npm install
npm run build     # type-checks and bundles a self-contained main.js
npm run dev       # esbuild watch mode
```

The build inlines `occt-import-js.wasm` into `main.js` (esbuild binary loader),
so no separate WASM file ships.

### Cutting a release

Bump the version in `manifest.json`, `package.json` and `versions.json`, commit,
then push a matching tag (no `v` prefix):

```bash
git tag 0.7.0 && git push origin 0.7.0
```

`.github/workflows/release.yml` builds and publishes a GitHub release with the
three assets BRAT needs (`main.js`, `manifest.json`, `styles.css`).

## Architecture

See design doc §4. Source lives in `src/`:

```
main.ts                     Plugin: registers view, extensions, embed processor
view/StepView.ts            FileView: file lifecycle, owns the viewer
embed/StepEmbed.ts          `step` code-block embed (lazy mount/dispose)
viewer/mountViewer.ts       Builds the full viewer + UI (shared by view & embed)
viewer/OcctLoader.ts        Lazy singleton over the inlined occt-import-js WASM
viewer/StepToThree.ts       occt result JSON -> THREE.Group + structure tree
viewer/ViewerController.ts  Scene, camera, controls, picking, measure, dispose
viewer/fitCamera.ts         Camera fit to bounding box
viewer/params.ts            ReadStepFile default parameters
ui/Toolbar.ts               Toolbar buttons + measurement-type strip
ui/ViewCube.ts              Navigation cube
ui/ViewControls.ts          Floating section + explode controls
ui/TreePanel.ts             Structure-tree panel (select / frame / isolate)
ui/PartInfoPanel.ts         Hover info panel
ui/LabelLayer.ts            Projected HTML labels + leader lines (screenshot draw)
ui/AnnotationLayer.ts       Annotation pins + notes (markdown / link / colour)
ui/AnnotationsPanel.ts      Annotations list panel (hide / opacity / filter)
ui/MeasurementLayer.ts      Pinned (persistent) measurements
annotations/AnnotationStore.ts  Per-file annotation persistence (plugin data)
annotations/MeasurementStore.ts Per-file pinned-measurement persistence
annotations/pluginData.ts   Serialized read-modify-write of data.json
types.ts, occt-import-js.d.ts   occt typings + result shape
```

Each open view (and embed) owns a WebGL context and disposes it on close
(`renderer.dispose()` + `forceContextLoss()`), which is essential to avoid
exhausting the browser's limited context pool (design doc §2.6 / §7.2).

## License

MIT (this plugin). `occt-import-js` / OpenCASCADE is **LGPL-2.1**; the bundled
`occt-import-js.wasm` is distributed under that licence (see
`node_modules/occt-import-js/dist/license.*.txt`). Verify LGPL compliance before
publishing to the community store (design doc §2.5 / §11.5).
