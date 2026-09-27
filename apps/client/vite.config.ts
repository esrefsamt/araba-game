import { defineConfig, loadEnv } from 'vite';
import { resolveWebSocketUrl } from './src/networking/ConnectionConfig.js';

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  if (command === 'build' && environment['VITE_WS_URL']?.trim()) {
    // Validate without embedding a deployment domain. Runtime also enforces HTTPS/WSS.
    resolveWebSocketUrl(
      environment['VITE_WS_URL'],
      { href: 'http://build.invalid/', protocol: 'http:' },
      false,
    );
  }
  return {
    plugins: [
      {
        name: 'production-debug-visibility',
        transformIndexHtml(html) {
          return command === 'build'
            ? html.replace('id="debug-panel"', 'id="debug-panel" hidden')
            : html;
        },
      },
    ],
    server: {
      host: '0.0.0.0',
      port: 5_173,
      strictPort: true,
    },
    build: { sourcemap: false },
  };
});
