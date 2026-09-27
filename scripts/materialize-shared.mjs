import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// pnpm 11.19 legacy deploy leaves this linked workspace dependency outside its output.
// Replace only that generated symlink with the shared package's compiled runtime files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] ?? '');
if (
  !process.argv[2] ||
  JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name !==
    '@trailer-arena/server'
)
  throw new Error('Expected a generated server deployment directory.');
const shared = join(target, 'node_modules', '@trailer-arena', 'shared');
if (!realpathSync(dirname(shared)).startsWith(realpathSync(target) + sep))
  throw new Error('Shared package parent escapes the deployment directory.');
if (!lstatSync(shared).isSymbolicLink())
  throw new Error('Expected a generated workspace symlink.');
unlinkSync(shared);
mkdirSync(shared);
cpSync(join(root, 'packages/shared/package.json'), join(shared, 'package.json'));
cpSync(join(root, 'packages/shared/dist'), join(shared, 'dist'), { recursive: true });
