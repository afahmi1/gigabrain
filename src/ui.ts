import { AtlasGraph } from "./adapter";
import { AtlasScene, Mode, PosMap } from "./scene";
import { FOLDER_COLOR, FOLDER_LABEL } from "./layout";
import { Quality, QUALITIES, QUALITY, QUALITY_LABEL, isQuality } from "./quality";
import { parseBrainGLB } from "./brain";
import type { SwcCell } from "./morph";
import { SLOTS } from "./scope";

export interface UIOpts {
  container: HTMLElement;
  banner?: string;                       // e.g. DEMO fixture notice
  slots?: number;                        // number of configured folders (1-3) shown in the legend
  onOpen: (path: string) => void;
  initial?: { mode?: Mode; positions?: PosMap; rotate?: boolean; quality?: Quality };
  onState?: (s: { mode: Mode; positions: PosMap; quality?: Quality }) => void;
  /** Returns the bytes of an asset file next to main.js (`brain.glb`, `brain_low.glb`), or null when it does not exist. Offline: local files only. */
  loadAsset?: (file: string) => Promise<ArrayBuffer | null>;
  templates?: SwcCell[]; intro?: boolean;
  dustCount?: number;
  morphMs?: number;
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) => {
  const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; parent?.appendChild(e); return e;
};

export class AtlasUI {
  scene: AtlasScene;
  graph: AtlasGraph = { nodes: [], edges: [], excluded: 0 };
  root: HTMLElement; search!: HTMLInputElement; list!: HTMLUListElement; status!: HTMLElement; stats!: HTMLElement; tip!: HTMLElement;
  private btnMode!: HTMLButtonElement; private live!: HTMLElement;
  private positions: PosMap; private userQuality?: Quality; private assetFile = ""; private assetSeq = 0; private sel!: HTMLSelectElement; private legend!: HTMLElement;

