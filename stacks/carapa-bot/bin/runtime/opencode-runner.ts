#!/usr/bin/env bun
import { createRunContext } from './contracts';
import { openCodeRunCommand, runOpenCodeNative } from './opencode-v1';

const runDir = process.argv[2];
if (!runDir) throw new Error('usage: opencode-runner.ts <run-dir>');
const context = createRunContext(runDir, process.cwd());
process.exitCode = await runOpenCodeNative(context, openCodeRunCommand(context));
