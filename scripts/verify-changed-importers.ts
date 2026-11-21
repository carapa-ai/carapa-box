// Lists the test files that directly import any of the given changed files
// (depth 1, relative specifiers only). A changed file that is not a TS/JS module
// (a shell script, config, data file) cannot be imported, so tests that reach it
// by path count too: any test source naming its repo-relative path, or its file
// name as a standalone token (`resolve(dir, "../build.sh")`, `join(stack, "build.sh")`).
// Used by scripts/verify-changed.sh.
//
// Usage: bun scripts/verify-changed-importers.ts <hub-limit> <changed-file>...
// Output, tab separated:
//   IMPORTER <changed-file> <test-file>
//   HUB      <changed-file> <importer-count>   (more than <hub-limit> importers; not expanded)
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmock\.module\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\1/g;
const MODULE_FILE = /\.(ts|tsx|mjs|js)$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json"];

const [hubLimitArg, ...changed] = process.argv.slice(2);
const hubLimit = Number(hubLimitArg);
if (!Number.isInteger(hubLimit) || hubLimit < 0) {
  console.error("usage: verify-changed-importers.ts <hub-limit> <changed-file>...");
  process.exit(2);
}

const changedSet = new Set(changed.map((path) => normalize(path)));

// A specifier may name the file itself, a `.js` alias of a `.ts` file, or a directory index.
function candidatePaths(base: string): string[] {
  const candidates = [base];
  const aliased = base.match(/^(.*)\.(?:js|jsx)$/);
  if (aliased) candidates.push(`${aliased[1]}.ts`, `${aliased[1]}.tsx`);
  for (const extension of EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of EXTENSIONS) candidates.push(join(base, `index${extension}`));
  return candidates.map((path) => normalize(path));
}

const listing = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"]);
if (listing.exitCode !== 0) {
  console.error(`git ls-files failed: ${listing.stderr.toString()}`);
  process.exit(1);
}
const testFiles = listing.stdout
  .toString()
  .split("\0")
  .filter((path) => TEST_FILE.test(path) && existsSync(path));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names `file` as a path: its repo-relative path, or its basename after a quote, slash or space.
function pathMention(file: string): RegExp {
  const name = escapeRegExp(basename(file));
  const relative = escapeRegExp(file);
  return new RegExp(`(?<![\\w.-])${relative}(?![\\w.-])|(?<=['"\`/\\s])${name}(?![\\w.-])`);
}
const pathMentions = [...changedSet]
  .filter((file) => !MODULE_FILE.test(file))
  .map((file) => ({ file, mention: pathMention(file) }));

const importersByChanged = new Map<string, Set<string>>();
for (const testFile of testFiles) {
  const source = readFileSync(testFile, "utf8");
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const base = join(dirname(testFile), match[2]);
    for (const candidate of candidatePaths(base)) {
      if (!changedSet.has(candidate)) continue;
      const importers = importersByChanged.get(candidate) ?? new Set<string>();
      importers.add(testFile);
      importersByChanged.set(candidate, importers);
    }
  }
  for (const { file, mention } of pathMentions) {
    if (!mention.test(source)) continue;
    const importers = importersByChanged.get(file) ?? new Set<string>();
    importers.add(testFile);
    importersByChanged.set(file, importers);
  }
}

for (const [changedFile, importers] of importersByChanged) {
  if (importers.size > hubLimit) {
    console.log(`HUB\t${changedFile}\t${importers.size}`);
    continue;
  }
  for (const testFile of [...importers].sort()) console.log(`IMPORTER\t${changedFile}\t${testFile}`);
}
