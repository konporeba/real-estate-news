// The redesign's two button weights, shared by every island. One primary (ink) button per screen —
// the next decision; everything else is the outline. No red/green pairs: intent is said in words.
export const PRIMARY_BUTTON =
  "inline-flex min-h-12 cursor-pointer items-center justify-center rounded-xl bg-primary px-5 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-border disabled:text-foreground disabled:hover:opacity-100";

export const SECONDARY_BUTTON =
  "inline-flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-input bg-card px-5 font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
