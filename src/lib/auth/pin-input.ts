// Isolated from verify-pin.ts so the shape check is unit-testable without resolving
// astro:env/server (which only exists inside the Astro/workerd runtime, not under Vitest).
import { z } from "zod";

export const pinInputSchema = z.string().regex(/^\d{6}$/);
