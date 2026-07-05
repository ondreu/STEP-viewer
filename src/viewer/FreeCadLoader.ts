import * as THREE from "three";
import { unzipSync } from "fflate";
import { OcctLoader } from "./OcctLoader";
import { OcctReadParams } from "../types";
import { StepModel, StepTreeNode, occtResultToGroup } from "./StepToThree";

/**
 * Loader for FreeCAD documents (`.FCStd`).
 *
 * An .FCStd file is a ZIP archive. Its 3D geometry lives in native OpenCASCADE
 * BREP entries (`*.brp`), one per document object; `Document.xml` names the
 * objects, their placements and which BREP file holds each shape; and
 * `GuiDocument.xml` carries the visibility and colour the user set in FreeCAD.
 *
 * We unzip the archive, read those two XML files, then parse each *visible*
 * object's BREP through the same OCCT reader the STEP path uses (via
 * `OcctLoader.parseBrep`), bake its placement into the vertices and colour it
 * from its ShapeColor. The output is an ordinary `StepModel` (group + structure
 * tree), so the rest of the viewer — tree, hover/select, edges, section,
 * measurement — behaves exactly as it does for STEP/OBJ/STL.
 *
 * Scope (MVP): only objects that are visible in FreeCAD and own a shape file are
 * rendered. Sketches, datums and hidden construction features carry no shape (or
 * are hidden), so they are skipped — which also avoids drawing a PartDesign
 * body's intermediate features on top of its final (visible) result.
 */

/** One document object that has geometry to render. */
interface FreeCadObject {
  /** Internal object name (the key shared by Document.xml and GuiDocument.xml). */
  name: string;
  /** User-facing label (falls back to the internal name). */
  label: string;
  /** ZIP entry name of this object's BREP shape. */
  shapeFile: string;
  /** Local→document placement, already baked into a matrix. */
  matrix: THREE.Matrix4;
}

/**
 * Parse a FreeCAD `.FCStd` archive into a viewer `StepModel`. `params` controls
 * the OCCT tessellation coarseness (chosen from file size, as for STEP).
 */
export async function fcstdToStepModel(
  bytes: Uint8Array,
  name: string,
  params: OcctReadParams,
): Promise<StepModel> {
  const entries = unzipSync(bytes);

  const documentXml = readTextEntry(entries, "Document.xml");
  if (!documentXml) {
    throw new Error("Not a FreeCAD document: Document.xml is missing.");
  }
  const guiXml = readTextEntry(entries, "GuiDocument.xml");

  const parser = new DOMParser();
  const doc = parseXml(parser, documentXml, "Document.xml");
  const gui = guiXml ? parseXml(parser, guiXml, "GuiDocument.xml") : null;

  const visibility = gui ? readVisibility(gui) : new Map<string, boolean>();
  const colors = gui ? readColors(gui) : new Map<string, [number, number, number]>();

  const objects = readObjects(doc);
  // Prefer visible objects; if the Gui data marks none visible (or is absent),
  // fall back to every object with a shape so the viewer is never blank.
  const visible = objects.filter((o) => visibility.get(o.name) !== false);
  const chosen = visible.length > 0 ? visible : objects;

  if (chosen.length === 0) {
    throw new Error(
      "This FreeCAD document has no solid or surface geometry to display " +
        "(only sketches, datums or empty bodies).",
    );
  }

  const group = new THREE.Group();
  group.name = "step-model";
  const children: StepTreeNode[] = [];

  for (const obj of chosen) {
    const entry = entries[obj.shapeFile];
    if (!entry) {
      console.warn(`[STEP Viewer] FCStd: shape file "${obj.shapeFile}" missing for "${obj.label}".`);
      continue;
    }
    let result;
    try {
      // parseBrep transfers the byte buffer; give it a private copy so the
      // original ZIP entry (and other objects) stay intact.
      ({ result } = await OcctLoader.parseBrep(entry.slice(), params));
    } catch (err) {
      console.warn(`[STEP Viewer] FCStd: could not parse "${obj.label}" — skipping.`, err);
      continue;
    }
    const color = colors.get(obj.name) ?? null;
    const built = occtResultToGroup(result, obj.label, obj.matrix, color);
    if (built.meshes.length === 0) continue;
    group.add(built.group);
    children.push({
      name: obj.label,
      object: built.group,
      children: built.meshes.map((m) => ({ name: m.name, object: m, children: [] })),
    });
  }

  if (children.length === 0) {
    throw new Error("None of this document's shapes could be rendered.");
  }

  const tree: StepTreeNode = { name, object: group, children };
  return { group, tree };
}

