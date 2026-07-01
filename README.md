# STEP Viewer for Obsidian

View STEP (`.step` / `.stp`) CAD models directly inside Obsidian in an
interactive 3D viewer. Click a STEP file in the file explorer and it opens in a
`three.js`-powered viewer with orbit / pan / zoom, model colors, and edge
display.

Built to the specification in
[`obsidian-step-viewer-design-doc.md`](./obsidian-step-viewer-design-doc.md).

## Features (MVP)

- Registers `.step` and `.stp` as openable files.
- Parses STEP → triangle mesh with [`occt-import-js`](https://www.npmjs.com/package/occt-import-js) (OpenCASCADE, WASM).
- Renders with `three.js`, orbit camera, auto-fit on load.
- Per-face colors from the model when present, default material otherwise.
- Edge display for geometry readability.
- Toolbar: reset camera, toggle wireframe, toggle edges.
- Themed background and clean loading / empty / error states.
- Careful resource cleanup (geometry, materials, WebGL context) on close.

## Not in scope (MVP)

Measurement, STEP editing/creation, exact B-rep geometry, annotations,
sections, exploded views, animation, and full mobile support. This plugin
targets **desktop** (`isDesktopOnly: true`). See design doc §1 for the full
list and rationale.

> The viewer works on a tessellated mesh, not exact B-rep geometry. It is for
> visualization only.

## Install with BRAT (recommended)

This plugin isn't in the community store yet. To install the beta with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from the community plugins.
2. BRAT → *Add beta plugin* → enter this repository (`ondreu/step-viewer`).
3. Enable **STEP Viewer** in Community plugins.

BRAT installs `main.js`, `manifest.json`, and `styles.css` from the latest
GitHub release. The `occt-import-js` WASM is **inlined into `main.js`**, so the
plugin is self-contained — no extra files to copy (design doc §6.1).

## Build

```bash
npm install
npm run build     # type-checks and bundles a self-contained main.js
```

`npm run dev` runs esbuild in watch mode. The build inlines
`occt-import-js.wasm` into `main.js` (esbuild binary loader), so no separate
WASM file ships. Releases are produced by `.github/workflows/release.yml` on
tag push.

### Manual install

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/step-viewer/`, then enable the plugin.

### Cutting a release

Bump the version in `manifest.json` (and `package.json` / `versions.json`),
then push a matching tag:

```bash
git tag 0.1.0 && git push origin 0.1.0
```

The workflow builds and publishes a GitHub release with the three assets BRAT
needs.

## Architecture

See design doc §4. Source lives in `src/`:

```
src/main.ts                     Plugin: registers view + extensions
src/view/StepView.ts            FileView: file lifecycle, owns ViewerController
src/viewer/OcctLoader.ts        Lazy singleton over occt-import-js WASM
src/viewer/StepToThree.ts       occt result JSON -> THREE.Group
src/viewer/ViewerController.ts  three.js scene, camera, controls, dispose
src/viewer/fitCamera.ts         camera fit to bounding box
src/viewer/params.ts            ReadStepFile default parameters
src/ui/Toolbar.ts               reset / wireframe / edges buttons
src/types.ts                    occt-import-js typings + result shape
```

## License

MIT (this plugin). Note that `occt-import-js` / OpenCASCADE is **LGPL-2.1**;
the bundled `occt-import-js.wasm` is distributed under that license. Verify
LGPL compliance before publishing (design doc §2.5 / §11.5).
