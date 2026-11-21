'use strict';

// The daemon owns tab selection. Dashboard viewers mirror it; they never keep
// an independent selection. State is private to the existing browser context.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { realCli } = require('./browser-session.cjs');
const { containerSessionDir } = require('./browser-host.cjs');
const exec = promisify(execFile);

function stateFile(env) {
  return path.join(env.PLAYWRIGHT_DAEMON_SESSION_DIR, 'selected-tab.json');
}
function readSelection(env) {
  try { return JSON.parse(fs.readFileSync(stateFile(env), 'utf8')); }
  catch { return undefined; }
}
async function command(env, cwd, ...args) {
  const { stdout } = await exec(process.execPath, [realCli(), ...args], {
    env, cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (stdout.includes('### Error')) throw new Error('Browser tab command failed');
  return stdout;
}
function publishContext(context, current) {
  const data = JSON.stringify({ page: current?.page?._guid || null,
    pages: context._tabs.map(tab => tab.page._guid) });
  if (data === context.__carapaPublishedSelection) return;
  const file = stateFile(process.env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, file);
  context.__carapaPublishedSelection = data;
}
function patchTabSelection(source) {
  const env = process.env;
  if (!env.CARAPA_BROWSER_SESSION_ID && !env.CARAPA_BROWSER_RUN_ID) return source;
  if (!containerSessionDir(env.PLAYWRIGHT_DAEMON_SESSION_DIR))
    throw new Error('Invalid browser tab state directory');
  // Pinned Playwright bundles Context without class fields. Observe its actual
  // selection, including popup/close events, without executing browser tools.
  const marker = '    Context = class {\n      constructor(browserContext, options) {';
  if (source.split(marker).length !== 2)
    throw new Error('Unsupported Playwright tab selection implementation');
  const publish = `require(${JSON.stringify(__filename)}).publishContext(this, this.__carapaCurrentTab)`;
  return source.replace(marker, `    Context = class {
      get _currentTab() { ${publish}; return this.__carapaCurrentTab; }
      set _currentTab(tab) { this.__carapaCurrentTab = tab; ${publish}; }
      constructor(browserContext, options) {`);
}
module.exports = { command, readSelection, publishContext, patchTabSelection };
