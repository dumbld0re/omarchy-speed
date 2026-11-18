export const isTTY = !!process.stdout.isTTY;
const color = isTTY && !process.env.NO_COLOR;

// Uses the terminal's own palette (ANSI 36 = cyan by default), so it follows the active
// terminal theme. Override with FAST_ACCENT, e.g. FAST_ACCENT=35 or FAST_ACCENT="38;5;209".
const sgr = (code: string) => (s: string | number) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  dim: sgr("2"),
  bold: sgr("1"),
  accent: sgr(process.env.FAST_ACCENT || "36"),
  strong: sgr(`1;${process.env.FAST_ACCENT || "36"}`),
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - strip(s).length));
export const padL = (s: string, n: number) => " ".repeat(Math.max(0, n - strip(s).length)) + s;

/** "8.9" / "95" / "320" (like fast.com), switching to Gbps above 1000. */
export function speed(mbps: number): { value: string; unit: string } {
  if (mbps >= 1000) return { value: (mbps / 1000).toFixed(mbps >= 10000 ? 0 : 2), unit: "Gbps" };
  if (mbps >= 100) return { value: mbps.toFixed(0), unit: "Mbps" };
  if (mbps >= 10) return { value: mbps.toFixed(1), unit: "Mbps" };
  return { value: mbps.toFixed(mbps >= 1 ? 1 : 2), unit: "Mbps" };
}
export const speedStr = (mbps: number) => {
  const s = speed(mbps);
  return `${s.value} ${s.unit}`;
};

export function bytesStr(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} kB`;
}

// 3-row display numerals for the hero reading.
const GLYPHS: Record<string, [string, string, string]> = {
  "0": ["┏━┓", "┃ ┃", "┗━┛"],
  "1": ["╺┓ ", " ┃ ", "╺┻╸"],
  "2": ["┏━┓", "┏━┛", "┗━╸"],
  "3": ["┏━┓", " ━┫", "┗━┛"],
  "4": ["╻ ╻", "┗━┫", "  ╹"],
  "5": ["┏━╸", "┗━┓", "┗━┛"],
  "6": ["┏━╸", "┣━┓", "┗━┛"],
  "7": ["╺━┓", "  ┃", "  ╹"],
  "8": ["┏━┓", "┣━┫", "┗━┛"],
  "9": ["┏━┓", "┗━┫", "╺━┛"],
  ".": [" ", " ", "•"],
  "–": ["   ", "╺━╸", "   "],
};

export function bigText(s: string): [string, string, string] {
  const rows: [string[], string[], string[]] = [[], [], []];
  for (const ch of s) {
    const g = GLYPHS[ch] ?? ["   ", "   ", "   "];
    for (let r = 0; r < 3; r++) rows[r]!.push(g[r]!);
  }
  return rows.map((r) => r.join(" ")) as [string, string, string];
}

const BARS = "▁▂▃▄▅▆▇█";
/** Sparkline scaled 0..max, resampled to `width` columns. */
export function spark(xs: number[], width = 28, max?: number): string {
  if (!xs.length) return "";
  const cols: number[] = [];
  if (xs.length <= width) cols.push(...xs);
  else {
    for (let i = 0; i < width; i++) {
      const a = Math.floor((i * xs.length) / width);
      const b = Math.max(a + 1, Math.floor(((i + 1) * xs.length) / width));
      const slice = xs.slice(a, b);
      cols.push(slice.reduce((x, y) => x + y, 0) / slice.length);
    }
  }
  const top = max ?? Math.max(...cols);
  return cols.map((v) => BARS[top > 0 ? Math.min(7, Math.round((v / top) * 7)) : 0]).join("");
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const spinner = (frame: number) => SPIN[frame % SPIN.length]!;

/** Clips a line to `width` visible columns, keeping ANSI codes intact. */
export function fit(line: string, width: number): string {
  let out = "";
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const esc = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (visible >= width) {
      out += "\x1b[0m";
      break;
    }
    out += ch;
    visible++;
    i += ch.length;
  }
  return out;
}

/**
 * Redraws a block of lines in place. Every line is clipped to the terminal width
 * and autowrap is off while it's live: a wrapped line takes two rows, so moving the
 * cursor back up by the line count would fall short and the block would creep down.
 */
export class LiveBlock {
  private lines = 0;
  start() {
    process.stdout.write("\x1b[?25l\x1b[?7l");
  }
  draw(lines: string[], clip = true) {
    const width = Math.max(10, (process.stdout.columns || 80) - 1);
    let out = this.lines ? `\x1b[${this.lines}A` : "";
    for (const l of lines) out += `\x1b[2K${clip ? fit(l, width) : l}\n`;
    // clear any leftover lines if the block shrank
    for (let i = lines.length; i < this.lines; i++) out += "\x1b[2K\n";
    if (this.lines > lines.length) out += `\x1b[${this.lines - lines.length}A`;
    this.lines = lines.length;
    process.stdout.write(out);
  }
  stop() {
    process.stdout.write("\x1b[?25h\x1b[?7h");
  }
  /** Last frame: nothing redraws after it, so it can wrap and show everything. */
  finish(lines: string[]) {
    this.stop();
    this.draw(lines, false);
  }
}

export function restoreCursor() {
  if (isTTY) process.stdout.write("\x1b[?25h\x1b[?7h");
}
