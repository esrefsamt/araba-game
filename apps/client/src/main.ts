import './style.css';
import './session.css';

import { Game } from './core/Game.js';

const gameRoot = document.getElementById('game-root');
if (gameRoot === null) {
  throw new Error('Game root element is missing.');
}

const game = new Game(gameRoot);
game.start();

window.addEventListener('beforeunload', () => {
  game.dispose();
});
