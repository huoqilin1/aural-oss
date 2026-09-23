import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredServices = ['official', 'hr', 'aural', 'voice', 'hrCallback', 'modelControl', 'hrDatabase', 'auralDatabase', 'storage', 'queue', 'mail'];
const protocols = new Set(['http:', 'https:', 'ws:', 'wss:', 'postgres:', 'postgresql:', 'redis:', 'rediss:']);
function resolvedExistingParent(path) {
  let parent = path;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error('No existing parent');
    parent = next;
  }
  return resolve(realpathSync(parent), relative(parent, path));
}
function within(root, path) {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
/** Configuration validation only: this does not enforce network isolation or prove E2E success. */
export function checkLocalIsolation(config, repositoryRoot) {
  const errors = [];
  if (config?.mode !== 'mock') errors.push('MODE_NOT_OFFLINE: real-provider mode requires a separately verified isolation profile');
  if (config?.loadDotenv !== false) errors.push('DOTENV_NOT_DISABLED');
  if (config?.notifications !== 'local-sink') errors.push('NOTIFICATIONS_NOT_LOCAL');
  for (const name of requiredServices) {
    try {
      const url = new URL(config?.services?.[name]);
      // Literal loopback only: no DNS aliases, production defaults, credentials or redirect destinations.
      if (!protocols.has(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) throw new Error('not local');
    } catch { errors.push(`SERVICE_NOT_EXPLICIT_LOOPBACK:${name}`); }
  }
  for (const name of Object.keys(config?.services ?? {})) {
    if (!requiredServices.includes(name)) errors.push(`UNREVIEWED_SERVICE:${name}`);
  }
  try {
    if (typeof config?.dataRoot !== 'string' || !isAbsolute(config.dataRoot)) throw new Error('absolute root required');
    const allowed = resolve(realpathSync(repositoryRoot), 'output/local-sandbox');
    if (!within(allowed, resolvedExistingParent(config.dataRoot))) throw new Error('outside dedicated root');
  } catch { errors.push('DATA_ROOT_NOT_ISOLATED'); }
  return { configurationCheckPassed: errors.length === 0, fullLocalAcceptancePassed: false, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkLocalIsolation(JSON.parse(readFileSync(process.argv[2], 'utf8')), resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(JSON.stringify(result));
    process.exitCode = result.configurationCheckPassed ? 0 : 1;
  } catch {
    console.error('LOCAL_CONFIGURATION_MISSING_OR_INVALID');
    process.exitCode = 1;
  }
}
