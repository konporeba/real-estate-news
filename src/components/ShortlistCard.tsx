// One shortlisted story, rendered the same way everywhere it appears.
//
// Used in three modes, which is why it lives here rather than inline in the page:
//   * plain      — a digest past selection with no selection recorded (read-only)
//   * selectable — inside SelectionForm, with a checkbox (hydrated)
//   * picked     — after confirmation, marking what the operator chose (read-only)
//
// The read-only usages are rendered by Astro WITHOUT a client directive, so they ship as static
// HTML with no JavaScript; only SelectionForm hydrates. Keeping one component is what stops the
// FR-009a two-language layout from drifting between the selectable and read-only views.
import type { ReactNode } from "react";

import { cn, isSafeUrl } from "@/lib/utils";
import type { ShortlistItem } from "@/types";

/** Tiers differ in lightness, not just hue, so they stay distinguishable without colour vision. */
const TIERS: Record<string, { label: string; className: string }> = {
  catalonia: { label: "Catalonia", className: "bg-signal font-semibold text-signal-foreground" },
  national: { label: "Spain", className: "bg-primary font-medium text-primary-foreground" },
  global: { label: "Global", className: "border border-input bg-card font-medium text-foreground" },
  discard: { label: "Discard", className: "border border-dashed border-input bg-card text-muted-foreground" },
};

/** FR-009a: each side of the card is language-flagged, so an odd translation can be checked
 * against its source. A null `language` renders no flag rather than a wrong one. */
const LANGUAGE_CHIP =
  "shrink-0 rounded border border-input px-1.5 py-px text-[11px] font-bold tracking-wider text-foreground";

export interface ShortlistCardProps {
  item: ShortlistItem;
  /** Renders the checkbox and makes the whole card the click target. Omitted for both read-only modes. */
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (clusterId: string) => void;
  /** Read-only marking of a confirmed pick. */
  picked?: boolean;
}

export function ShortlistCard({
  item,
  selectable = false,
  selected = false,
  onToggle,
  picked = false,
}: ShortlistCardProps) {
  const highlighted = selected || picked;
  const tier = item.tier ? (TIERS[item.tier] ?? { label: item.tier, className: TIERS.discard.className }) : null;
  const title = item.translated ? item.polishTitle : item.originalTitle;
  const summary = item.translated ? item.polishSummary : item.originalLede;

  const body: ReactNode = (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono">#{item.rank}</span>
        {tier && (
          <span className={cn("inline-flex h-6.5 items-center rounded-md px-2.5 text-[13px]", tier.className)}>
            {tier.label}
          </span>
        )}
        {item.score !== null && <span className="font-mono">score {item.score}</span>}
        <span>
          · {item.coverageCount} source{item.coverageCount === 1 ? "" : "s"}
        </span>
        {picked && (
          <span className="bg-signal text-signal-foreground inline-flex h-6.5 items-center rounded-full px-2.5 font-semibold">
            Picked
          </span>
        )}
        {!item.translated && (
          <span className="border-input text-foreground inline-flex h-6.5 items-center rounded-full border border-dashed px-2.5">
            Not translated
          </span>
        )}
      </div>

      <div className="flex items-start gap-2">
        {item.translated ? (
          <span className={cn(LANGUAGE_CHIP, "mt-1")}>PL</span>
        ) : (
          item.originalLanguage && (
            <span className={cn(LANGUAGE_CHIP, "mt-1")}>{item.originalLanguage.toUpperCase()}</span>
          )
        )}
        <h2 className="text-[19px] leading-snug font-semibold tracking-tight">{title}</h2>
      </div>
      {summary && <p className="text-[15px] leading-relaxed">{summary}</p>}

      {item.translated && (
        <div className="flex items-baseline gap-2 border-t pt-2.5">
          {item.originalLanguage && <span className={LANGUAGE_CHIP}>{item.originalLanguage.toUpperCase()}</span>}
          <div className="min-w-0">
            <h3 className="text-muted-foreground text-sm leading-snug font-medium">{item.originalTitle}</h3>
            {item.originalLede && (
              <p className="text-muted-foreground mt-1 text-sm leading-snug">{item.originalLede}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        {item.rationale ? <span className="text-muted-foreground">Why it ranked: {item.rationale}</span> : <span />}
        {item.sourceUrl && isSafeUrl(item.sourceUrl) && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-6 items-center font-semibold no-underline hover:underline"
          >
            Read source
          </a>
        )}
      </div>
    </div>
  );

  const frame = cn(
    "flex gap-4 rounded-2xl bg-card transition-shadow",
    highlighted
      ? "border-2 border-signal px-[21px] py-[19px] shadow-[0_0_0_4px_var(--signal-tint)]"
      : "border px-[22px] py-5",
  );

  if (!selectable) {
    return <li className={frame}>{body}</li>;
  }

  return (
    <li>
      {/* The whole card is the click target, not just a 16px box. A link inside a label keeps its
          own activation, so "Read source" still opens the article rather than toggling the pick. */}
      <label className={cn(frame, "hover:border-input cursor-pointer")}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle?.(item.clusterId)}
          aria-label={`Pick: ${title}`}
          className="accent-primary mt-0.5 size-5.5 shrink-0 cursor-pointer"
        />
        {body}
      </label>
    </li>
  );
}
