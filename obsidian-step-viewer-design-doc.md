# Design doc: Obsidian plugin pro prohlížení STEP modelů

> **Účel dokumentu:** zadání pro LLM/coding agenta, který má plugin implementovat. Dokument je normativní — kde je uvedena verze balíčku, API signatura nebo název souboru, ber to jako závazné, ne jako inspiraci. Kde je něco označeno `[OVĚŘIT]`, implementátor to má před použitím ověřit proti aktuální dokumentaci.

---

## 1. Rozsah (scope)

### V rozsahu (MVP)
- Registrace přípon `.step` a `.stp` jako otevíratelných souborů v Obsidian vaultu.
- Po kliknutí na soubor se otevře 3D prohlížeč v editor leaf.
- Parsování STEP → trojúhelníková síť pomocí `occt-import-js` (WASM).
- Vykreslení sítě pomocí `three.js` s orbit kamerou (rotace / pan / zoom).
- Barvy z modelu (per-face, pokud jsou v STEP), jinak default materiál.
- Zobrazení hran (edges) pro čitelnost geometrie.
- Auto-fit kamery na bounding box modelu při načtení.
- Základní ovládací prvky: reset kamery, přepnutí wireframe, přepnutí zobrazení hran.
- Korektní úklid zdrojů (dispose geometrie, materiálů, WebGL kontextu) při zavření view.

### Mimo rozsah (výslovně NE v MVP)
- **Měření.** Ani vzdálenosti, ani plochy. (Poznámka: měření na tesselované síti je jen aproximace přesné B-rep geometrie. Kdyby se přidávalo později, musí být UI jasně označeno jako "přibližné".)
- **Vytváření / editace** STEP souborů.
- **Přesná B-rep geometrie** (to by vyžadovalo plný `opencascade.js`/`replicad`, řádově větší WASM a jiná architektura).
- Anotace, řezy, exploded view, animace.
- Plná podpora mobilní verze (viz Rizika).

---

## 2. Kritické předpoklady a rizika

Implementátor je musí brát v úvahu, ne je ignorovat:

1. **Velikost WASM.** `occt-import-js.wasm` má několik MB. To ovlivňuje velikost distribuovaného pluginu a čas prvního načtení. WASM se inicializuje **líně** — až při prvním otevření STEP souboru, ne v `onload()` pluginu.
2. **Mesh-only přesnost.** Výstup je triangulace řízená deflection parametry. Vizuálně OK, ale nejde o přesnou geometrii. Nikde v UI netvrdit opak.
3. **Blokování UI.** Parsování velkého STEP může trvat sekundy a `ReadStepFile` je synchronní CPU-bound volání. V MVP je přijatelné parsovat na main threadu s loading indikátorem; Web Worker je optimalizace pro pozdější milník (viz §9).
4. **Mobil.** Obsidian mobile běží v Capacitor webview s omezenou pamětí. WASM tam teoreticky poběží, ale u větších modelů pravděpodobně spadne na paměti. **MVP cílí na desktop.** Na mobilu plugin nemá padat celý Obsidian — při chybě parsování zobrazí chybovou hlášku, ne crash.
5. **Licence.** OpenCASCADE (a tím i `occt-import-js`) je **LGPL-2.1**. Před publikací pluginu zkontrolovat, že distribuce WASM binárky je s LGPL v pořádku a licenci uvést. `[OVĚŘIT]`
6. **WebGL leaky.** Obsidian view se otevírá/zavírá opakovaně. Bez důsledného `dispose()` a uvolnění rendereru dojde k vyčerpání WebGL kontextů (prohlížeč jich drží omezený počet, typicky ~16). Toto je nejčastější zdroj chyb — viz §7.

---

## 3. Tech stack (závazné)

| Vrstva | Volba | Poznámka |
|---|---|---|
| Jazyk | TypeScript | Standard pro Obsidian pluginy |
| Build | esbuild | Dle oficiálního `obsidian-sample-plugin` |
| Obsidian API | `obsidian` (peer) | `registerExtensions`, `registerView`, `FileView` |
| STEP parser | `occt-import-js` (npm) | Aktuální npm verze `0.0.23` `[OVĚŘIT]`, LGPL-2.1 |
| 3D | `three` (npm, aktuální stabilní) | `OrbitControls` z `three/examples/jsm/controls/OrbitControls.js` |

