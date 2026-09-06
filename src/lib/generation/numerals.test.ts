// FR-014's gate is the one requirement in S-05 with an objectively right answer, and the one
// that fails dangerously in both directions: a false pass ships a wrong price to investors, a
// false failure blocks a good week's digest. So the tests here are exhaustive by design — this
// module has no LLM and no database, which makes thorough coverage nearly free.
import { describe, expect, it } from "vitest";

import { assertFiguresPresent, describeMissing, extractFigures } from "@/lib/generation/numerals";

/** Values only — the assertion most cases care about. */
function values(text: string): number[] {
  return extractFigures(text).map((figure) => figure.value);
}

describe("extractFigures — number formats", () => {
  const cases: { name: string; text: string; expected: number[] }[] = [
    // Spanish: dot groups thousands, comma is the decimal separator.
    { name: "spanish thousands and decimal", text: "El piso cuesta 1.234,56 €", expected: [1234.56] },
    { name: "spanish thousands only", text: "Subió a 2.500 euros", expected: [2500] },
    { name: "spanish millions grouping", text: "Un total de 1.250.000 €", expected: [1250000] },
    // Polish: space (in any of its typographic forms) groups thousands.
    { name: "polish plain space", text: "Cena 1 234,56 zł", expected: [1234.56] },
    { name: "polish non-breaking space", text: "Cena 1 234,56 zł", expected: [1234.56] },
    { name: "polish narrow no-break space", text: "Cena 1 234,56 zł", expected: [1234.56] },
    // A lone dot with fewer than three following digits is a decimal point, not a group.
    { name: "dot decimal", text: "Una subida del 3.5%", expected: [3.5] },
    { name: "comma decimal", text: "Una subida del 3,5%", expected: [3.5] },
  ];

  for (const { name, text, expected } of cases) {
    it(name, () => {
      expect(values(text)).toEqual(expected);
    });
  }
});

describe("extractFigures — what qualifies as significant", () => {
  it("takes a number carrying a currency symbol after it", () => {
    expect(values("El precio es 340.000 €")).toEqual([340000]);
  });

  it("takes a number carrying a currency symbol before it", () => {
    expect(values("El precio es €340.000")).toEqual([340000]);
  });

  it("takes zloty in Polish output", () => {
    expect(values("Mieszkanie kosztuje 340 000 zł")).toEqual([340000]);
  });

  it("takes an inflected Polish currency word", () => {
    expect(values("Cena wynosi 340 000 złotych")).toEqual([340000]);
  });

  it("takes a percentage", () => {
    expect(values("Los precios subieron un 8,3%")).toEqual([8.3]);
  });

  it("takes a spelled-out percentage in both languages", () => {
    expect(values("subió un 12 por ciento")).toEqual([12]);
    expect(values("wzrost o 12 procent")).toEqual([12]);
  });

  it("takes a number carrying an area unit", () => {
    expect(values("Una vivienda de 120 m²")).toEqual([120]);
  });

  // Both of these come from real article text in the live pool, where abbreviated and
  // spelled-out units appear in the same sentence.
  it("takes a spelled-out distance unit", () => {
    expect(values("El puente tiene 2,5 kilómetros de longitud")).toEqual([2.5]);
  });

  it("takes a spelled-out metre unit", () => {
    expect(values("con un vano principal de 853 metros")).toEqual([853]);
  });

  it("ignores a bare number with nothing qualifying it", () => {
    expect(values("El artículo tiene 3 comentarios")).toEqual([]);
  });

  it("ignores a year in a byline", () => {
    expect(values("Publicado en 2024 por la redacción")).toEqual([]);
  });

  it("ignores a reading-time marker", () => {
    expect(values("Lectura: 5 min")).toEqual([]);
  });

  it("ignores an article id", () => {
    expect(values("referencia 987654321 del registro")).toEqual([]);
  });

  it("returns nothing for empty or numeral-free text", () => {
    expect(extractFigures("")).toEqual([]);
    expect(extractFigures("El mercado inmobiliario catalán sigue activo")).toEqual([]);
  });
});

// Verbatim text from the live pool (digest c92aa3c5). Hand-written fixtures test what the author
// thought of; this tests what the sources actually publish — including the trailing feed
// boilerplate ("La entrada ... aparece primero en fotocasa") that must contribute no figures.
describe("extractFigures — real article text", () => {
  const priceStory =
    "El precio de la vivienda sube un 15,6% interanual en España en agosto. Es el incremento " +
    "interanual (15,6%) número 70 en cadena (5,8 años) y se sitúa el precio de agosto en 3.166 " +
    "euros/m2 Una vivienda estándar de 80 m2 se oferta de media en 253.270 euros frente a los " +
    "219.020 de hace un año (incremento del 15,6%) El precio de la vivienda de segunda mano en " +
    "[...] La entrada El precio de la vivienda sube un 15,6% interanual en España en agosto " +
    "aparece primero en fotocasa.";

  it("takes the story's real figures", () => {
    expect(values(priceStory)).toEqual([15.6, 3166, 80, 253270]);
  });

  it("ignores the ordinal in 'número 70 en cadena'", () => {
    expect(values(priceStory)).not.toContain(70);
  });

  it("ignores feed boilerplate entirely", () => {
    expect(values("La entrada aparece primero en fotocasa. Leer")).toEqual([]);
  });

  const bridgeStory =
    "ACS inaugura el Gordie Howe, un puente atirantado valorado en 5.500 millones. El puente " +
    "tiene 2,5 kilómetros de longitud y seis carriles que cruzan el río Detroit, con un vano " +
    "principal de 853 metros. Leer";

  it("scales millions and takes both spelled-out units in one story", () => {
    expect(values(bridgeStory)).toEqual([5_500_000_000, 2.5, 853]);
  });
});

