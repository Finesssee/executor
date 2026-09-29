import { type ReactNode } from "react";
import { publicDocsBaseUrl } from "../../contracts/documentation.ts";
import { Code, CopyButton } from "./code.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";

/** The agent installs Executor itself; the prompt carries everything it needs to start. */
export const mcpSetupPrompt = (endpoint: string, docs: string, next: string) =>
  `Help me connect to Executor over MCP at ${endpoint}.\n\nRead the docs to understand the product at ${docs}, then ${next}.`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const tabClass =
  "h-10! w-full justify-start gap-6 border-b p-0 [&_[data-slot='tabs-trigger']]:h-full [&_[data-slot='tabs-trigger']]:flex-none [&_[data-slot='tabs-trigger']]:rounded-none [&_[data-slot='tabs-trigger']]:px-0 [&_[data-slot='tabs-trigger']]:text-[13px] [&_[data-slot='tabs-trigger']]:after:bottom-0";

/** Setup as a prompt for the agent, the raw MCP URL, or a one-line installer command. */
export function McpInstallInstructions({
  endpoint,
  docs = publicDocsBaseUrl,
  next = "help me get my first app set up",
  children,
}: {
  readonly endpoint: string;
  readonly docs?: string;
  /** What the agent should do once connected. */
  readonly next?: string;
  readonly children?: ReactNode;
}) {
  const prompt = mcpSetupPrompt(endpoint, docs, next);
  const command = `npx add-mcp ${shellQuote(endpoint)} --name executor -g`;
  return (
    <div className="mcp-install-content min-w-0">
      <Tabs defaultValue="prompt">
        <TabsList aria-label="Setup method" variant="line" className={tabClass}>
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_prompt"
            value="prompt"
          >
            Prompt
          </TabsTrigger>
          <TabsTrigger data-product-area="connect" data-product-action="select_url" value="url">
            MCP URL
          </TabsTrigger>
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_command"
            value="command"
          >
            Command
          </TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Send this to your agent. It adds the Executor MCP server, then asks you to sign in.
          </p>
          <p className="mt-3 rounded-lg border border-foreground/15 bg-foreground/[0.06] p-4 text-sm leading-6 break-words whitespace-pre-line select-text">
            {prompt}
          </p>
          <div className="mt-3">
            <CopyButton
              code={prompt}
              label="Copy setup prompt"
              text="Copy prompt"
              variant="default"
              size="default"
              inline
            />
          </div>
        </TabsContent>
        <TabsContent value="url" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Add a Streamable HTTP MCP server with this URL. Your client signs in with OAuth.
          </p>
          <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border bg-background py-1.5 pr-1.5 pl-4">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={endpoint}>
              {endpoint}
            </code>
            <CopyButton code={endpoint} label="Copy MCP URL" text="Copy" size="sm" inline />
          </div>
        </TabsContent>
        <TabsContent value="command" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Run in your terminal, then choose the agents to add Executor to.
          </p>
          <div className="mcp-install-code relative mt-3 min-w-0 overflow-hidden rounded-lg border [&_pre]:py-4! [&_pre]:pr-14! [&_pre]:pl-4! [&_pre]:leading-6!">
            <CopyButton code={command} label="Copy command" />
            <Code code={command} path="install.sh" />
          </div>
        </TabsContent>
      </Tabs>
      {children && (
        <p className="field-hint mt-4 text-xs leading-5 text-muted-foreground">{children}</p>
      )}
    </div>
  );
}
