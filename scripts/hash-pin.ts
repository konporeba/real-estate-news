// F-02: one-off setup script the operator runs (and reruns on rotation) to produce PIN_HASH for
// pasting into .dev.vars / Cloudflare secrets. There is no in-app way to set the initial PIN
// since there is no sign-up flow. Reuses hashPin from src/lib/auth/pin.ts rather than
// reimplementing the hash -- run via tsx (like scripts/collect and scripts/rank) so the `@/` path
// alias and TypeScript both resolve, which plain `node` cannot do for this file.
import { hashPin } from "@/lib/auth/pin";

const [pin, pepper] = process.argv.slice(2);

if (!pin || !pepper) {
  console.error("Usage: tsx scripts/hash-pin.ts <pin> <pepper>");
  process.exit(1);
}

const hash = await hashPin(pin, pepper);
console.log(hash);