  constructor(private o: UIOpts) {
    this.positions = o.initial?.positions ?? {};
    this.root = el("div", "pa-root", o.container);
    if (o.banner) { const b = el("div", "pa-banner", this.root, o.banner); b.setAttribute("role", "note"); }
    const bar = el("div", "pa-toolbar", this.root); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Palace Atlas controls");
    this.search = el("input", "pa-search", bar); this.search.type = "search"; this.search.placeholder = "Search notes (title, path, folder)"; this.search.setAttribute("aria-label", "Search notes");
    this.btnMode = el("button", "pa-btn pa-mode", bar); this.btnMode.setAttribute("aria-label", "Toggle brain or universe layout");
    const rot = el("button", "pa-btn pa-rotate", bar, "Rotate");
    const pulse = el("button", "pa-btn pa-pulse-btn", bar); pulse.title = "Pause or play the lightning: discharges along real links and decorative flashes over the cortex";
    const edit = el("button", "pa-btn pa-edit-btn", bar, "Move stars"); edit.setAttribute("aria-pressed", "false"); edit.title = "Drag stars to custom positions (saved in plugin data only)";
    this.sel = el("select", "pa-btn pa-quality", bar); this.sel.setAttribute("aria-label", "Render quality"); this.sel.title = "Render quality: High (bloom glow, tube neurons), Balanced, Low (no bloom, line neurons)";
    for (const q of QUALITIES) { const op = el("option", "", this.sel, `Quality: ${QUALITY_LABEL[q]}`); op.value = q; }
    const rp = el("button", "pa-btn pa-reset-pos", bar, "Reset positions");
    const rv = el("button", "pa-btn pa-reset-view", bar, "Reset view");
    const main = el("div", "pa-main", this.root);
    const stage = el("div", "pa-stage", main);
    const lg = this.legend = el("div", "pa-legend", stage); lg.setAttribute("aria-label", "Folder colours");
    for (const f of SLOTS.slice(0, Math.max(1, Math.min(3, o.slots ?? 3)))) { const it = el("span", "pa-legend-item", lg); const sw = el("span", "pa-legend-swatch", it); sw.style.background = `rgb(${FOLDER_COLOR[f].map((v) => Math.round(v * 255)).join(",")})`; sw.setAttribute("aria-hidden", "true"); el("span", "", it, FOLDER_LABEL[f]); it.dataset.folder = f; }
    this.tip = el("div", "pa-tip", stage); this.tip.style.display = "none"; this.tip.setAttribute("aria-hidden", "true");
    const side = el("aside", "pa-side", main); side.setAttribute("aria-label", "Notes list");
    this.status = el("div", "pa-status", side); this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.list = el("ul", "pa-list", side); this.list.setAttribute("role", "list");
    this.stats = el("div", "pa-foot", this.root);
    this.live = this.status;

    this.scene = new AtlasScene({
      container: stage, onOpen: (p) => o.onOpen(p), dustCount: o.dustCount, morphMs: o.morphMs, autoRotate: o.initial?.rotate ?? true, quality: isQuality(o.initial?.quality) ? o.initial!.quality : undefined, templates: o.templates, intro: o.intro,
      onPositions: (p) => { this.positions = p; this.emit(); },
      onHover: (i) => {
        if (i < 0) { this.tip.style.display = "none"; return; }
        const n = this.graph.nodes[i];
        this.tip.innerHTML = ""; el("b", "", this.tip, n.title); el("div", "pa-tip-sub", this.tip, `${FOLDER_LABEL[n.folder]} · ${n.degree} links`);
        this.tip.style.display = "block";
      },
    });
    stage.addEventListener("pointermove", (e) => { const r = stage.getBoundingClientRect(); this.tip.style.left = e.clientX - r.left + 14 + "px"; this.tip.style.top = e.clientY - r.top + 14 + "px"; });
    rot.setAttribute("aria-pressed", String(this.scene.controls?.autoRotate ?? false)); // honours prefers-reduced-motion
    this.userQuality = isQuality(o.initial?.quality) ? o.initial!.quality : undefined; this.sel.value = this.scene.quality;
    this.sel.addEventListener("change", () => { const q = this.sel.value; if (!isQuality(q)) return; this.userQuality = q; this.scene.setQuality(q); this.refreshStats(); void this.syncAsset(); this.emit(); });
    void this.syncAsset();
    this.scene.setMode(o.initial?.mode ?? "brain", true);
    this.syncMode();

    this.search.addEventListener("input", () => { this.scene.setSearch(this.search.value); this.renderList(); });
    this.search.addEventListener("keydown", (e) => { if (e.key === "Enter" && this.scene.matches.length) { this.scene.setFocus(this.scene.matches[0], true); } });
    this.btnMode.addEventListener("click", () => { this.scene.toggleMode(); this.syncMode(); this.emit(); });
    rot.addEventListener("click", () => { const on = rot.getAttribute("aria-pressed") !== "true"; rot.setAttribute("aria-pressed", String(on)); this.scene.setAutoRotate(on); });
    edit.addEventListener("click", () => { const on = edit.getAttribute("aria-pressed") !== "true"; edit.setAttribute("aria-pressed", String(on)); this.scene.setEdit(on); });
    const syncPulse = () => { const on = this.scene.pulsesOn; pulse.textContent = on ? "Pause pulses" : "Play pulses"; pulse.removeAttribute("aria-pressed"); /* label-only toggle: the visible text names the action, so no pressed state */ pulse.setAttribute("aria-label", on ? "Pause lightning animation" : "Play lightning animation"); };
    syncPulse();
    pulse.addEventListener("click", () => { this.scene.setPulses(!this.scene.pulsesOn); syncPulse(); });
    rp.addEventListener("click", () => { this.scene.resetPositions(); });
    rv.addEventListener("click", () => this.scene.resetView());
  }
  private emit() { this.o.onState?.({ mode: this.scene.mode, positions: this.positions, ...(this.userQuality ? { quality: this.userQuality } : {}) }); }
  /** Load the brain mesh that matches the current quality (brain_low.glb on Low, falling back to brain.glb). Failures leave the procedural scaffold. */
  private async syncAsset() {
    const load = this.o.loadAsset; if (!load) return;
    const want = QUALITY[this.scene.quality].asset, seq = ++this.assetSeq; if (want === this.assetFile && this.scene.asset) return;
    try {
      let bytes = await load(want); if (!bytes && want !== "brain.glb") bytes = await load("brain.glb");
      if (!bytes || seq !== this.assetSeq) return;
      const fieldBytes = await load("brain_sdf.bin"); // optional: parseBrainGLB generates a valid field when it is missing/corrupt (fail closed)
      if (seq !== this.assetSeq) return;
      const a = await parseBrainGLB(bytes, fieldBytes); if (seq !== this.assetSeq) { a.dispose(); return; }
      this.assetFile = want; this.scene.setBrainAsset(a); this.refreshStats();
    } catch { /* keep the procedural scaffold */ }
  }
  private syncMode() {
    const u = this.scene.mode === "universe";
    this.btnMode.textContent = u ? "Universe → Brain" : "Brain → Universe";
    this.btnMode.setAttribute("aria-pressed", String(u));
  }
  setGraph(g: AtlasGraph) {
    this.graph = g;
    // prune stored positions for notes that no longer exist or are no longer allowed
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const k of Object.keys(this.positions)) if (!ids.has(k)) delete this.positions[k];
    this.scene.setGraph(g, this.positions);
    this.scene.setSearch(this.search.value);
    this.renderList();
    this.refreshStats();
  }
  private refreshStats() {
    const g = this.graph, dbg = this.scene.debug();
    const brain = dbg.assetLoaded ? "Brain surface: bundled original procedural mesh (illustration, not an anatomical scan; see assets/LICENSES.md); note placement is illustrative" : "Procedural illustrative brain scaffold, not an anatomical scan";
    this.stats.textContent = `${g.nodes.length} notes as neurons · ${g.edges.length} links (your wikilinks) · background cells and sparkle are decoration · folders are not brain regions` + (g.excluded ? ` · ${g.excluded} private/ineligible files withheld` : ""); this.legend.title = `${g.nodes.length} notes (neuron cells) · ${g.edges.length} links (your wikilinks, drawn as curved fibres from one note's axon to another's dendrite; not synapses) · ${dbg.decorNeurons.toLocaleString()} decorative background neurons and ${dbg.dust.toLocaleString()} decorative dust particles (not notes, not links) · ${g.excluded} private/ineligible files withheld. ${brain}: folders are not real brain regions. Lightning along links (one bolt per link), decorative lightning over the cortex (${dbg.lightning.ambientBolts.toLocaleString()} ambient bolts, not notes, not links) and the brain/universe morph are decoration; they are not neural activity.`;
  }
  renderList() {
    const m = this.scene.matches, g = this.graph, MAX = 300;
    this.list.innerHTML = "";
    for (const i of m.slice(0, MAX)) {
      const n = g.nodes[i];
      const li = el("li", "pa-item", this.list);
      const b = el("button", "pa-item-btn", li); b.dataset.path = n.id;
      const dot = el("span", "pa-dot", b); dot.style.background = `rgb(${FOLDER_COLOR[n.folder].map((v) => Math.round(v * 255)).join(",")})`; dot.setAttribute("aria-hidden", "true");
      el("span", "pa-item-title", b, n.title); el("span", "pa-item-folder", b, FOLDER_LABEL[n.folder]);
      b.addEventListener("click", () => this.o.onOpen(n.id));
      b.addEventListener("focus", () => this.scene.setFocus(i, false));
      b.addEventListener("mouseenter", () => this.scene.setFocus(i, false));
      b.addEventListener("blur", () => this.scene.setFocus(-1));
    }
    this.status.textContent = `${m.length} of ${g.nodes.length} notes${this.search.value ? " match" : ""}${m.length > MAX ? `, showing first ${MAX}` : ""}`;
  }
  dispose() { this.scene.dispose(); this.root.remove(); }
}
