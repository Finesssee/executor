/** Size of skill text as an agent loads it. */
import { cn } from "../lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.tsx";

const lineCount = (content: string): number =>
  content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length;

/**
 * Model tokenizers differ and are not all public, so this uses the common estimate of four
 * characters per token. It is shown as approximate.
 */
const tokenEstimate = (content: string): number => Math.ceil(content.length / 4);

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const plural = (count: number, word: string) =>
  `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;

export function SkillSize({
  contents,
  className,
}: {
  readonly contents: readonly string[];
  readonly className?: string;
}) {
  const lines = contents.reduce((total, content) => total + lineCount(content), 0);
  const tokens = contents.reduce((total, content) => total + tokenEstimate(content), 0);
  return (
    <span className={cn("tabular-nums text-muted-foreground", className)}>
      {plural(lines, "line")} ·{" "}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          {/* Not focusable: in the skill list this sits inside the skill's button. */}
          <TooltipTrigger asChild>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              ~{compact.format(tokens)} tokens
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            Estimated at four characters per token. Exact counts vary by model.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
