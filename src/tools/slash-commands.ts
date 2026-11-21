export type SlashCommand = { name: string; description: string; type: "skill" | "command" };

// Scans skills (SKILL.md) and commands (*.md) from the user home and /workspace,
// extracts YAML frontmatter, and prints one record per file:
//   type US name US description RS   (US = \037, RS = \036)
// JSON is built in TypeScript (parseSlashCommands), never in shell.
// Notes: no `set -o pipefail` (bash-only); no `${...}` (String.raw template).
export const SLASH_COMMANDS_SCRIPT = String.raw`
for f in "$HOME/.claude/skills/"*/SKILL.md "$HOME/.claude/commands/"*.md /workspace/.claude/skills/*/SKILL.md /workspace/.claude/commands/*.md; do
  [ -f "$f" ] || continue
  case "$f" in
    */skills/*) type="skill" ;;
    *)          type="command" ;;
  esac
  name=$(awk '/^---/{if(found){exit}found=1;next} found && /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$f" | tr -d '\r\036\037')
  desc=$(awk '/^---/{if(found){exit}found=1;next} found && /^description:/{sub(/^description:[[:space:]]*/,""); print; exit}' "$f" | tr -d '\r\036\037')
  if [ -z "$name" ]; then
    name=$(basename "$f" .md | tr -d '\r\036\037')
  fi
  [ -n "$name" ] || continue
  printf '%s\037%s\037%s\036' "$type" "$name" "$desc"
done
`.trim();

export function parseSlashCommands(stdout: string): SlashCommand[] {
    const out: SlashCommand[] = [];
    if (typeof stdout !== "string") return out;
    for (const record of stdout.split("\x1e")) {
        const fields = record.split("\x1f");
        if (fields.length !== 3) continue;
        const type = fields[0].trim();
        const name = fields[1].trim();
        const description = fields[2].trim();
        if (!name || (type !== "skill" && type !== "command")) continue;
        out.push({ name, description, type });
    }
    return out;
}
