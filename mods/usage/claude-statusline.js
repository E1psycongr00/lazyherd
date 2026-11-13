// Claude Code status line: model, folder, project, output style.
// Also saves the subscription usage (rate_limits) to ~/.claude/usage-limits.json
// so other tools (the Herdr tab bar) can show it.
const fs = require("fs"), path = require("path"), os = require("os");

let input = "";
process.stdin.on("data", d => (input += d)).on("end", () => {
  let j = {};
  try { j = JSON.parse(input); } catch {}

  const rl = j.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    const file = path.join(os.homedir(), ".claude", "usage-limits.json");
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...rl, updated_at: Math.floor(Date.now() / 1000) }));
      fs.renameSync(tmp, file);
    } catch { try { fs.unlinkSync(tmp); } catch {} }
  }

  const base = p => (p || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const model = j.model?.display_name ?? "";
  const cur = base(j.workspace?.current_dir), proj = base(j.workspace?.project_dir);
  const style = j.output_style?.name ?? "";
  process.stdout.write(`\x1b[2m${model}\x1b[0m \x1b[36m${cur}\x1b[0m \x1b[32m[${proj}]\x1b[0m \x1b[33m(${style})\x1b[0m`);
});
