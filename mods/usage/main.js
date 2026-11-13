// Claude and Codex subscription usage (5-hour and weekly windows) for the status bar.
// Claude's comes from ~/.claude/usage-limits.json, written by the Claude Code status line
// (~/.claude/statusline.js). Codex's comes from its newest session log (codex-usage.ps1).
// A window whose reset time has passed counts as 0%. Hovering a group shows a card
// with each window's usage and when it resets.
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { exec, readTextFile, home, appHome, theme } from "herdr";

const EVERY = 60000;
const DAYS = "일월화수목금토";
const pad = n => String(n).padStart(2, "0");

// "38분 후", "2시간 13분 후", "6일 후" (the date beside it says when)
function until(s, now) {
  const mins = Math.ceil((s - now) / 60);
  if (mins < 60) return `${mins}분 후`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m ? `${h}시간 ${m}분 후` : `${h}시간 후`;
  return `${Math.floor(h / 24)}일 후`;
}
// "14:30" today, else "11/17(월) 09:00"
function at(s) {
  const d = new Date(s * 1000), today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${time}`;
}
function ago(s, now) {
  const m = Math.round((now - s) / 60);
  return m < 1 ? "방금 갱신" : m < 60 ? `${m}분 전 갱신` : m < 1440 ? `${Math.round(m / 60)}시간 전 갱신` : `${Math.round(m / 1440)}일 전 갱신`;
}

export default class Usage extends View {
  init(_props, cx) {
    this.claude = null; this.codex = null;
    this.load(cx);
    cx.timer.every(EVERY, cx => this.load(cx));
  }

  load(cx) {
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${home()}/.claude/usage-limits.json`);
        const j = text ? JSON.parse(text) : null;
        this.claude = j && {
          windows: [["5h", "5시간", j.five_hour?.used_percentage, j.five_hour?.resets_at], ["주", "주간", j.seven_day?.used_percentage, j.seven_day?.resets_at]],
          updated: j.updated_at,
        };
      } catch { this.claude = null; }
      try {
        const r = await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/usage/codex-usage.ps1`]);
        const j = r.code === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : null;
        this.codex = j && {
          windows: [["5h", "5시간", j.primary?.used_percent, j.primary?.resets_at], ["주", "주간", j.secondary?.used_percent, j.secondary?.resets_at]],
          updated: j.updated_at,
          // Shown only when there is a balance (or unlimited credits).
          credits: j.credits?.unlimited ? { unlimited: true }
            : j.credits?.has_credits && Number(j.credits.balance) > 0 ? { balance: Number(j.credits.balance) } : null,
        };
      } catch { this.codex = null; }
      cx.notify();
    });
  }

  render() {
    const t = theme(), now = Date.now() / 1000;
    const tone = p => p >= 85 ? t.ansi1 : p >= 60 ? t.ansi3 : t.ansi2;
    const bar = (w, h, pct) => div().w(w).h(h).flex_none().rounded(h / 2).bg(t.border).overflow_hidden()
      .child(div().h_full().w(Math.max(pct ? 2 : 0, w * pct / 100)).rounded(h / 2).bg(tone(pct)));

    // The hover card: one line per window, "5시간  [bar]  7%" with the reset time below it.
    const card = (name, icon, u, shown) => v_flex().w(280).p(12).gap(10).rounded(10).bg(t.surface).border_1().border_color(t.border).shadow_md()
      .text_color(t.foreground)
      .child(h_flex().gap(7).items_center()
        .child(image(icon).size(16).flex_none())
        .child(div().flex_1().text_size(13.5).font_semibold().child(name))
        .when(Boolean(u.updated), el => el.child(div().text_size(11.5).text_color(t.dim).child(ago(u.updated, now)))))
      .children(shown.map(w => v_flex().gap(4)
        .child(h_flex().gap(8).items_center()
          .child(div().w(36).flex_none().text_size(12.5).text_color(t.muted).child(w.long))
          .child(bar(170, 7, w.pct))
          .child(div().flex_1().text_right().text_size(13).font_semibold().text_color(tone(w.pct)).child(`${w.pct}%`)))
        .child(div().pl(44).text_size(12).text_color(t.dim).child(
          !w.reset ? "초기화 시각 모름" : w.reset <= now ? "초기화됨" : `초기화 ${until(w.reset, now)} · ${at(w.reset)}`))))
      .when(Boolean(u.credits), el => el.child(h_flex().pt(9).border_t(1).border_color(t.border).items_center().justify_between()
        .child(div().text_size(12.5).text_color(t.muted).child("크레딧"))
        .child(div().text_size(13).font_semibold().text_color(t.foreground)
          .child(u.credits.unlimited ? "무제한" : `${String(Math.floor(u.credits.balance)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} 남음`))));

    const group = (id, name, icon, u) => {
      const shown = (u?.windows ?? []).filter(([, , p]) => typeof p === "number")
        .map(([label, long, p, reset]) => ({ label, long, reset, pct: reset && reset <= now ? 0 : Math.max(0, Math.min(100, Math.round(p))) }));
      if (!shown.length) return null;
      const trigger = h_flex().id(`usage-${id}`).h(22).px(6).gap(6).flex_none().items_center().rounded(5).hover(s => s.bg(t.hover))
        .child(image(icon).size(12).flex_none())
        .children(shown.map(w => h_flex().gap(4).items_center()
          .child(div().text_size(10.5).text_color(t.dim).child(w.label))
          .child(bar(30, 5, w.pct))
          .child(div().w(28).text_size(11).text_color(t.muted).child(`${w.pct}%`))));
      return HoverCard.new(`usage-card-${id}`).anchor("bottom_left").open_delay(250).close_delay(150)
        .trigger(trigger).content(card(name, icon, u, shown));
    };

    return h_flex().size_full().pl(8).gap(2).items_center().overflow_hidden().bg(t.chrome).border_t(1).border_color(t.border)
      .children([group("claude", "Claude", "icons/claude.svg", this.claude), group("codex", "Codex", "icons/codex.svg", this.codex)].filter(Boolean));
  }
}
