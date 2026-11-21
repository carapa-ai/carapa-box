// Encryption at rest for the provider-account store (PROVIDER_ACCOUNTS_DIR).
//
// Opt-in: with CARAPA_CREDENTIALS_KEY_FILE set (a 32-byte key, base64), every
// secret file written below the store root is sealed with AES-256-GCM. The
// file's path relative to the root is the additional authenticated data, so a
// sealed file cannot be swapped for another account's. Unsealed files are
// still read, which lets an existing store migrate (sealPlaintextCredentials).
// Files outside the root, such as credentialFile paths named by relay-client
// configs that other tools may read, are never sealed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MARK = 'carapaSealed';
let configured = { key: null, root: null };

/** Reads the key named by CARAPA_CREDENTIALS_KEY_FILE; fails closed when it is named but unusable. */
export function configureCredentialSealing(env, root) {
  const file = env.CARAPA_CREDENTIALS_KEY_FILE;
  if (!file || !root) { configured = { key: null, root: null }; return false; }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('CARAPA_CREDENTIALS_KEY_FILE must hold a base64 32-byte key');
  configured = { key, root: path.resolve(root) };
  return true;
}

export const credentialSealingEnabled = () => configured.key !== null;

/** The sealed name of a file inside the root, or null when it is outside (never sealed). */
function sealedName(file) {
  if (!configured.root) return null;
  const relative = path.relative(configured.root, path.resolve(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null;
}

export const isSealed = value => !!value && typeof value === 'object' && value[MARK] === 1;

/** The text to write for a secret JSON value at `file`: sealed when a key is configured and the file is in the store. */
export function credentialText(file, value) {
  const name = sealedName(file);
  if (!configured.key || !name) return JSON.stringify(value, null, 2);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', configured.key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ [MARK]: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

/** Parses a secret JSON file's text, opening it when sealed. */
export function parseCredentialText(file, text) {
  const parsed = JSON.parse(text);
  if (!isSealed(parsed)) return parsed;
  const name = sealedName(file);
  if (!configured.key || !name) throw new Error('Sealed credential cannot be opened: no credential key configured');
  const decipher = crypto.createDecipheriv('aes-256-gcm', configured.key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8'));
}

export const readCredentialFile = file => parseCredentialText(file, fs.readFileSync(file, 'utf8'));

/** Writes a secret JSON value atomically (temporary file, fsync, rename), mode 0600. */
export function writeCredentialFile(file, value) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, credentialText(file, value));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Seals every unsealed JSON file in the store's secret directories. The relay
 * runs it at start, before it refreshes anything, so no writer races it.
 * Returns the number of files sealed.
 */
export function sealPlaintextCredentials(root, directories = ['credentials', 'mcp/credentials']) {
  if (!configured.key) return 0;
  let sealed = 0;
  for (const directory of directories) {
    const dir = path.join(root, directory);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      if (!name.endsWith('.json') || !fs.lstatSync(file).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isSealed(parsed)) continue;
      writeCredentialFile(file, parsed);
      sealed++;
    }
  }
  return sealed;
}
