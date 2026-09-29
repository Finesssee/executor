/** The languages supported by the shared code renderer. */
export type CodeLanguage =
  | "typescript"
  | "javascript"
  | "css"
  | "markdown"
  | "html"
  | "json"
  | "shellscript"
  | "text";

/** Choose the language for a file from its extension. */
export function codeLanguage(path: string): CodeLanguage {
  if (/\.[cm]?tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (/\.(md|markdown)$/.test(path)) return "markdown";
  if (/\.html?$/.test(path)) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sh")) return "shellscript";
  return "text";
}

/** Choose the language for a Markdown fence from its info string, such as `ts` or `bash`. */
export function fenceLanguage(info: string): CodeLanguage {
  const name = info.toLowerCase();
  if (["ts", "tsx", "mts", "cts", "typescript"].includes(name)) return "typescript";
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(name)) return "javascript";
  if (name === "css") return "css";
  if (["md", "markdown"].includes(name)) return "markdown";
  if (["html", "htm"].includes(name)) return "html";
  if (["json", "jsonc"].includes(name)) return "json";
  if (["sh", "bash", "shell", "shellscript", "zsh", "console"].includes(name)) return "shellscript";
  return "text";
}
