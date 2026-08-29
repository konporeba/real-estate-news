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
import { cn, isSafeUrl } from "@/lib/utils";
import type { ShortlistItem } from "@/types";

const TIER_STYLES: Record<string, string> = {
  catalonia: "border-green-400/40 bg-green-500/20 text-green-300",
  national: "border-amber-400/40 bg-amber-500/20 text-amber-300",
  global: "border-sky-400/40 bg-sky-500/20 text-sky-300",
  discard: "border-white/20 bg-white/10 text-blue-100/60",
};
const DEFAULT_TIER_STYLE = "border-white/20 bg-white/10 text-blue-100/60";

/** FR-009a: each side of the card is language-flagged, so an odd translation can be checked
 * against its source. A null `language` renders no flag rather than a wrong one. */
const LANGUAGE_CHIP =
  "rounded border border-white/15 bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-blue-100/70";

export interface ShortlistCardProps {
  item: ShortlistItem;
  /** Renders the checkbox. Omitted for both read-only modes. */
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

  return (
    <li
      className={cn(
        "rounded-xl border p-4 transition-colors",
        highlighted ? "border-purple-400/50 bg-purple-500/15" : "border-white/10 bg-white/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggle?.(item.clusterId)}
              // The accessible name is the story itself; the visible title is not a <label>
              // target because it is a heading rendered below.
              aria-label={`Select: ${item.polishTitle ?? item.originalTitle}`}
              className="size-4 shrink-0 accent-purple-500"
            />
          )}
          <span className="text-blue-100/50">#{item.rank}</span>
          {picked && (
            <span className="rounded-full border border-purple-400/40 bg-purple-500/20 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-purple-200 uppercase">
              selected
            </span>
          )}
        </div>
        {item.tier && (
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-xs tracking-wide uppercase",
              TIER_STYLES[item.tier] ?? DEFAULT_TIER_STYLE,
            )}
          >
            {item.tier}
          </span>
        )}
      </div>

      {item.translated ? (
        <>
          <div className="mt-2 flex items-start gap-2">
            <span className={LANGUAGE_CHIP}>PL</span>
            <h2 className="text-lg font-semibold">{item.polishTitle}</h2>
          </div>
          {item.polishSummary && <p className="mt-1 text-sm text-blue-100/70">{item.polishSummary}</p>}
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="flex items-start gap-2">
              {item.originalLanguage && <span className={LANGUAGE_CHIP}>{item.originalLanguage.toUpperCase()}</span>}
              <h3 className="text-sm font-medium text-blue-100/80">{item.originalTitle}</h3>
            </div>
            {item.originalLede && <p className="mt-1 text-sm text-blue-100/50">{item.originalLede}</p>}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-start gap-2">
            {item.originalLanguage && <span className={LANGUAGE_CHIP}>{item.originalLanguage.toUpperCase()}</span>}
            <h2 className="text-lg font-semibold">{item.originalTitle}</h2>
          </div>
          {item.originalLede && <p className="mt-1 text-sm text-blue-100/70">{item.originalLede}</p>}
        </>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs text-blue-100/60">
        <span>
          {item.coverageCount} source{item.coverageCount === 1 ? "" : "s"}
        </span>
        {!item.translated && <span className="text-amber-300">untranslated</span>}
        {item.sourceUrl && isSafeUrl(item.sourceUrl) && (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">
            Read original →
          </a>
        )}
      </div>
    </li>
  );
}