> Pozn.: příklad ve zdrojích `occt-import-js` používá starou `three@0.138`. Pro plugin použij **aktuální stabilní `three`** z npm a importuj `OrbitControls` přes `three/examples/jsm/...` (ne globální `<script>`).

---

## 4. Architektura

```
main.ts                 -> Plugin: onload registruje view + přípony, onunload uklízí
view/StepView.ts        -> FileView: lifecycle souboru, drží ViewerController
viewer/OcctLoader.ts    -> singleton wrapper nad occt-import-js WASM (líná init)
viewer/StepToThree.ts   -> převod occt result JSON -> THREE.Group
viewer/ViewerController.ts -> three.js scéna, kamera, controls, render loop, dispose
viewer/fitCamera.ts     -> fit kamery na bounding box
ui/Toolbar.ts           -> tlačítka (reset, wireframe, edges)
types.ts                -> typy pro occt result
```

Datový tok:
```
klik na .step v file exploreru
  -> Obsidian otevře leaf s view type "step-viewer-view"
  -> StepView.onLoadFile(file)
       -> vault.readBinary(file) => ArrayBuffer => Uint8Array
       -> OcctLoader.get() (líná WASM init, cache instance)
       -> occt.ReadStepFile(bytes, params) => result JSON
       -> StepToThree(result) => THREE.Group
       -> ViewerController.setModel(group) + fitCamera
```

---

## 5. Obsidian integrace — přesné API

### 5.1 Registrace v `main.ts`

```ts
import { Plugin } from "obsidian";
import { StepView, STEP_VIEW_TYPE } from "./view/StepView";

export default class StepViewerPlugin extends Plugin {
  async onload() {
    this.registerView(STEP_VIEW_TYPE, (leaf) => new StepView(leaf));
    this.registerExtensions(["step", "stp"], STEP_VIEW_TYPE);
  }
  // onunload: Obsidian sám odregistruje view/extensions registrované přes this.register*
}
```

> `registerExtensions(exts, viewType)` napojí přípony na view type. `registerView` napojí view type na factory. Kliknutí na soubor otevře příslušný view. Vše registrované přes `this.register*` se uvolní automaticky při `onunload`.

### 5.2 View — dědit z `FileView` (ne `TextFileView`)

STEP je sice ASCII text, ale nechceme ho editovat ani držet jako string — čteme binárně a předáváme parseru. `FileView` je pro read-only, souborem řízené view správná volba.

```ts
import { FileView, WorkspaceLeaf, TFile } from "obsidian";

export const STEP_VIEW_TYPE = "step-viewer-view";

export class StepView extends FileView {
  private controller: ViewerController | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }

  getViewType() { return STEP_VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? "STEP model"; }
  getIcon() { return "box"; } // libovolná Obsidian ikona

  // volá se při otevření/změně souboru v tomto leaf
  async onLoadFile(file: TFile): Promise<void> {
    const container = this.contentEl;
    container.empty();
    const canvasHost = container.createDiv({ cls: "step-viewer-host" });

    this.showLoading(canvasHost);
    try {
      const buffer = await this.app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      const occt = await OcctLoader.get(this); // líná WASM init
      const result = occt.ReadStepFile(bytes, DEFAULT_PARAMS);
      if (!result.success) throw new Error("occt ReadStepFile: success=false");

      const group = stepToThree(result);
      this.controller = new ViewerController(canvasHost);
      this.controller.setModel(group);
      this.hideLoading();
    } catch (e) {
      this.showError(canvasHost, e);
    }
  }

  async onUnloadFile(): Promise<void> {
    this.controller?.dispose();
    this.controller = null;
  }

  async onClose(): Promise<void> {
    this.controller?.dispose();
    this.controller = null;
  }
}
```

> **Pozor:** `onLoadFile` / `onUnloadFile` mohou nastat víckrát za život jednoho view (přepnutí souboru ve stejném leaf). Proto se `ViewerController` vytváří a **disposuje** v párech `onLoadFile`/`onUnloadFile`, ne v `onOpen`/`onClose`.

