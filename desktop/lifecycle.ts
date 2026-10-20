export type CloseIntent = 'hide' | 'quit' | 'update' | 'startup-failed';
export type ExitIntent = Exclude<CloseIntent, 'hide'>;

/** Window close is not application exit. Only an explicit exit may drain the runtime. */
export class DesktopLifecycle {
  private intent: CloseIntent = 'hide';
  private trayAvailable = false;
  private shuttingDown = false;

  get closeIntent(): CloseIntent { return this.intent; }
  get exiting(): boolean { return this.intent !== 'hide'; }

  setTrayAvailable(available: boolean): void { this.trayAvailable = available; }

  /** The first exit request wins; a subsequent app.before-quit must not replace update intent. */
  requestExit(intent: ExitIntent): boolean {
    if (this.shuttingDown) return false;
    if (intent !== 'startup-failed' && this.exiting) return false;
    this.intent = intent;
    return true;
  }

  windowClose(): 'hide' | 'close' {
    if (!this.exiting) {
      if (this.trayAvailable) return 'hide';
      // Never leave a hidden process with no working tray entry point.
      this.intent = 'quit';
    }
    return 'close';
  }

  cancelClose(): void {
    if (!this.shuttingDown) this.intent = 'hide';
  }

  allWindowsClosed(): 'recover' | 'shutdown' {
    return this.exiting ? 'shutdown' : 'recover';
  }

  /** Idempotent and forbidden for ordinary hide or unexpected window loss. */
  beginShutdown(): boolean {
    if (!this.exiting || this.shuttingDown) return false;
    this.shuttingDown = true;
    return true;
  }
}
