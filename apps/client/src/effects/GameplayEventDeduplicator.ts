export class GameplayEventDeduplicator {
  private readonly recentIds = new Set<string>();
  private readonly order: string[] = [];

  public constructor(private readonly capacity = 128) {}

  public accept(eventId: string): boolean {
    if (this.recentIds.has(eventId)) return false;
    this.recentIds.add(eventId);
    this.order.push(eventId);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
    return true;
  }

  public clear(): void {
    this.recentIds.clear();
    this.order.length = 0;
  }

  public get size(): number {
    return this.recentIds.size;
  }
}
