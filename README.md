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

## Build

```bash
npm install
npm run build     # type-checks, bundles main.js, copies occt-import-js.wasm
```

`npm run dev` runs esbuild in watch mode. Both write `main.js` and copy
`occt-import-js.wasm` next to it — the loader reads the WASM from the plugin
directory via the vault adapter at runtime (design doc §6.1).

### Installing into a vault

Copy `main.js`, `manifest.json`, `styles.css`, and `occt-import-js.wasm` into
`<vault>/.obsidian/plugins/step-viewer/`, then enable the plugin.

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