// --- ZIP / XML helpers -------------------------------------------------------

/** Decode a ZIP entry as UTF-8 text, or undefined if it is absent. */
function readTextEntry(
  entries: Record<string, Uint8Array>,
  path: string,
): string | undefined {
  const data = entries[path];
  return data ? new TextDecoder("utf-8").decode(data) : undefined;
}

function parseXml(parser: DOMParser, text: string, label: string): Document {
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(`FreeCAD ${label} is malformed XML.`);
  }
  return doc;
}

/**
 * Read every object that owns a BREP shape from Document.xml's <ObjectData>,
 * along with its label and placement. Objects without a shape file (sketches,
 * datums, containers) are skipped.
 */
function readObjects(doc: Document): FreeCadObject[] {
  const out: FreeCadObject[] = [];
  const objectEls = doc.querySelectorAll("ObjectData > Object");
  objectEls.forEach((objEl) => {
    const name = objEl.getAttribute("name");
    if (!name) return;

    const props = objEl.querySelector("Properties");
    if (!props) return;

    const shapeFile = shapeFileOf(props);
    if (!shapeFile) return; // no geometry — sketch, datum, container, etc.

    out.push({
      name,
      label: labelOf(props) || name,
      shapeFile,
      matrix: placementOf(props),
    });
  });
  return out;
}

/** The ZIP entry name of a Properties block's Part shape, if any. */
function shapeFileOf(props: Element): string | null {
  // <Property name="Shape" ...><Part file="XxxShape.brp"/></Property>
  const propEls = props.querySelectorAll(":scope > Property[name='Shape']");
  for (const p of Array.from(propEls)) {
    const part = p.querySelector("Part[file]");
    const file = part?.getAttribute("file");
    if (file && /\.brp$|\.brep$/i.test(file)) return file;
  }
  return null;
}

/** The user-facing label from a Properties block, if present. */
function labelOf(props: Element): string | null {
  const label = props.querySelector(
    ":scope > Property[name='Label'] > String[value]",
  );
  return label?.getAttribute("value") ?? null;
}

/**
 * Build the placement matrix from a Properties block's App::PropertyPlacement.
 * FreeCAD stores position (Px,Py,Pz) and rotation as a quaternion (Q0..Q3 =
 * x,y,z,w). Returns identity when no placement is present.
 */
function placementOf(props: Element): THREE.Matrix4 {
  const p = props.querySelector(
    ":scope > Property[name='Placement'] PropertyPlacement",
  );
  const m = new THREE.Matrix4();
  if (!p) return m;

  const num = (attr: string, fallback = 0): number => {
    const v = parseFloat(p.getAttribute(attr) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };

  const position = new THREE.Vector3(num("Px"), num("Py"), num("Pz"));
  // Q3 (w) defaults to 1 so a missing rotation yields the identity quaternion.
  const quat = new THREE.Quaternion(num("Q0"), num("Q1"), num("Q2"), num("Q3", 1));
  quat.normalize();
  return m.compose(position, quat, new THREE.Vector3(1, 1, 1));
}

// --- GuiDocument.xml: visibility + colour ------------------------------------

/** Map of object name → visible flag, from GuiDocument's ViewProviders. */
function readVisibility(gui: Document): Map<string, boolean> {
  const map = new Map<string, boolean>();
  gui.querySelectorAll("ViewProviderData > ViewProvider").forEach((vp) => {
    const name = vp.getAttribute("name");
    if (!name) return;
    const bool = vp.querySelector(
      ":scope Property[name='Visibility'] > Bool[value]",
    );
    if (bool) map.set(name, bool.getAttribute("value") === "true");
  });
  return map;
}

/**
 * Map of object name → RGB (0..1), from each ViewProvider's ShapeColor. FreeCAD
 * packs the colour as an unsigned int with red in the high byte:
 * (R<<24)|(G<<16)|(B<<8)|A.
 */
function readColors(gui: Document): Map<string, [number, number, number]> {
  const map = new Map<string, [number, number, number]>();
  gui.querySelectorAll("ViewProviderData > ViewProvider").forEach((vp) => {
    const name = vp.getAttribute("name");
    if (!name) return;
    const col = vp.querySelector(
      ":scope Property[name='ShapeColor'] > PropertyColor[value]",
    );
    const packed = col ? Number(col.getAttribute("value")) : NaN;
    if (!Number.isFinite(packed)) return;
    const v = packed >>> 0;
    map.set(name, [
      ((v >>> 24) & 0xff) / 255,
      ((v >>> 16) & 0xff) / 255,
      ((v >>> 8) & 0xff) / 255,
    ]);
  });
  return map;
}
