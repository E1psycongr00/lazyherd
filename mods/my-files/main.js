// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, notify } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Every file under root, relative paths with "/". Git repos list tracked + untracked
// files minus ignored ones; elsewhere a walk that skips .git and node_modules.
const INDEX_MAX = 50000, RESULTS = 200;
async function allFiles(root, on) {
  const git = await exec("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on }).catch(() => null);
  if (git?.code === 0) return [...new Set(git.stdout.split("\0").filter(Boolean))].slice(0, INDEX_MAX);
  if (!on && window()?.platform === "windows") {
    const ps = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $root = (Get-Item -LiteralPath $p -Force).FullName.TrimEnd('\\'); $stack = [System.Collections.Generic.Stack[string]]::new(); $stack.Push($root); $n = 0; while ($stack.Count -and $n -lt " + INDEX_MAX + ") { $d = $stack.Pop(); foreach ($e in @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) { if ($e.PSIsContainer) { if ($e.Name -ne '.git' -and $e.Name -ne 'node_modules' -and -not $e.LinkType) { $stack.Push($e.FullName) } } else { $e.FullName.Substring($root.Length + 1).Replace('\\', '/'); $n++ } } } } '" + root.replace(/['‘’‚‛]/g, "$&$&") + "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", ps], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot search this folder");
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }
  const r = await exec("sh", ["-c", 'cd "$1" && find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print | head -n ' + INDEX_MAX, "files", root], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot search this folder");
  return r.stdout.split("\n").filter(Boolean).map(p => p.replace(/^\.\//, ""));
}

// Space-separated words, all must appear (any case). Name matches rank first.
function search(files, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    if (!words.every(w => lower.includes(w))) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = (name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2) * 10000 + path.length;
    hits.push({ path, score });
  }
  return hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, RESULTS).map(h => ({ path: h.path }));
}

