// Minimal {{var}} templating. HTML output escapes every value; there is no
// raw/unescaped syntax on purpose. Missing variables are an error so a broken
// verification email is never sent.

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type Vars = Record<string, string | number | boolean>;

export class TemplateError extends Error {}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function render(tpl: string, vars: Vars, mode: "html" | "text" | "header"): string {
  return tpl.replace(VAR_RE, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new TemplateError(`missing variable: ${name}`);
    }
    const v = String(vars[name]);
    if (mode === "html") return escapeHtml(v);
    if (mode === "header") return v.replace(/[\r\n]+/g, " ");
    return v;
  });
}
