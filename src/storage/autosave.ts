/**
 * Debounced autosave with retry. The caller supplies `save`, which reads the
 * current editor state at call time (so the latest content is always saved).
 */
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'retrying' | 'error' | 'conflict';

export interface AutosaverOptions {
  save: () => Promise<'ok' | 'conflict'>;
  onState: (state: SaveState) => void;
  debounceMs?: number;
  /** Failures before the state becomes a visible warning. */
  warnAfter?: number;
}

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private _state: SaveState = 'saved';
  private readonly debounceMs: number;
  private readonly warnAfter: number;
  private paused = false;

  constructor(private readonly opts: AutosaverOptions) {
    this.debounceMs = opts.debounceMs ?? 600;
    this.warnAfter = opts.warnAfter ?? 3;
  }

  get state(): SaveState {
    return this._state;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty || this.inFlight !== null;
  }

  markDirty(): void {
    this.dirty = true;
    if (this._state !== 'conflict') this.setState(this.failures >= this.warnAfter ? 'error' : 'unsaved');
    this.schedule(this.debounceMs);
  }

  /** Save now (blur, visibilitychange, beforeunload, switching documents). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.run();
  }

  /** Stop saving (e.g. while a cross-tab conflict is unresolved). */
  pause(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(markSaved = false): void {
    this.paused = false;
    if (markSaved) {
      this.dirty = false;
      this.failures = 0;
      this.setState('saved');
    } else if (this.dirty) this.schedule(0);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private async run(): Promise<void> {
    if (this.paused) return;
    if (this.inFlight) {
      await this.inFlight;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.setState(this.failures > 0 ? 'retrying' : 'saving');
    this.inFlight = (async () => {
      try {
        const result = await this.opts.save();
        if (result === 'conflict') {
          this.dirty = true;
          this.pause();
          this.setState('conflict');
          return;
        }
        this.failures = 0;
        this.setState(this.dirty ? 'unsaved' : 'saved');
      } catch {
        this.dirty = true;
        this.failures++;
        this.setState(this.failures >= this.warnAfter ? 'error' : 'retrying');
        this.schedule(Math.min(15_000, 500 * 2 ** this.failures));
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    if (this.dirty && !this.paused && !this.timer && this._state !== 'retrying' && this._state !== 'error') this.schedule(this.debounceMs);
  }

  private setState(s: SaveState) {
    if (s === this._state) return;
    this._state = s;
    this.opts.onState(s);
  }
}
