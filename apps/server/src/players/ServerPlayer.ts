export class ServerPlayer {
  public connectionState: 'CONNECTED' | 'DISCONNECTED_GRACE' = 'CONNECTED';
  public get isConnected(): boolean {
    return this.connectionState === 'CONNECTED';
  }
  public constructor(
    public readonly id: string,
    public readonly clientId: string,
    public readonly name: string,
  ) {}
}
