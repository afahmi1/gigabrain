import { ItemView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { graphFromApp } from "./adapter";
import { CONFIG_FILE, DEFAULT_SCOPE, ScopeConfig, parseScopeConfig } from "./scope";
import { setFolderLabels } from "./layout";
import { AtlasUI } from "./ui";
import { buildDiag } from "./diag";
import { Data, DEFAULT_DATA, mergeData, applyState } from "./data";
import { SelfReloader } from "./reload";
import type { SwcCell } from "./morph";

const VIEW = "palace-atlas-view";

class AtlasView extends ItemView {
  ui?: AtlasUI; timer = 0; diagTimer = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: PalaceAtlasPlugin) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return "Palace Atlas"; }
  getIcon() { return "brain"; }
  async onOpen() {
    const c = this.contentEl; c.empty(); c.addClass("palace-atlas");
    const d = this.plugin.data, dir = this.plugin.manifest.dir, ad = this.app.vault.adapter;
    // Plugin-own assets only (brain.glb, brain_low.glb, morphologies.json next to main.js). Never vault notes.
    const asset = async (f: string) => { try { const p = `${dir}/assets/${f}`; return dir && (await ad.exists(p)) ? await ad.readBinary(p) : null; } catch { return null; } };
    let templates: SwcCell[] | undefined;
    try { const b = await asset("morphologies.json"); if (b) { const j = JSON.parse(new TextDecoder().decode(b)); if (Array.isArray(j?.cells)) templates = j.cells; } } catch { /* optional */ }
    this.ui = new AtlasUI({
      container: c, slots: this.plugin.scope.folders.length,
      banner: this.plugin.scopeError ? `${CONFIG_FILE}: ${this.plugin.scopeError} (showing nothing until fixed)` : undefined,
      initial: { mode: d.mode, positions: d.positions, quality: d.quality },
      loadAsset: asset, templates,
      onOpen: (p) => this.openNote(p),
      // merge, never drop: only the three known keys are written; any other key already in data.json is preserved
      onState: (s) => { applyState(this.plugin.data, s); this.plugin.queueSave(); },
    });
    this.refresh();
    this.diagTimer = window.setTimeout(() => this.plugin.writeDiag(this), 5000); // after ~5 s of rendering
    const ev = this.app.metadataCache.on("resolved", () => { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.refresh(), 1500); });
    this.registerEvent(ev);
    this.registerEvent(this.app.vault.on("delete", () => this.queueRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.queueRefresh()));
    // scope file edits apply on the next reopen of the view; the graph itself refreshes live
  }
  queueRefresh() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.refresh(), 1500); }
  refresh() { this.ui?.setGraph(this.plugin.graph()); }
  // Opening a note is a user-initiated navigation; the plugin itself never reads or writes note content.
  openNote(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f);
  }
  async onClose() { window.clearTimeout(this.timer); window.clearTimeout(this.diagTimer); this.ui?.dispose(); }
}

export default class PalaceAtlasPlugin extends Plugin {
  data: Data = DEFAULT_DATA();
  /** Memory scope from <vault>/palace-atlas.json (shared with the palace-memory server). Invalid file = show nothing (fail closed). */
  scope: ScopeConfig = DEFAULT_SCOPE; scopeError: string | null = null;
  graph() { return this.scopeError ? { nodes: [], edges: [], excluded: 0 } : graphFromApp(this.app, this.scope); }
  async loadScope() {
    try {
      const ad = this.app.vault.adapter;
      const raw = (await ad.exists(CONFIG_FILE)) ? JSON.parse(await ad.read(CONFIG_FILE)) : undefined;
      this.scope = parseScopeConfig(raw); this.scopeError = null;
    } catch (e) { this.scope = DEFAULT_SCOPE; this.scopeError = e instanceof Error ? e.message : String(e); }
    setFolderLabels(this.scope.folders);
  }
  private saveT = 0;
  async onload() {
    this.data = mergeData(await this.loadData());
    await this.loadScope();
    this.registerEvent(this.app.vault.on("modify", (f) => { if (f.path === CONFIG_FILE) void this.loadScope(); }));
    this.registerView(VIEW, (leaf) => new AtlasView(leaf, this));
    this.addRibbonIcon("brain", "Open Palace Atlas", () => void this.activate());
    this.addCommand({ id: "open-palace-atlas", name: "Open Palace Atlas", callback: () => void this.activate() });
    this.app.workspace.onLayoutReady(() => { this.writeDiag(null); void this.startReloader(); });
  }
  private reloader: SelfReloader | null = null;
  /** Self-reload (hot-reload pattern): while loaded, watch our own main.js mtime and re-enable the plugin when a new build is copied in. */
  private async startReloader() {
    const dir = this.manifest.dir, app = this.app as any; if (!dir || !app.plugins?.enablePlugin) return;
    this.reloader = new SelfReloader({ app, id: this.manifest.id, file: `${dir}/main.js` });
    await this.reloader.start();
  }
  private diagLast = 0; private diagPending = 0;
  /** Counts-only diagnostics (see README): written to <plugin dir>/diag.json, at most once per 30 s, never contains note data. */
  writeDiag(view: AtlasView | null) {
    const wait = this.diagLast + 30000 - Date.now();
    if (wait > 0) { window.clearTimeout(this.diagPending); this.diagPending = window.setTimeout(() => this.writeDiag(this.app.workspace.getLeavesOfType(VIEW)[0]?.view as AtlasView ?? null), wait); return; }
    this.diagLast = Date.now();
    void (async () => {
      try {
        const dir = this.manifest.dir; if (!dir) return;
        const v = view ?? (this.app.workspace.getLeavesOfType(VIEW)[0]?.view as AtlasView | undefined) ?? null;
        const diag = buildDiag(this.manifest.version, v?.ui?.scene ? v.ui.scene.graph : this.graph(), v?.ui?.scene ?? null);
        await this.app.vault.adapter.write(`${dir}/diag.json`, JSON.stringify(diag, null, 2));
      } catch { /* diagnostics are best-effort */ }
    })();
  }
  queueSave() { window.clearTimeout(this.saveT); this.saveT = window.setTimeout(() => void this.saveData(this.data), 600); }
  async activate() {
    const ex = this.app.workspace.getLeavesOfType(VIEW)[0];
    const leaf = ex ?? this.app.workspace.getLeaf("tab");
    if (!ex) await leaf.setViewState({ type: VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  async onunload() { this.reloader?.stop(); this.reloader = null; window.clearTimeout(this.saveT); window.clearTimeout(this.diagPending); await this.saveData(this.data); }
}
