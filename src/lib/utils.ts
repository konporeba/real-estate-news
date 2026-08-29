import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Whether a URL is safe to render as a clickable link. Only http(s) passes — this blocks
 * `javascript:` and `data:` schemes reaching an anchor from a `source_url` that ultimately came
 * from scraped RSS content.
 *
 * `src/lib/email/layout.ts` has its own copy on purpose: that module is worker-side only, and
 * app code is forbidden to import it (eslint.config.js). This is the app-side home.
 */
export function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
