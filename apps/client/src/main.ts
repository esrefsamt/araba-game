import './style.css';
import './session.css';

import { Game } from './core/Game.js';

const gameRoot = document.getElementById('game-root');
if (gameRoot === null) {
  throw new Error('Game root element is missing.');
}

try {
  const game = new Game(gameRoot);
  game.start();
  window.addEventListener('beforeunload', () => {
    game.dispose();
  });
} catch (error: unknown) {
  const detail = document.getElementById('session-message');
  if (detail)
    detail.textContent =
      error instanceof Error ? error.message : 'Unable to initialize the game.';
  for (const id of ['session-create', 'session-join']) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = true;
  }
}