describe("extractFigures — magnitude words scale the value", () => {
  it("scales Spanish millions", () => {
    expect(values("una inversión de 3,5 millones de euros")).toEqual([3_500_000]);
  });

  it("scales Catalan millions", () => {
    expect(values("una inversió de 3,5 milions d'euros")).toEqual([3_500_000]);
  });

  it("scales Polish mln", () => {
    expect(values("inwestycja o wartości 3,5 mln zł")).toEqual([3_500_000]);
  });

  it("scales an inflected Polish million", () => {
    expect(values("inwestycja o wartości 3,5 miliona złotych")).toEqual([3_500_000]);
  });

  it("scales Spanish thousands", () => {
    expect(values("450 mil euros")).toEqual([450_000]);
  });

  it("scales Polish tys.", () => {
    expect(values("450 tys. zł")).toEqual([450_000]);
  });

  it("scales a Spanish billion written as mil millones", () => {
    expect(values("2 mil millones de euros")).toEqual([2_000_000_000]);
  });

  it("scales Polish mld", () => {
    expect(values("2 mld zł")).toEqual([2_000_000_000]);
  });

  it("makes a scaled figure equal to its expanded form", () => {
    expect(values("3,5 millones de euros")).toEqual(values("3 500 000 euros"));
  });
});

describe("extractFigures — ranges", () => {
  it("yields both ends when only the second carries the currency", () => {
    expect(values("entre 1.000 y 2.000 €")).toEqual([1000, 2000]);
  });

  it("applies the shared scale to both ends", () => {
    expect(values("entre 1 y 2 millones de euros")).toEqual([1_000_000, 2_000_000]);
  });

  it("handles a dash-joined range", () => {
    expect(values("1.000 – 2.000 €")).toEqual([1000, 2000]);
  });

  it("handles a Polish range connector", () => {
    expect(values("od 1 000 do 2 000 zł")).toEqual([1000, 2000]);
  });

  it("does not lend a qualifier across unrelated prose", () => {
    expect(values("hay 4 plantas y el precio es 2.000 €")).toEqual([2000]);
  });
});

describe("extractFigures — de-duplication", () => {
  it("reports a repeated value once", () => {
    expect(values("subió un 8%, y ese 8% se mantiene")).toEqual([8]);
  });

  it("keeps distinct values of the same kind", () => {
    expect(values("un 8% frente a un 5%")).toEqual([8, 5]);
  });
});

describe("assertFiguresPresent", () => {
  it("passes when every source figure survives, whatever the formatting", () => {
    const source = extractFigures("El precio medio subió un 8,3% hasta 1.234,56 € por metro");
    const result = assertFiguresPresent(source, "Cena wzrosła o 8,3% do 1 234,56 zł za metr");

    expect(result.ok).toBe(true);
  });

  it("passes when a magnitude word is localised", () => {
    const source = extractFigures("una inversión de 3,5 millones de euros");
    const result = assertFiguresPresent(source, "inwestycja o wartości 3,5 mln zł");

    expect(result.ok).toBe(true);
  });

  it("passes when a scaled figure is written out in full", () => {
    const source = extractFigures("una inversión de 3,5 millones de euros");
    const result = assertFiguresPresent(source, "inwestycja o wartości 3 500 000 zł");

    expect(result.ok).toBe(true);
  });

  it("fails on a drifted digit — the failure US-12 exists to catch", () => {
    const source = extractFigures("El precio es 1.234 €");
    const result = assertFiguresPresent(source, "Cena wynosi 1 243 zł");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a drifted figure to fail");
    expect(result.missing.map((figure) => figure.value)).toEqual([1234]);
  });

  it("fails on an omitted figure", () => {
    const source = extractFigures("subió un 8,3% hasta 1.234 €");
    const result = assertFiguresPresent(source, "Cena wzrosła o 8,3%");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an omitted figure to fail");
    expect(result.missing.map((figure) => figure.value)).toEqual([1234]);
  });

  it("does not care whether the KIND changed, only the value", () => {
    // A percentage in the source rendered as a bare qualified number in the output still counts:
    // the figure survived, and demanding the qualifier match would fail correct translations.
    const source = extractFigures("una superficie de 120 m²");
    const result = assertFiguresPresent(source, "powierzchnia 120 metrów kwadratowych");

    expect(result.ok).toBe(true);
  });

  it("passes vacuously when the source carries no significant figures", () => {
    expect(assertFiguresPresent([], "dowolny tekst")).toEqual({ ok: true });
  });

  it("reports every missing figure, not just the first", () => {
    const source = extractFigures("un 8% y 1.234 € y 120 m²");
    const result = assertFiguresPresent(source, "brak liczb");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected all figures to be missing");
    expect(result.missing).toHaveLength(3);
  });
});

describe("describeMissing", () => {
  it("renders a diagnostic naming each figure as it appeared", () => {
    const missing = extractFigures("El precio es 1.234 €");

    expect(describeMissing(missing)).toBe("1.234 (currency, 1234)");
  });
});