// "#text" searches file contents with ripgrep: literal text, case-insensitive unless
// it has capitals, hidden files included, .gitignore respected, binaries skipped.
const RG_MISSING = "내용 검색에는 rg(ripgrep)가 필요합니다 · Windows: winget install BurntSushi.ripgrep.MSVC · Mac: brew install ripgrep · Linux: apt install ripgrep";
async function grep(root, on, pattern) {
  let r;
  try {
    r = await exec("rg", ["--line-number", "--no-heading", "--color", "never", "--smart-case", "--fixed-strings", "--hidden", "--glob", "!.git",
      "--null", "--path-separator", "/", "--max-columns", "300", "--max-columns-preview", "--max-count", "10", "--max-filesize", "1M", "--", pattern, "."], { cwd: root, on });
  } catch (e) {
    if (/program not found|cannot start rg/i.test(String(e))) throw new Error(RG_MISSING);
    throw e;
  }
  if (r.code === 1) return { hits: [], more: false };
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr || "rg failed");
  const hits = [];
  for (const row of r.stdout.split("\n")) {
    const cut = row.indexOf("\0");
    if (cut < 0) continue;
    const m = /^(\d+):(.*)$/s.exec(row.slice(cut + 1).replace(/\r$/, ""));
    if (!m) continue;
    if (hits.length >= RESULTS) return { hits, more: true };
    hits.push({ path: row.slice(0, cut).replace(/^\.\//, ""), line: Number(m[1]), text: m[2].trim() });
  }
  return { hits, more: false };
}

export default class Files extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0; this.index = null; this.indexing = false; this.indexError = null;
    this.grep = null; this.grepSeq = 0;
    this.input = InputState.new({ placeholder: "파일 이름 · #내용" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value(); this.at = 0;
      if (this.contentQuery() !== null) this.scheduleGrep(cx);
      else if (this.query.trim()) this.buildIndex(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => { const hit = this.results()[this.at]; if (hit) this.open(hit, cx); cx.notify(); });
    this.scroll = ScrollHandle.new();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  // Lazily lists the whole folder once a search starts; kept until the folder changes.
  buildIndex(cx, force) {
    if (!this.root || this.indexing || (this.index && !force)) return;
    const context = this.context, root = this.root, on = this.on;
    this.indexing = true;
    cx.spawn(async cx => {
      try { const files = await allFiles(root, on); if (this.current(context)) { this.index = files; this.indexError = null; } }
      catch (e) { if (this.current(context)) this.indexError = String(e); }
      finally { if (this.context === context) this.indexing = false; cx.notify(); }
    });
  }

  // The text after a leading "#", or null when searching names.
  contentQuery() {
    const q = this.query.trimStart();
    return q.startsWith("#") ? q.slice(1).trim() : null;
  }

  // Waits for typing to pause, then runs rg once; only the latest run is shown.
  scheduleGrep(cx) {
    this.grepTimer?.cancel(); this.grepTimer = null;
    const pattern = this.contentQuery();
    if (!pattern) { this.grepSeq++; this.grep = null; return; }
    if (this.grep?.pattern === pattern && this.grep.context === this.context) return;
    this.grepTimer = cx.timer.after(300, cx => this.runGrep(cx));
  }

  runGrep(cx) {
    const pattern = this.contentQuery(), context = this.context, root = this.root, on = this.on;
    if (!pattern || !root) return;
    const seq = ++this.grepSeq;
    // Old matches stay on screen until the new ones arrive.
    this.grep = { ...(this.grep?.context === context ? this.grep : { hits: [] }), pattern, context, running: true, error: null };
    cx.notify();
    cx.spawn(async cx => {
      try { const r = await grep(root, on, pattern); if (seq === this.grepSeq && this.current(context)) this.grep = { pattern, context, ...r }; }
      catch (e) { if (seq === this.grepSeq && this.current(context)) this.grep = { pattern, context, hits: [], error: e?.message ?? String(e) }; }
      finally { cx.notify(); }
    });
  }

  results() {
    if (this.contentQuery() !== null) return this.grep?.context === this.context ? this.grep.hits : [];
    if (this.index !== this.cache?.index || this.query !== this.cache?.query)
      this.cache = { index: this.index, query: this.query, hits: search(this.index ?? [], this.query) };
    return this.cache.hits;
  }

  open(hit, cx) {
    this.show(hit.path, cx);
    this.fileLine = hit.line ?? null;
  }

  clearSearch(cx) {
    this.input.set_value("");
    this.query = ""; this.at = 0; this.grepTimer?.cancel(); this.grepTimer = null; this.grepSeq++; this.grep = null;
    cx.notify();
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.index = null; this.indexError = null; this.indexing = false; this.at = 0;
      if (saved?.file) this.show(saved.file, cx);
      this.grepTimer?.cancel(); this.grepTimer = null; this.grepSeq++; this.grep = null;
      if (cx && this.contentQuery() !== null) this.scheduleGrep(cx);
      else if (cx && this.query.trim()) this.buildIndex(cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        // Files came or went: re-list for an open search, otherwise list again on the next one.
        if (this.query.trim()) this.buildIndex(cx, true); else this.index = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.fileLine = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Right-click: copy the full path, usable from any terminal folder and by agents.
  // Local Windows paths use backslashes; paths with spaces are quoted for the shell.
  copyPath(path, cx) {
    if (!this.root) return;
    const windows = !this.on && window()?.platform === "windows";
    let full = path ? `${this.root.replace(/[\\/]+$/, "")}/${path}` : this.root;
    if (windows) full = full.replace(/\//g, "\\");
    const text = /\s/.test(full) ? `"${full}"` : full;
    cx.write_to_clipboard(text);
    notify({ title: "경로 복사됨", body: text, level: "success", timeout: 2500 });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.copyPath(path, cx); })
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  hits(t) {
    const hits = this.results();
    if (this.at >= hits.length) this.at = Math.max(0, hits.length - 1);
    const content = this.contentQuery() !== null;
    const rows = hits.map((hit, i) => {
      const { path, line, text } = hit;
      const cut = path.lastIndexOf("/"), name = path.slice(cut + 1), dir = cut >= 0 ? path.slice(0, cut) : "", mark = this.marks[`${this.root}/${path}`];
      const head = h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w_full().truncate().child(line ? `${name}:${line}` : name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir));
      return h_flex().id(`hit-${path}:${line ?? ""}`).h(content ? 44 : 30).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.open(hit, cx); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.copyPath(path, cx); })
        .child(svg("mods/my-files/file.svg").size(14).flex_none().text_color(t.muted))
        .child(content
          ? v_flex().flex_1().min_w(0).gap(1).child(head)
            .child(div().w_full().truncate().text_size(11.5).font_family(settings().font_family).text_color(t.muted).child(text || " "))
          : div().flex_1().min_w(0).child(head))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
    const g = this.grep?.context === this.context ? this.grep : null;
    const note = content
      ? (!this.contentQuery() ? "# 뒤에 찾을 내용을 입력하세요" : g?.error || (!g || (g.running && !hits.length) ? "Searching…" : !hits.length ? "No matches"
        : g.more ? `Showing the first ${RESULTS} matches` : null))
      : this.indexError || (!this.index ? "Searching…" : !hits.length ? "No matching files"
        : hits.length >= RESULTS ? `Showing the first ${RESULTS} matches` : this.index.length >= INDEX_MAX ? `Searched the first ${INDEX_MAX.toLocaleString()} files` : null);
    return v_flex().id("files-hits").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(6).children(rows)
      .when(Boolean(note), el => el.child(div().p(8).text_size(11).text_color(t.dim).child(note)));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), searching = !this.file && Boolean(this.query.trim());
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().id("files-where").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.copyPath(this.file, cx); })
          .child(this.file ? (this.fileLine ? `${this.file}:${this.fileLine}` : this.file) : this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(h_flex().h(30).flex_none().mx(8).mt(8).mb(2).px(8).gap(6).items_center().rounded(7).border_1().border_color(searching ? t.accent : t.input).bg(t.background)
          .on_key_down((e, cx) => {
            const n = this.results().length;
            if (e.key === "escape" && this.query) this.clearSearch(cx);
            else if (e.key === "down" && n) this.at = (this.at + 1) % n;
            else if (e.key === "up" && n) this.at = (this.at + n - 1) % n;
            else return;
            if (n) this.scroll.scroll_to_item(this.at);
            cx.stop_propagation(); cx.notify();
          })
          .child(svg("mods/my-files/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
          .when(Boolean(this.query), el => el.child(div().id("files-clear").px(4).cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click((_e, cx) => this.clearSearch(cx)).child("×")))))
      .when(searching, el => el.child(this.hits(t)))
      .when(!this.file && !searching, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
