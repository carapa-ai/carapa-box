#!/usr/bin/env bun
// Host/operator CLI for the same controller used by Board's admin API.
// Native tokens and callback codes are never accepted as command arguments.
import { configuredProviderAccounts } from '../src/provider-accounts.js';
const [operation, argument] = process.argv.slice(2);
try {
  const accounts = configuredProviderAccounts();
  const result = operation === 'list' ? await accounts.list()
    : operation === 'start' ? await accounts.start(JSON.parse(argument || '{}'))
    : operation === 'cancel' ? await accounts.cancel(argument)
    : operation === 'complete' ? await accounts.complete(argument, (await Bun.stdin.text()).trim())
    : (() => { throw new Error('Unknown operation'); })();
  console.log(JSON.stringify(result));
} catch {
  console.error('Provider account operation failed; check configuration and login state.');
  process.exitCode = 1;
}
