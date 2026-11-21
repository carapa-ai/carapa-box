#!/usr/bin/env bun
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRunContext } from './contracts';
import { runAgySdkNative } from './agy-sdk-v1';

const runDir = process.argv[2];
if (!runDir) throw new Error('usage: agy-sdk-runner.ts <run-dir>');
const context = createRunContext(runDir, process.cwd(), process.cwd());
// The runner's cwd is the project workspace, not the installed harness bin
// directory. Resolve the Python shim from this file so it works in every
// mounted project workspace.
const sdkPath = join(import.meta.dir, '..', 'agy-sdk.py');
// Do not inherit PRIME_AGENT_KERNEL_PYTHON here: that variable may be pointed
// at the generic kernel interpreter, while google-antigravity is installed in
// the harness virtualenv.
// Existing sandboxes keep their image-owned interpreter until recreated with
// the shared volume. CUDA's separate test venv must not serve harness SDKs.
const sharedPython = '/opt/carapa-harness/python-env/bin/python';
const python = process.env.CARAPA_AGY_PYTHON || (existsSync(sharedPython) ? sharedPython : '/opt/carapa-harness/venv/bin/python');
const command = [python, sdkPath, '--warm', '--work-dir', context.cwd];
if (context.args.sessionId) command.push('--session-id', context.args.sessionId);
if (context.args.systemPrompt) command.push('--system', context.args.systemPrompt);
if (context.args.model) command.push('--model', context.args.model);
process.exitCode = await runAgySdkNative(context, command);
