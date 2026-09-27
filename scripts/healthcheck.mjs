import process from 'node:process';

try {
  const port = process.env.PORT;
  if (!port || !/^\d+$/.test(port)) throw new Error('PORT is required');
  const host = process.env.HOST === '::' ? '[::1]' : '127.0.0.1';
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