---

## 6. occt-import-js — API kontrakt

### 6.1 Inicializace WASM (nejošidnější část)

`occt-import-js` je emscripten modul. V prohlížeči obvykle spoléhá na `fetch` `.wasm` souboru přes `locateFile`. **V Obsidianu se `fetch` na plugin adresář nespolehni** — místo toho načti bajty WASM přes vault adapter a předej je modulu přímo přes `wasmBinary`.

```ts
import occtimportjs from "occt-import-js";
import { Plugin } from "obsidian";

let cached: Promise<any> | null = null;

export const OcctLoader = {
  get(plugin: Plugin): Promise<any> {
    if (!cached) cached = init(plugin);
    return cached;
  }
};

async function init(plugin: Plugin): Promise<any> {
  // .wasm je vybundlený vedle main.js v adresáři pluginu
  const dir = plugin.manifest.dir!;                     // .obsidian/plugins/<id>
  const wasmPath = `${dir}/occt-import-js.wasm`;
  const wasmBinary = await plugin.app.vault.adapter.readBinary(wasmPath);

  // module factory přijímá emscripten overrides
  const occt = await occtimportjs({ wasmBinary });
  return occt;
}
```

> **Build musí zkopírovat `occt-import-js.wasm`** z `node_modules/occt-import-js/dist/` do výstupního adresáře pluginu (vedle `main.js`, `manifest.json`, `styles.css`). Přidat krok do esbuild scriptu. Alternativa (self-contained, ale nafoukne `main.js` o ~MB) je inline base64 WASM — **nepreferováno**.
>
> Pokud typový import `occt-import-js` nemá typy, přidej `declare module "occt-import-js"` do `types.ts`. `[OVĚŘIT]` zda balíček dodává `.d.ts`.

### 6.2 Volání a parametry

```ts
export const DEFAULT_PARAMS = {
  linearUnit: "millimeter",        // millimeter|centimeter|meter|inch|foot
  linearDeflectionType: "bounding_box_ratio", // [OVĚŘIT] přesné hodnoty v README
  linearDeflection: 0.001,         // menší = jemnější síť = víc trojúhelníků
  angularDeflection: 0.5
};

const result = occt.ReadStepFile(bytes, DEFAULT_PARAMS); // synchronní, CPU-bound
```

### 6.3 Tvar výsledku (result JSON)

```ts
interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}
interface OcctNode {
  name: string;
  meshes: number[];        // indexy do result.meshes
  children: OcctNode[];
}
interface OcctMesh {
  name: string;
  color?: [number, number, number];   // 0..1 RGB, může chybět
  attributes: {
    position: { array: number[] };    // xyz flat
    normal:   { array: number[] };    // xyz flat
  };
  index: { array: number[] };         // trojúhelníkové indexy
  brep_faces?: Array<{                 // per-face barvy/segmenty
    first: number;                     // index prvního trojúhelníku
    last: number;                      // index posledního trojúhelníku
    color: [number, number, number] | null;
  }>;
}
```

> `success:false` = tvrdá chyba, zobraz chybovou hlášku. Prázdné `meshes` = validní soubor bez geometrie, zobraz "žádná geometrie".

---

## 7. Převod na three.js + správa zdrojů

### 7.1 occt result -> THREE.Group

Pro každý mesh:
- `BufferGeometry` s atributy `position` a `normal` (Float32BufferAttribute, itemSize 3).
- `setIndex` z `index.array`.
- Pokud jsou `brep_faces` s barvami: buď jeden materiál + vertex colors, nebo `geometry.addGroup(first*3, count*3, materialIndex)` + pole materiálů (per-face barvy). Fallback: jeden `MeshStandardMaterial` s `mesh.color` nebo default `0xcccccc`.
- Hrany: `EdgesGeometry` + `LineSegments` s tmavým materiálem, jako child přidat k meshi (toggleovatelné).

### 7.2 ViewerController (skica)

