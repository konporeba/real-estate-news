// The React twin of StatusChip.astro, for islands that render status chips themselves (the week
// list). Both read their label and classes from @/lib/digest/presentation.
import { STATUS_CHIP_CLASSES, STATUS_PRESENTATION, STATUS_TONE_CLASSES } from "@/lib/digest/presentation";
import { cn } from "@/lib/utils";
import type { DigestStatus } from "@/types";

export function StatusBadge({ status }: { status: DigestStatus }) {
  const { label, tone } = STATUS_PRESENTATION[status];
  return <span className={cn(STATUS_CHIP_CLASSES, STATUS_TONE_CLASSES[tone])}>{label}</span>;
}
