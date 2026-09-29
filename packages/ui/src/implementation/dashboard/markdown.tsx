import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components, ExtraProps } from "react-markdown";
import { fenceLanguage } from "../../contracts/code-language.ts";
import { Code } from "./code.tsx";

/** Highlight a Markdown code block with the shared code renderer. */
export function MarkdownCodeBlock({ node }: ExtraProps) {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code?.type !== "element") return null;
  const info = code.properties.className;
  const language = Array.isArray(info)
    ? info.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  const text = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/, "");
  return (
    <Code
      code={text}
      language={typeof language === "string" ? fenceLanguage(language.slice(9)) : "text"}
      lineNumbers={false}
    />
  );
}

const components: Components = {
  a: ({ href, children }) => {
    const safeHref = href !== undefined && /^(https?:)\/\//i.test(href) ? href : undefined;
    return safeHref === undefined ? (
      <span>{children}</span>
    ) : (
      <a href={safeHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre: (props) => (
    <div className="tool-markdown-code overflow-x-auto my-[8px] mx-0 [&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:rounded-[6px] [&_pre]:py-[10px] [&_pre]:px-[12px] [&_pre]:text-[11px] [&_pre]:leading-[1.6]">
      <MarkdownCodeBlock node={props.node} />
    </div>
  ),
};

/** Render tool-authored Markdown without enabling raw HTML or unsafe links. */
export function ToolMarkdown({ children }: { readonly children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {children}
    </Markdown>
  );
}
