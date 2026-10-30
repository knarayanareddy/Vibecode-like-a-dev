---
id: frontend.design-system-tokens
title: Design tokens and UI consistency
module: frontend
summary: One token source for colour, space and type, so generated components cannot drift apart.
obligation: "In {project}, colour, spacing and type for every {primary} screen come from one token source, so a raw literal is a build failure rather than a preference."
tier_min: 1
cost: medium
priority: 4
tags: [frontend, design-system, design-tokens, css, consistency, ui]
triggers: [design system, design tokens, styling, css variables, consistent ui, theme]
enforces: [ui.design-tokens]
artifacts: [03-architecture.md, 05-verification.md]
---

# Design tokens and UI consistency

Generated UIs are locally reasonable and globally inconsistent: three greys, four corner radii, five spacing values, two button heights. Each component was written in isolation and each made a sensible choice. Together they look like a product assembled from samples.

Design tokens fix this with one indirection: components reference named decisions, never raw values.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, colour, spacing and type for every {primary} screen come from one token source, so a raw literal is a build failure rather than a preference.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any project with a UI: web, mobile, or a desktop app.

## The practice

1. **Define tokens once**, in one file, in three layers:
   - Primitives: the palette and scale (`color.blue.500`, `space.4`).
   - Semantic: meaning (`color.action.primary`, `color.text.muted`, `surface.raised`).
   - Component: only where a component genuinely needs its own (`button.height.md`).
2. **Reference semantic tokens in components**, never primitives and never literals.
3. **Enforce it mechanically**: a lint rule or grep gate that fails on `#rrggbb`, `rgb(`, and hard-coded `px` in spacing.
4. **Define states as tokens too**: hover, focus, disabled, error. Missing states are why generated UIs feel unfinished.
5. **One layout primitive per pattern.** A `Stack`/`Grid` beats ad-hoc margins in every component.

```css
:root {
  --color-text: #1a1a1a;        /* primitive */
  --color-text-muted: #5c5c5c;  /* semantic */
  --space-2: 8px; --space-3: 12px;
}
.button { background: var(--color-action-primary); padding: var(--space-2) var(--space-3); }
```

## Checklist

- [ ] One token file, three layers, no duplicates.
- [ ] Components use semantic tokens only.
- [ ] Focus, hover, disabled and error states are defined for interactive elements.
- [ ] A check fails the build on raw colour or spacing literals.
- [ ] Token names describe intent, not appearance (`muted`, not `grey3`).
- [ ] Dark mode, if promised, is a second set of semantic values, not a second component set.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A colour literal in a component file.
- Token names that describe appearance.
- Focus or disabled states left undefined.
- Two token files.
- Dark mode implemented inside component logic.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We will extract tokens once the UI settles. | The UI settles when the tokens exist. | One file before the first component. |
| A hex value in one component is harmless. | It is the first of many. | Fail the build on raw literals. |
| Semantic names are overkill. | `grey3` becomes wrong on the second theme. | Name tokens by intent. |
| Dark mode is a second set of components. | Then the sets drift apart. | A second set of values for the same tokens. |
| The token check is noisy. | Because it is working. | Fix the component, not the check. |

## Anti-patterns

- **A token file with 400 entries and no usage.** Tokens that nothing references are a mood board.
- **Components importing primitives directly.** Then semantics do not exist and theming breaks.
- **Hex values in a component "just this once".** There is no once; there is the first of many.
- **A component library adopted before one screen works.** You will customise it anyway.

## Why it works

Consistency is a property of indirection. With tokens, changing the product's look is one file, and a new component is consistent by default rather than by care. It also gives review something objective to check, which matters when most of the UI was generated.

## Cost and when to skip

Medium: half a day for the initial set, and a lint rule. At tier 0, three tokens and a rule are still worth it; without any indirection, every future change is a hunt.
