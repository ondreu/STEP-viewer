/**
 * Best-effort extraction of human-relevant metadata from raw STEP text.
 *
 * occt-import-js gives us geometry, per-face colours and the assembly names, but
 * STEP files also carry information it doesn't surface — most usefully the
 * *material* assigned to a part. There is no single canonical way exporters
 * write material, so this is a heuristic pass over the entity graph rather than
 * a full STEP reader: we find material descriptors, then walk the reference
 * graph outward to the nearest PRODUCT(s) to associate a material with a part
 * name. It degrades gracefully — when association fails but the file names a
 * single material, that material is offered for every part.
 */

interface Entity {
  id: number;
  type: string;
  args: string;
}

export interface StepMeta {
  /** Material name for a given part/product name, if one could be resolved. */
  materialFor(partName: string): string | undefined;
  /** All distinct material names found anywhere in the file. */
  allMaterials: string[];
  /** Originating CAD system from the FILE_NAME header, if present. */
  originatingSystem?: string;
}

const EMPTY: StepMeta = { materialFor: () => undefined, allMaterials: [] };

/**
 * Above this size we don't extract metadata: the entity/adjacency graph would
 * be huge and the material heuristic unreliable. Callers also use this to avoid
 * decoding the whole file to a (very large) string in the first place.
 */
export const METADATA_MAX_BYTES = 40_000_000;

export function parseStepMeta(text: string): StepMeta {
  if (!text || text.length > METADATA_MAX_BYTES) return EMPTY; // skip huge files
  try {
    return build(text);
  } catch (err) {
    console.warn("[STEP Viewer] Metadata parse failed", err);
    return EMPTY;
  }
}

function build(text: string): StepMeta {
  const entities = new Map<number, Entity>();
  // Match `#id = TYPE( ... );` records (arguments may span lines).
  const re = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    entities.set(Number(m[1]), { id: Number(m[1]), type: m[2], args: m[3] });
  }

  // Reference graph (undirected): id -> ids it mentions and ids that mention it.
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of entities.values()) {
    for (const ref of refsOf(e.args)) if (entities.has(ref)) link(e.id, ref);
  }

  // Product names, by entity id.
  const productName = new Map<number, string>();
  for (const e of entities.values()) {
    if (e.type === "PRODUCT") {
      const s = strings(e.args);
      if (s[0]) productName.set(e.id, s[0]);
    }
  }

  // Material descriptors: the name is the value string of a material-flavoured
  // descriptive item, or the first string of a MATERIAL_DESIGNATION.
  const materialEntities: { id: number; name: string }[] = [];
  for (const e of entities.values()) {
    const name = materialName(e);
    if (name) materialEntities.push({ id: e.id, name });
  }

  const allMaterials = [...new Set(materialEntities.map((x) => x.name))];

  // Associate each material with the nearest PRODUCT(s) via a bounded search.
  const byProduct = new Map<string, string>();
  for (const { id, name } of materialEntities) {
    for (const pid of nearestProducts(id, adj, productName)) {
      const pname = productName.get(pid);
      if (pname && !byProduct.has(pname)) byProduct.set(pname, name);
    }
  }

  const soleMaterial = allMaterials.length === 1 ? allMaterials[0] : undefined;

  return {
    allMaterials,
    originatingSystem: originatingSystem(entities),
    materialFor: (partName: string) => {
      if (!partName) return byProduct.size === 0 ? soleMaterial : undefined;
      const hit = byProduct.get(partName) ?? byProduct.get(partName.trim());
      if (hit) return hit;
      // No per-product mapping succeeded, but the file names exactly one
      // material — reasonable to attribute it to the part.
      return byProduct.size === 0 ? soleMaterial : undefined;
    },
  };
}

/** BFS out from a material entity to the closest PRODUCT ids (same hop ring). */
function nearestProducts(
  start: number,
  adj: Map<number, Set<number>>,
  products: Map<number, string>,
): number[] {
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let hop = 0; hop < 8 && frontier.length; hop++) {
    const found = frontier.filter((id) => products.has(id));
    if (found.length) return found;
    const next: number[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return frontier.filter((id) => products.has(id));
}

/** Material name carried by an entity, or null if it isn't a material record. */
function materialName(e: Entity): string | null {
  if (e.type === "MATERIAL_DESIGNATION") {
    const s = strings(e.args);
    return s[0]?.trim() || null;
  }
  if (
    e.type === "DESCRIPTIVE_REPRESENTATION_ITEM" ||
    e.type === "PROPERTY_DEFINITION"
  ) {
    const s = strings(e.args);
    if (s.length >= 2 && /material/i.test(s[0]) && s[1].trim()) return s[1].trim();
  }
  return null;
}

function originatingSystem(entities: Map<number, Entity>): string | undefined {
  for (const e of entities.values()) {
    // FILE_NAME isn't a `#id=` record, so it won't be here; kept for exporters
    // that emit an APPLICATION_PROTOCOL/context string as an entity instead.
    if (e.type === "APPLICATION_CONTEXT") {
      const s = strings(e.args);
      if (s[0]) return s[0];
    }
  }
  return undefined;
}

/** All `#123` references in an argument string. */
function refsOf(args: string): number[] {
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(Number(m[1]));
  return out;
}

/** All single-quoted STEP strings in an argument list (unescaping `''`). */
function strings(args: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1].replace(/''/g, "'"));
  return out;
}
