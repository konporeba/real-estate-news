// WORKER-SIDE, but pure: no network, no credentials, no clock.
//
// Which photo slide each story of a weekly carousel lands on. Two decisions, both made here so the
// renderer only composes them:
//
//   1. SECTION. A story belongs to its geography section (Barcelona or Spain, from the ranking
//      tier) and, when ranking flagged it, to finance/law as well. With two candidates it takes the
//      one this carousel has used least so far — the operator wants the week's post to mix the
//      three looks — and a tie goes to geography. Decided in shortlist order, so the lead story
//      gets its geography section.
//   2. PHOTO. Within a section, slides are taken in deck order from a starting point that moves
//      with the ISO week, so consecutive weeks open on different photos and no photo repeats inside
//      one carousel until the section runs out of them.
import { CAROUSEL_SECTIONS, type CarouselSection, type CarouselStorySlide } from "@/lib/visuals/template";

/** What ranking left in `cluster.scoring_detail` that matters here. Missing on old rows. */
export interface SectionDetail {
  tier?: string | null;
  financeLaw?: boolean | null;
}

const GEOGRAPHY_BY_TIER: Partial<Record<string, CarouselSection>> = {
  catalonia: "barcelona",
  national: "spain",
  global: "spain",
};

/**
 * The sections a story may use, geography first. A story with no geography section — the
 * operator picked a `discard`, or the cluster predates scoring — goes to finance/law when flagged
 * and to Spain otherwise, the broadest look.
 */
export function storySections(detail: SectionDetail | null): CarouselSection[] {
  const geography = detail?.tier ? GEOGRAPHY_BY_TIER[detail.tier] : undefined;
  const sections: CarouselSection[] = geography ? [geography] : [];
  if (detail?.financeLaw === true) sections.push("finance_law");
  return sections.length > 0 ? sections : ["spain"];
}

/** One section per story, in the order given (shortlist order). */
export function assignSections(details: (SectionDetail | null)[]): CarouselSection[] {
  const used = new Map<CarouselSection, number>(CAROUSEL_SECTIONS.map((section) => [section, 0]));

  return details.map((detail) => {
    const candidates = storySections(detail);
    // reduce keeps the FIRST minimum, and candidates list geography first: that is the tie rule.
    const chosen = candidates.reduce((best, section) =>
      (used.get(section) ?? 0) < (used.get(best) ?? 0) ? section : best,
    );
    used.set(chosen, (used.get(chosen) ?? 0) + 1);
    return chosen;
  });
}

/**
 * ISO-8601 week number (1–53) of a `YYYY-MM-DD` date, computed in UTC so the result never depends
 * on the machine's zone. The rotation seed: it changes every week and repeats only yearly.
 */
export function isoWeekNumber(date: string): number {
  const day = new Date(`${date}T00:00:00Z`);
  // Thursday of this week decides the ISO year; count weeks from that year's first Thursday.
  const thursday = new Date(day);
  thursday.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * The photo slide for each story, given the section each was assigned.
 *
 * Returns null for a section the deck has no slide for — the validator makes that impossible for
 * a deck that passed it, but the renderer must not crash on one that did not.
 */
export function assignSlides(
  sections: CarouselSection[],
  deckSlides: CarouselStorySlide[],
  weekSeed: number,
): (CarouselStorySlide | null)[] {
  const taken = new Map<CarouselSection, number>();

  return sections.map((section) => {
    const pool = deckSlides.filter((slide) => slide.section === section);
    if (pool.length === 0) return null;
    const nth = taken.get(section) ?? 0;
    taken.set(section, nth + 1);
    return pool[(weekSeed + nth) % pool.length];
  });
}
