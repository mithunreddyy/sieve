/**
 * Background work (P2) runs one task at a time, and only when no hook or tool call is in
 * flight, so it never delays a hook reply.
 */
export class BackgroundQueue {
  private tasks: Array<{ name: string; run: () => void | Promise<void> }> = [];
  private running = false;
  private scheduled = false;
  private stopped = false;
  busy = { hook: 0, tool: 0 };

  get depth(): number {
    return this.tasks.length;
  }

  add(name: string, run: () => void | Promise<void>): void {
    if (this.stopped) return;
    this.tasks.push({ name, run });
    this.schedule();
  }

  private schedule(delay = 0): void {
    if (this.scheduled || this.running) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.tasks.length === 0) return;
    if (this.busy.hook > 0 || this.busy.tool > 0) return this.schedule(2);
    const t = this.tasks.shift()!;
    this.running = true;
    try {
      await t.run();
    } catch (e) {
      console.error(`[sieved] background task ${t.name} failed:`, e);
    } finally {
      this.running = false;
    }
    if (this.tasks.length) this.schedule();
  }

  /** Drop queued work and refuse new work (the databases are about to close). */
  stop(): void {
    this.stopped = true;
    this.tasks = [];
  }

  /** Run everything now (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.tasks.length) {
      const t = this.tasks.shift()!;
      try {
        await t.run();
      } catch (e) {
        console.error(`[sieved] background task ${t.name} failed:`, e);
      }
    }
  }
}
