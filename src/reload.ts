// Self-reload watcher (pattern of pjeby/hot-reload): while the plugin is loaded, poll its own main.js mtime and, when it changes,
// disable + enable the plugin so a freshly copied build takes over without restarting Obsidian.
// Guards: no-op if mtime is unchanged since startup; debounce so a half-written file is not loaded; minimum gap and per-minute cap
// so a broken build cannot trigger a reload loop; stops itself on unload.
export interface ReloadApp {
  vault: { adapter: { stat(path: string): Promise<{ mtime: number; size?: number } | null> } };
  plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<unknown> };
}
export interface ReloadOpts {
  app: ReloadApp; id: string; file: string;      // vault-relative path of main.js
  pollMs?: number; debounceMs?: number; minGapMs?: number; maxPerMinute?: number;
  now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void;
}
export class SelfReloader {
  private base: number | null = null; private pendingSince = 0; private pendingMtime = 0; private lastReload = -1e12; private stamps: number[] = [];
  private timer: unknown = null; private stopped = true; private busy = false;
  reloads = 0;
  private o: Required<Omit<ReloadOpts, "app" | "id" | "file">> & Pick<ReloadOpts, "app" | "id" | "file">;
  constructor(o: ReloadOpts) {
    this.o = { pollMs: 2000, debounceMs: 1000, minGapMs: 5000, maxPerMinute: 3, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any), ...o };
  }
  private async mtime(): Promise<number | null> { try { return (await this.o.app.vault.adapter.stat(this.o.file))?.mtime ?? null; } catch { return null; } }
  /** Record the startup mtime, then poll. */
  async start() { this.stopped = false; this.base = await this.mtime(); this.schedule(); }
  stop() { this.stopped = true; if (this.timer !== null) this.o.clearTimer(this.timer); this.timer = null; }
  private schedule() { if (this.stopped) return; this.timer = this.o.setTimer(() => { void this.tick().finally(() => this.schedule()); }, this.o.pollMs); }
  /** One poll step (exposed for tests). Returns true when a reload was performed. */
  async tick(): Promise<boolean> {
    if (this.stopped || this.busy) return false;
    const m = await this.mtime(), t = this.o.now();
    if (m === null) return false;
    if (this.base === null) { this.base = m; return false; }                // file appeared after a failed startup stat: adopt as baseline
    if (m === this.base) { this.pendingSince = 0; return false; }            // unchanged since startup (or since last reload)
    if (m !== this.pendingMtime) { this.pendingMtime = m; this.pendingSince = t; return false; } // still being written: restart debounce
    if (t - this.pendingSince < this.o.debounceMs) return false;
    this.stamps = this.stamps.filter((s) => t - s < 60000);
    if (t - this.lastReload < this.o.minGapMs || this.stamps.length >= this.o.maxPerMinute) return false; // loop guard
    this.busy = true; this.lastReload = t; this.stamps.push(t); this.base = m; this.pendingSince = 0; this.reloads++;
    try { await this.o.app.plugins.disablePlugin(this.o.id); await this.o.app.plugins.enablePlugin(this.o.id); } finally { this.busy = false; }
    return true;
  }
}
