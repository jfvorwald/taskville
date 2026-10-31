// A minimal Mustache subset for docs/retros/TEMPLATE.md: `{{name}}`, `{{.}}`, and sections
// `{{#name}}...{{/name}}` over arrays, objects, and booleans. A line holding only a section tag is
// removed with its newline, as in Mustache. No HTML escaping: the output is Markdown. Unlike
// Mustache, an undefined name throws, so a typo can never render as a blank.

export type View = { [key: string]: unknown };

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string }
  | { kind: "section"; name: string; children: Node[] };

const TAG = /\{\{\s*([#/]?)\s*([\w.]+)\s*\}\}/g;
const STANDALONE = /^[ \t]*(\{\{\s*[#/]\s*[\w.]+\s*\}\})[ \t]*(?:\r?\n|$)/gm;

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [{ name: "", children: root }];
  let last = 0;
  for (const match of template.matchAll(TAG)) {
    const top = stack.at(-1);
    if (top === undefined) throw new Error("Template parse error");
    if (match.index > last)
      top.children.push({ kind: "text", text: template.slice(last, match.index) });
    last = match.index + match[0].length;
    const [, sigil, name = ""] = match;
    if (sigil === "#") {
      const section = { kind: "section" as const, name, children: [] as Node[] };
      top.children.push(section);
      stack.push(section);
    } else if (sigil === "/") {
      if (top.name !== name)
        throw new Error(`Template section "${name}" closed but "${top.name}" is open`);
      stack.pop();
    } else {
      top.children.push({ kind: "var", name });
    }
  }
  const open = stack.at(-1);
  if (stack.length > 1 && open !== undefined)
    throw new Error(`Template section "${open.name}" is not closed`);
  if (last < template.length) root.push({ kind: "text", text: template.slice(last) });
  return root;
}

function lookup(name: string, contexts: unknown[]): unknown {
  if (name === ".") return contexts.at(-1);
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const context = contexts[i];
    if (typeof context === "object" && context !== null && Object.hasOwn(context, name)) {
      return (context as View)[name];
    }
  }
  throw new Error(`Template variable "${name}" is not defined`);
}

function render(nodes: Node[], contexts: unknown[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "var") {
      const value = lookup(node.name, contexts);
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Template variable "${node.name}" is not a string or number`);
      }
      out += String(value);
    } else {
      const value = lookup(node.name, contexts);
      if (Array.isArray(value)) {
        for (const item of value) out += render(node.children, [...contexts, item]);
      } else if (value === true) {
        out += render(node.children, contexts);
      } else if (typeof value === "object" && value !== null) {
        out += render(node.children, [...contexts, value]);
      }
    }
  }
  return out;
}

export function renderTemplate(template: string, view: View): string {
  return render(parse(template.replace(STANDALONE, "$1")), [view]);
}