```ts
export class ViewerController {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private ro: ResizeObserver;
  private raf = 0;
  private model: THREE.Group | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);

    // Obsidian mění velikost leaf -> ResizeObserver, ne window.resize
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.onResize();
    this.animate();
  }

  setModel(g: THREE.Group) {
    if (this.model) this.disposeGroup(this.model);
    this.model = g;
    this.scene.add(g);
    fitCameraToObject(this.camera, this.controls, g); // viewer/fitCamera.ts
  }

  private onResize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    if (this.model) this.disposeGroup(this.model);
    this.renderer.dispose();
    this.renderer.forceContextLoss();          // uvolní WebGL kontext
    this.renderer.domElement.remove();
  }

  private disposeGroup(g: THREE.Object3D) {
    g.traverse((o: any) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else m?.dispose?.();
    });
    g.parent?.remove(g);
  }
}
```

> **`dispose()` je povinný.** Bez `renderer.dispose()` + `forceContextLoss()` a bez uvolnění geometrií se po několika otevřeních vyčerpají WebGL kontexty a další modely se přestanou renderovat.

---

## 8. UI / UX

- Prohlížeč vyplní celý content area leaf (`this.contentEl`).
- Malý toolbar (absolutně pozicovaný overlay v rohu): **Reset kamery**, **Wireframe on/off**, **Hrany on/off**.
- Loading stav: zpráva "Načítám STEP…" během `readBinary` + `ReadStepFile` (u velkých souborů sekundy).
- Chybový stav: čitelná hláška + název souboru, žádný stack trace na uživatele.
- Prázdný model: "Soubor neobsahuje zobrazitelnou geometrii."
- Styl přes `styles.css` pluginu; použít Obsidian CSS proměnné (`var(--background-primary)` atd.), aby ladil s tématem. Pozadí scény odvodit z tématu (světlé/tmavé).

---

## 9. Milníky

1. **M1 – Kostra pluginu.** `main.ts`, registrace přípon + view, prázdný `FileView`, který u `.step` ukáže jen název souboru. Ověřuje, že Obsidian přípony správně routuje.
2. **M2 – WASM init.** `OcctLoader` s líným načtením `wasmBinary` z plugin adresáře; build kopíruje `.wasm`. Log, že `ReadStepFile` na testovacím kvádru vrací `success:true` a neprázdné `meshes`.
3. **M3 – Render.** `StepToThree` + `ViewerController`, zobrazení jednoduchého modelu, orbit kamera, auto-fit.
4. **M4 – Vizuální kvalita.** Per-face barvy, hrany, světla laděná dle tématu, resize přes `ResizeObserver`.
5. **M5 – Robustnost.** Dispose/leak audit (opakované otevření 20+ souborů bez ztráty kontextu), chybové a prázdné stavy, větší testovací modely.
6. **M6 (optional) – Web Worker.** Přesun `ReadStepFile` do workeru, aby velké soubory neblokovaly UI. WASM se v tom případě inicializuje uvnitř workeru.

---

## 10. Akceptační kritéria (MVP hotovo, když)

- Kliknutí na `.step` i `.stp` ve file exploreru otevře 3D prohlížeč.
- Testovací sada (malý kvádr, střední sestava, model s per-face barvami) se korektně zobrazí s viditelnými hranami a správnými barvami.
- Orbit / pan / zoom funguje; Reset kamery vrátí fit na model.
- Nevalidní/poškozený soubor zobrazí chybovou hlášku, nespadne Obsidian.
- Otevření a zavření 20+ modelů po sobě nezpůsobí ztrátu WebGL kontextu ani viditelný memory leak.
- `onunload` pluginu proběhne bez reziduálních render loopů (žádný běžící `requestAnimationFrame`).

---

## 11. Otevřené otázky pro implementátora `[OVĚŘIT]`

1. Přesné povolené hodnoty `linearDeflectionType` a doporučené default deflection v aktuální verzi `occt-import-js` README.
2. Zda `occt-import-js` dodává TypeScript typy; jinak napsat vlastní `declare module`.
3. Aktuální stabilní major verze `three` a případné změny v cestě k `OrbitControls`.
4. Chování `vault.adapter.readBinary` na mobilu (Capacitor) — cesta k plugin adresáři se může lišit; případně použít `adapter.getResourcePath` + fetch jako fallback.
5. LGPL-2.1 compliance pro distribuci WASM v rámci community pluginu.
