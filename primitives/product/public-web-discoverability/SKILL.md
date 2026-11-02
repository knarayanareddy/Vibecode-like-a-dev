---
id: product.public-web-discoverability
title: Public web discoverability
module: product
summary: Declare which public routes may be discovered and make canonical URLs, metadata and structured data testable product contracts.
obligation: "In {project}, the public routes that explain {aPrimary} have an explicit, testable contract for indexability, canonical URLs, metadata and truthful structured data."
tier_min: 0
cost: low
priority: 2
tags: [public-web, discoverability, indexability, canonical, metadata, structured-data]
triggers: [seo, discoverability, indexability, canonical url, sitemap, robots, metadata, structured data, llms.txt]
enforces: [web.discoverability]
artifacts: [01-product-brief.md, 04-contracts.md, 05-verification.md]
---

# Public web discoverability

A public website has two route sets, not one. A marketing page or documentation page may be designed for discovery; an account, administration, preview, search-result or transaction page normally is not. Treating every route as crawlable leaks private/duplicate surfaces, while treating nothing as public makes the product hard to find. The boundary is a product decision that implementation must preserve.

This practice deliberately covers engineering truth, not search-engine promises. It does not promise a rank, traffic, indexing, an AI citation or a score. It defines the locally testable facts: which route classes are public and indexable, which canonical URL represents each resource, which routes are excluded, and whether metadata and structured data match the page a visitor receives.

## In this product

> In {project}, the public routes that explain {aPrimary} have an explicit, testable contract for indexability, canonical URLs, metadata and truthful structured data.

Name the public origin, route classes, locale behavior and exclusions in the brief before implementation. The contract belongs to the product owner: an engineering tool must never infer that an internal dashboard or a preview route ought to be discoverable.

## When this applies

Only when the profile declares all three facts: `kind: "web-app"`, `risks.publicFacing: true`, and `discoverability.enabled: true`. It is deliberately skipped for APIs, native/mobile clients, internal tools, private dashboards and public applications whose owner has not opted into a discovery surface.

## The practice

1. **Classify routes before adding tags.** List indexable route classes such as marketing, documentation, help, pricing or public content. Separately list excluded classes such as account, administration, previews, user-specific search, staging and error routes.
2. **Choose exactly one public identity per indexable resource.** A canonical URL is an ownership claim: protocol, hostname, path, locale and trailing-slash policy must agree with redirects, sitemap entries and rendered links.
3. **Make metadata a rendered contract.** Test a representative route of every indexable class for title, description, canonical URL and social metadata. Test an excluded route for its noindex/absence behavior as declared.
4. **Keep structured data truthful and narrow.** Emit only types and properties visible in the rendered page and owned by the application. Structured data is not a place to claim reviews, prices, authorship, availability or organization facts that the page cannot substantiate.
5. **Keep external claims advisory.** `robots.txt`, sitemaps, `llms.txt`, crawler behavior and third-party tools are delivery evidence, not compiler authority. Record the exact local or deployed check that supports a release decision.

## Checklist

- [ ] The public canonical origin and indexable route classes are written down.
- [ ] Account, administration, preview, search-result and error routes are explicitly classified rather than accidentally included.
- [ ] Every indexable route has one canonical URL consistent with links, redirects and sitemap policy.
- [ ] Representative route tests assert rendered title, description, canonical and social metadata.
- [ ] Structured-data assertions prove each emitted claim appears in the rendered page or maintained source of truth.
- [ ] A change to a public route, metadata template, route policy or locale policy names the discoverability evidence it re-ran.

## Red flags

- `robots.txt`, sitemap entries and canonical links describe different route sets.
- An authenticated page, preview URL or user-specific search result appears in a discovery artifact.
- A generic metadata template gives multiple pages the same canonical URL or title.
- JSON-LD advertises a rating, price, author or organization fact that the page does not show.
- A ranking screenshot is offered as evidence in place of a repeatable route-level check.

## Anti-rationalization

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We can add SEO tags after the site is built. | Route identity and rendering choices become expensive to untangle after pages are public. | Declare public and excluded route classes with the first route. |
| Every public URL should be indexed. | Publicly reachable does not mean suitable for discovery or canonicalization. | Classify account, preview, filter and error routes explicitly. |
| Schema markup makes the page discoverable. | Structured data cannot repair an ambiguous or duplicate route and false claims are a liability. | Test canonical and rendered content first; add only truthful structured data. |
| The provider will decide what to index anyway. | Third parties decide outcomes, but the application owns the signals it emits. | Verify the locally controlled route, metadata and sitemap contract. |
| We need an SEO score before we can ship. | Scores are changing heuristics, not an engineering definition of done. | Use falsifiable route-level assertions and review external findings separately. |

## Anti-patterns

- **Sitewide copy-paste metadata.** One title, description and canonical URL silently represent unrelated pages.
- **Indexing authenticated surfaces.** URLs that require a session, carry user data or create side effects become accidental public contracts.
- **Structured-data theater.** Markup makes claims that no rendered content or maintained system can support.
- **Crawler access as a compiler input.** A live fetch, provider response or ranking snapshot changes a deterministic packet.

## Why it works

A small public-route contract makes discoverability reviewable in ordinary engineering work. It catches the failures a team controls—duplicate identities, wrong route exposure, missing rendered metadata and untruthful machine-readable claims—without pretending that a compiler can predict a search result.

## Cost and when to skip

Low for a public documentation or marketing surface: one route inventory and a few representative rendering assertions. Skip it unless the product owner explicitly declares an indexable public web surface. Do not apply it to an API, a private dashboard or a web application whose public reachability is not a product goal.
