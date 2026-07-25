// The held-out, hand-labeled eval set (S-02 Phase 1). Real articles pulled from the S-01 pool
// (digest a4ac3306, week 2026-07-20) and labeled by the FR-007 rubric. These NEVER appear in a
// rubric prompt — the gate measures generalization, not memorization.
//
// Labeling rule (FR-007), applied as topic-gate THEN geography:
//   1. Is it real-estate money/regulation (prices, mortgages, construction, housing law)? If not
//      — a restaurant closing, port traffic, car subsidies, general trade — it is `discard`,
//      whatever its geography.
//   2. Among on-topic stories, tier by where EFFECTS land, not where published: Catalonia/Barcelona
//      → `catalonia`; Spain-wide nationally-applicable → `national` (a Madrid-announced national
//      rule is national, not "Madrid news"); global with direct Spanish-market impact → `global`;
//      another region's purely local real-estate → `discard`.
//
// The set is deliberately heavy on the misjudgment cases the PRD flags: right-geography-off-topic,
// right-topic-wrong-region, and the published-vs-effects national announcement. Operator review
// (Progress 1.8) confirms the labels before the rubric is tuned against them.
import type { LabeledExample, OrderingPair } from "@/lib/ranking/eval/harness";

export const EVAL_EXAMPLES: LabeledExample[] = [
  // --- catalonia: Catalonia/Barcelona + on-topic ---
  {
    id: "cat-vpo-restrictions",
    title: "Cataluña plantea por ley nuevas restricciones al sector privado para movilizar VPO",
    lede: "Las nuevas promociones sólo podrán usarse para vivienda habitual propia o de un familiar, segunda residencia o alquiler.",
    expectedTier: "catalonia",
    note: "Catalonia housing regulation (VPO/protected housing) — core geography + core topic.",
  },
  {
    id: "cat-hpo-conversion",
    title: "Govern i Comuns proposen convertir locals, hotels i oficines en habitatge protegit",
    lede: "En plena crisi de l'habitatge, el Govern ha fet de l'habitatge de protecció oficial (HPO) un dels seus projectes bandera.",
    expectedTier: "catalonia",
    note: "Catalonia protected-housing policy (Catalan-language). Catalonia + housing regulation.",
  },

  // --- national: Spain-wide nationally-applicable + on-topic ---
  {
    id: "nat-euribor",
    title: "El precio del euríbor hoy, 24 de julio: cierre de semana amargo si tienes una hipoteca",
    lede: "Euríbor es uno de los índices fundamentales del panorama financiero europeo; su cálculo condiciona las hipotecas.",
    expectedTier: "national",
    note: "Spain-wide mortgage index — nationally applicable money/real-estate.",
  },
  {
    id: "nat-mortgage-demand",
    title: "Los bancos detectan las primeras caídas de demanda de hipotecas desde la invasión de Ucrania",
    lede: "Las subidas del Euribor y el endurecimiento de los criterios de concesión de crédito condicionan la actividad.",
    expectedTier: "national",
    note: "Spain-wide mortgage demand.",
  },
  {
    id: "nat-price-surge",
    title: "El precio de la vivienda se dispara un 17,2% en el segundo trimestre: ¿dónde sube y dónde baja?",
    lede: "España ha alcanzado máximos en el precio de la vivienda en cuatro meses distintos.",
    expectedTier: "national",
    note: "Spain-wide house prices — core national real-estate.",
  },
  {
    id: "nat-socimi-tax",
    title: "El Gobierno plantea un castigo fiscal a las Socimis de viviendas",
    lede: "El nuevo Real Decreto de vivienda plantea elevar el gravamen sobre las Socimis.",
    expectedTier: "national",
    note: "National housing-tax regulation.",
  },
  {
    id: "nat-rental-extension",
    title: "El Gobierno incluye una prórroga de alquileres hasta 2028 en el nuevo decreto de vivienda",
    lede: "PSOE y Sumar han acordado una 'prórroga reforzada' de los alquileres en el nuevo decreto de vivienda.",
    expectedTier: "national",
    note: "PUBLISHED-VS-EFFECTS: announced by the Madrid-based national government, but the effect is nationwide rental law — national, NOT 'Madrid news'.",
  },
  {
    id: "nat-foreign-buyers",
    title: "¿Dónde compran vivienda los extranjeros en España?",
    lede: "Las costas españolas del Mediterráneo siguen siendo uno de los destinos favoritos del inversor internacional.",
    expectedTier: "national",
    note: "Spain-wide housing-market analysis.",
  },

  // --- global: no example this week. Operator decision 2026-07-25: this pool held no story with
  //     DIRECT Spanish-market impact (an ECB rate move, EU property/residency law). The rubric
  //     still produces a `global` tier; the eval simply does not gate it until a genuine global
  //     example appears in a future pool. Add one then (id prefix `glob-`) and a matching ordering.

  // --- discard: off-topic (any geography) OR another region's purely local real-estate ---
  {
    id: "disc-segro-prologis",
    title: "Segro rechaza una tercera opa de Prologis de 15.875 millones",
    lede: "Segro, firma británica de inversión inmobiliaria, ha rechazado una tercera opa de su rival estadounidense Prologis.",
    expectedTier: "discard",
    note: "Two foreign (UK/US) industrial REITs with no explicit Spanish-market angle in the story — foreign corporate news, so discard (operator call 2026-07-25). Not 'global': global requires a DIRECT Spanish effect, not an inferred one.",
  },
  {
    id: "disc-maresme-restaurant",
    title: "Adiós a uno de los chiringuitos más famosos del Maresme: este domingo cierra sus puertas para siempre",
    lede: "El restaurante La Caleta, en Sant Vicenç de Montalt (Maresme, Barcelona), cerrará tras 71 años.",
    expectedTier: "discard",
    note: "NUANCE — Catalonia geography but a restaurant closing: off real-estate topic, so discard.",
  },
  {
    id: "disc-barcelona-port",
    title: "El Puerto de Barcelona crece en tráfico pese al caos ferroviario, la peste porcina y la geopolítica",
    lede: "Hasta marzo las mercancías transportadas suben un 3,5% hasta los 35,87 millones de toneladas.",
    expectedTier: "discard",
    note: "NUANCE — Barcelona geography but port/logistics traffic: off real-estate topic, so discard.",
  },
  {
    id: "disc-galicia-promo",
    title: "Culmia invertirá 65 millones en una promoción en Galicia",
    lede: "Culmia compra a Aliseda un suelo en Sanxenxo para desarrollar un proyecto residencial.",
    expectedTier: "discard",
    note: "NUANCE — real-estate topic but Galicia (another region's purely local development), so discard.",
  },
  {
    id: "disc-andalucia-tower",
    title: "El dueño del mayor rascacielos de Andalucía prepara su salida a bolsa",
    lede: "El propietario de Torre Sevilla, el mayor rascacielos de Andalucía, prepara su salto a bolsa.",
    expectedTier: "discard",
    note: "NUANCE — real-estate topic but Andalucía (other-region local), so discard.",
  },
  {
    id: "disc-ortega-paris",
    title: "Amancio Ortega compra el complejo de oficinas parisino Capital 8 por un récord de 850 millones",
    lede: "El fundador de Inditex ha adquirido el complejo de oficinas Capital 8 de París.",
    expectedTier: "discard",
    note: "NUANCE — Spanish investor, but a Paris asset with no direct Spanish-market effect: discard, not global.",
  },
  {
    id: "disc-trump-tariffs",
    title: "Trump acelera sus nuevos aranceles",
    lede: "El subterfugio legal de la Casa Blanca choca con las garantías laborales en Canadá o la UE.",
    expectedTier: "discard",
    note: "Global trade/tariffs — off real-estate topic, so discard.",
  },
  {
    id: "disc-plan-auto",
    title: "El Gobierno aprueba el Auto+, las ayudas para comprar coche eléctrico o híbrido enchufable",
    lede: "Con hasta 4.500 euros de ayuda, la cuantía dependerá del origen, el precio y la motorización.",
    expectedTier: "discard",
    note: "National consumer subsidy but cars, not real estate — off topic, so discard.",
  },
];

// Pairwise orderings the rubric MUST preserve (US-06/US-08). Each: [mustRankHigher, mustRankLower].
export const EXPECTED_ORDERINGS: OrderingPair[] = [
  // Geography primary: Catalonia housing outranks Spain-wide housing.
  ["cat-vpo-restrictions", "nat-price-surge"],
  // On-topic Catalonia outranks off-topic Catalonia (US-06 spirit: Barcelona rental > local trivia).
  ["cat-hpo-conversion", "disc-maresme-restaurant"],
  // National housing regulation outranks another region's local development.
  ["nat-socimi-tax", "disc-galicia-promo"],
  // National mortgage news outranks off-topic global trade.
  ["nat-euribor", "disc-trump-tariffs"],
  // A national rental law (announced in Madrid) outranks an off-topic national car subsidy.
  ["nat-rental-extension", "disc-plan-auto"],
  // National housing outranks another region's local tower.
  ["nat-price-surge", "disc-andalucia-tower"],
];
