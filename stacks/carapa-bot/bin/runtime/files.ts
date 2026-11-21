import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}

export function writeRunFile(runDir: string, name: string, value: string): void {
  writeFileSync(join(runDir, name), value);
}
