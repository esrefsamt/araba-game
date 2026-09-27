const PLAYER_PALETTE = [
  0xf29b70, 0xf2cf66, 0x71cbd1, 0xe997bd, 0x84c98f, 0xa991d4, 0xe77979, 0x769fda,
] as const;

export function playerColorIndex(playerId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < playerId.length; index += 1) {
    hash ^= playerId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % PLAYER_PALETTE.length;
}

export function playerColorHex(playerId: string): number {
  return PLAYER_PALETTE[playerColorIndex(playerId)]!;
}

export function playerColorCss(playerId: string): string {
  return `#${playerColorHex(playerId).toString(16).padStart(6, '0')}`;
}

export function playerPaletteSize(): number {
  return PLAYER_PALETTE.length;
}
