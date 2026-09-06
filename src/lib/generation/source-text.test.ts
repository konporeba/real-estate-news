// Extraction is where generation's source material comes from, and — because whatever it returns
// becomes the numeric gate's source of truth — where leaked boilerplate turns into false gate
// failures on good copy. These tests run entirely against fixtures and an injected fetch: no
// network, so they are deterministic and safe in CI.
import { describe, expect, it } from "vitest";

import { extractFigures } from "@/lib/generation/numerals";
import { extractArticleText, fetchArticleText, MIN_ARTICLE_CHARS } from "@/lib/generation/source-text";

/** Enough real-shaped prose to clear MIN_ARTICLE_CHARS without padding the fixture by hand. */
const BODY_PARAGRAPHS = [
  "El precio medio de la vivienda en Barcelona alcanzó los 4.250 euros por metro cuadrado en agosto, según los datos publicados hoy por el portal inmobiliario, que analiza la evolución del mercado en las principales capitales españolas.",
  "La subida interanual fue del 8,3%, el mayor incremento registrado en la serie histórica reciente para el conjunto de la ciudad condal, con diferencias notables entre distritos del centro y de la periferia.",
  "Los expertos consultados atribuyen el encarecimiento a la escasez de obra nueva y a la presión de la demanda internacional, que sigue concentrándose en un número reducido de barrios muy solicitados.",
].join("</p><p>");

function page(inner: string): string {
  return `<!doctype html><html><head><title>Precio vivienda</title></head><body>${inner}</body></html>`;
}

const ARTICLE_PAGE = page(
  `<nav>Inicio Vivienda Contacto 2024</nav>
   <div class="cookie-consent">Aceptamos cookies. Llame al 900 123 456 para más información sobre nuestra política de privacidad y el tratamiento de sus datos personales.</div>
   <article><h1>El precio sube un 8,3%</h1><p>${BODY_PARAGRAPHS}</p></article>
   <div class="related-links">Le puede interesar: 5 claves del mercado</div>
   <footer>Copyright 2024. Todos los derechos reservados. 3 comentarios</footer>`,
);

/** A fetch stub, mirroring how the LLM and email harnesses take an injectable transport. */
function fakeFetch(outcome: { status?: number; body?: string } | Error): typeof fetch {
  return () => {
    if (outcome instanceof Error) return Promise.reject(outcome);
    const status = outcome.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(outcome.body ?? ""),
    } as Response);
  };
}

describe("extractArticleText", () => {
  it("returns the article body", () => {
    const result = extractArticleText(ARTICLE_PAGE);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.origin).toBe("article");
    expect(result.text).toContain("4.250 euros por metro cuadrado");
    expect(result.text).toContain("8,3%");
  });

  it("excludes navigation, footer and related-links furniture", () => {
    const result = extractArticleText(ARTICLE_PAGE);
    if (!result.ok) throw new Error(result.reason);

    expect(result.text).not.toContain("Inicio Vivienda Contacto");
    expect(result.text).not.toContain("Todos los derechos reservados");
    expect(result.text).not.toContain("Le puede interesar");
  });

  // Readability alone KEEPS a cookie banner — verified against its own output. The banner's phone
  // number would otherwise reach the numeric gate as source-of-truth text.
  it("excludes a cookie banner Readability would otherwise keep", () => {
    const result = extractArticleText(ARTICLE_PAGE);
    if (!result.ok) throw new Error(result.reason);

    expect(result.text).not.toContain("900 123 456");
    expect(result.text).not.toContain("Aceptamos cookies");
  });

  // The end-to-end property this whole module exists to protect: the figures the gate will
  // enforce are the story's own, not the page's furniture.
  it("yields only the story's figures to the numeric gate", () => {
    const result = extractArticleText(ARTICLE_PAGE);
    if (!result.ok) throw new Error(result.reason);

    // Sorted, because document order puts the h1's "8,3%" ahead of the body's "4.250 euros" —
    // what matters is the SET: the story's two figures, and none of the page's furniture.
    const figures = extractFigures(result.text)
      .map((figure) => figure.value)
      .sort((a, b) => a - b);
    expect(figures).toEqual([8.3, 4250]);
  });

  // The realistic unparseable case is a client-rendered page: the server returns an empty shell
  // and the article only exists after JavaScript runs, which this worker does not do.
  it("reports unparseable for a JavaScript-only page shell", () => {
    const result = extractArticleText(page('<div id="root"></div><script>app()</script>'));

    expect(result).toEqual({ ok: false, reason: "unparseable" });
  });

  it("reports unparseable for a page with no body content at all", () => {
    expect(extractArticleText("<!doctype html><html><head><title>t</title></head></html>")).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });

  it("reports unparseable rather than throwing on junk input", () => {
    expect(extractArticleText("not html at all").ok).toBe(false);
    expect(extractArticleText("").ok).toBe(false);
  });

  it("reports too_short for a paywall teaser", () => {
    const teaser = page(`<article><h1>Titular</h1><p>Este contenido es exclusivo para suscriptores.</p></article>`);

    expect(extractArticleText(teaser)).toEqual({ ok: false, reason: "too_short" });
  });

  it("treats anything under MIN_ARTICLE_CHARS as too short", () => {
    const short = page(`<article><p>${"a".repeat(MIN_ARTICLE_CHARS - 100)}</p></article>`);

    expect(extractArticleText(short)).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("fetchArticleText — failure taxonomy", () => {
  it("extracts on a 200", async () => {
    const result = await fetchArticleText("https://example.test/a", {
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
  });

  it("maps 403 to blocked — the Idealista case", async () => {
    const result = await fetchArticleText("https://example.test/a", { fetchImpl: fakeFetch({ status: 403 }) });

    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("maps 401 and 429 to blocked", async () => {
    expect(await fetchArticleText("https://e.test/a", { fetchImpl: fakeFetch({ status: 401 }) })).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(await fetchArticleText("https://e.test/a", { fetchImpl: fakeFetch({ status: 429 }) })).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("maps 404 and 410 to not_found", async () => {
    expect(await fetchArticleText("https://e.test/a", { fetchImpl: fakeFetch({ status: 404 }) })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await fetchArticleText("https://e.test/a", { fetchImpl: fakeFetch({ status: 410 }) })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("maps a 500 to network", async () => {
    const result = await fetchArticleText("https://e.test/a", { fetchImpl: fakeFetch({ status: 500 }) });

    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it("maps a rejected fetch to network rather than throwing", async () => {
    const result = await fetchArticleText("https://e.test/a", {
      fetchImpl: fakeFetch(new Error("getaddrinfo ENOTFOUND")),
    });

    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it("maps a timeout to network rather than throwing", async () => {
    const result = await fetchArticleText("https://e.test/a", {
      fetchImpl: fakeFetch(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    });

    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it("sends an honest User-Agent rather than spoofing a browser", async () => {
    let sent: string | undefined;
    const spy = ((_url: string, init?: RequestInit) => {
      sent = (init?.headers as Record<string, string> | undefined)?.["User-Agent"];
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(ARTICLE_PAGE) } as Response);
    }) as typeof fetch;

    await fetchArticleText("https://e.test/a", { fetchImpl: spy });

    expect(sent).toContain("RealEstateNewsDigest");
    expect(sent).not.toMatch(/Mozilla|Chrome|Safari/);
  });
});
