// A minimal syntax validator for the three Mermaid diagram types the retro emits: gantt,
// xychart-beta, and pie. It is deliberately stricter than Mermaid (for example a gantt task must sit
// under a section, and chart values must fit the y-axis) and does not try to cover the rest of
// the language. Returns a list of errors; empty means valid.

export type MermaidBlock = { line: number; source: string };

/** Every ```mermaid fence in a Markdown document, with the 1-based line of its opening fence. */
export function mermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== "```mermaid") continue;
    const body: string[] = [];
    let j = i + 1;
    for (j = i + 1; j < lines.length && lines[j]?.trim() !== "```"; j += 1)
      body.push(lines[j] ?? "");
    blocks.push({ line: i + 1, source: body.join("\n") });
    i = j;
  }
  return blocks;
}

const statements = (source: string) =>
  source
    .split("\n")
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter((s) => s.text !== "" && !s.text.startsWith("%%"));

export function validateMermaid(source: string): string[] {
  if (/\{\{|\}\}/.test(source)) return ["leftover template tag"];
  const [head, ...rest] = statements(source);
  if (head === undefined) return ["empty diagram"];
  if (head.text === "gantt") return validateGantt(rest);
  if (/^xychart-beta(\s+(horizontal|vertical))?$/.test(head.text)) return validateXychart(rest);
  const pie = /^pie(\s+showData)?(\s+title\s+(.+))?$/.exec(head.text);
  if (pie !== null) return validatePie(rest);
  return [`line ${head.line}: unknown diagram type "${head.text}"`];
}

type Statement = { text: string; line: number };

// Gantt

const DATE_FORMATS: Record<string, RegExp> = {
  "YYYY-MM-DDTHH:mm": /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
  "YYYY-MM-DD": /^(\d{4})-(\d{2})-(\d{2})$/,
};
const DURATION = /^\d+(ms|s|m|h|d|w)$/;
const TAGS = new Set(["done", "active", "crit", "milestone"]);

function parseDate(value: string, format: RegExp): number | null {
  const m = format.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h = "00", mi = "00"] = m;
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const back = new Date(time);
  if (back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return null;
  if (Number(h) > 23 || Number(mi) > 59) return null;
  return time;
}

function validateGantt(lines: Statement[]): string[] {
  const errors: string[] = [];
  let format: RegExp | null = null;
  let inSection = false;
  for (const { text, line } of lines) {
    const at = `line ${line}`;
    if (/^(title|axisFormat|tickInterval|todayMarker|excludes|weekday)\s/.test(text)) continue;
    const dateFormat = /^dateFormat\s+(.+)$/.exec(text);
    if (dateFormat !== null) {
      format = DATE_FORMATS[dateFormat[1] ?? ""] ?? null;
      if (format === null) errors.push(`${at}: unsupported dateFormat "${dateFormat[1]}"`);
      continue;
    }
    if (/^section\s+\S/.test(text)) {
      inSection = true;
      continue;
    }
    const task = /^([^:#;]+?)\s*:\s*(.+)$/.exec(text);
    if (task === null) {
      errors.push(`${at}: not a gantt statement or task: "${text}"`);
      continue;
    }
    if (!inSection) errors.push(`${at}: task before any section`);
    if (format === null) {
      errors.push(`${at}: task before a supported dateFormat`);
      continue;
    }
    const parts = (task[2] ?? "").split(",").map((p) => p.trim());
    while (parts.length > 0 && TAGS.has(parts[0] ?? "")) parts.shift();
    if (parts.length === 3 && /^[A-Za-z][\w-]*$/.test(parts[0] ?? "")) parts.shift();
    if (parts.length !== 2) {
      errors.push(`${at}: task metadata must be [tags,] start, end: "${task[2]}"`);
      continue;
    }
    const [startText = "", endText = ""] = parts;
    const start = parseDate(startText, format);
    if (start === null) {
      errors.push(`${at}: start date "${startText}" does not match dateFormat`);
      continue;
    }
    if (DURATION.test(endText)) continue;
    const end = parseDate(endText, format);
    if (end === null) errors.push(`${at}: end date "${endText}" does not match dateFormat`);
    else if (end < start) errors.push(`${at}: task ends before it starts`);
  }
  if (format === null && errors.length === 0) errors.push("gantt has no dateFormat");
  return errors;
}

// xychart-beta

function splitList(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      items.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "" || items.length > 0) items.push(current.trim());
  return items;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

function validateXychart(lines: Statement[]): string[] {
  const errors: string[] = [];
  let labels: string[] | null = null;
  let range: [number, number] | null = null;
  const series: { values: number[]; line: number }[] = [];
  for (const { text, line } of lines) {
    const at = `line ${line}`;
    if (/^title\s+"[^"]*"$/.test(text)) continue;
    const xAxis = /^x-axis(?:\s+"[^"]*")?\s+\[(.*)\]$/.exec(text);
    if (xAxis !== null) {
      labels = splitList(xAxis[1] ?? "");
      for (const label of labels) {
        if (!/^"[^"]*"$/.test(label) && !/^[\w.+-]+$/.test(label)) {
          errors.push(`${at}: invalid x-axis label ${label}`);
        }
      }
      continue;
    }
    const yAxis = /^y-axis(?:\s+"[^"]*")?\s+(\S+)\s+-->\s+(\S+)$/.exec(text);
    if (yAxis !== null) {
      const [min, max] = [yAxis[1] ?? "", yAxis[2] ?? ""];
      if (!NUMBER.test(min) || !NUMBER.test(max) || Number(max) <= Number(min)) {
        errors.push(`${at}: y-axis range must be two numbers, min below max: ${min} --> ${max}`);
      } else range = [Number(min), Number(max)];
      continue;
    }
    const data = /^(line|bar)\s+\[(.*)\]$/.exec(text);
    if (data !== null) {
      const items = splitList(data[2] ?? "");
      const bad = items.filter((v) => !NUMBER.test(v));
      if (bad.length > 0) errors.push(`${at}: ${data[1]} value is not a number: ${bad.join(", ")}`);
      else series.push({ values: items.map(Number), line });
      continue;
    }
    errors.push(`${at}: not an xychart statement: "${text}"`);
  }
  if (labels === null) errors.push("xychart has no x-axis");
  if (series.length === 0) errors.push("xychart has no line or bar");
  for (const s of series) {
    if (labels !== null && s.values.length !== labels.length) {
      errors.push(
        `line ${s.line}: series has ${s.values.length} values for ${labels.length} x-axis labels`,
      );
    }
    if (range !== null && s.values.some((v) => v > range[1] || v < range[0])) {
      errors.push(`line ${s.line}: a value is above the y-axis max or below its min`);
    }
  }
  return errors;
}

// pie

function validatePie(lines: Statement[]): string[] {
  const errors: string[] = [];
  for (const { text, line } of lines) {
    const at = `line ${line}`;
    if (/^title\s+\S/.test(text)) continue;
    const slice = /^"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(text);
    if (slice === null) errors.push(`${at}: invalid slice "${text}"`);
    else if (Number(slice[2]) < 0) errors.push(`${at}: slice "${slice[1]}" is negative`);
  }
  return errors;
}
