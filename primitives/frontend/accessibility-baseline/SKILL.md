---
id: frontend.accessibility-baseline
title: Accessibility baseline
module: frontend
summary: Keyboard, focus, labels and announcements; the four fixes that make a UI usable and are not retrofittable.
obligation: "In {project}, the main {primary} journey completes with a keyboard and a screen reader, including its error states, before any styling is called finished."
tier_min: 1
cost: low
priority: 4
tags: [accessibility, a11y, keyboard, screen-reader, wcag, ux]
triggers: [accessibility, a11y, keyboard, screen reader, wcag, focus]
enforces: [ui.accessibility]
artifacts: [05-verification.md]
---

# Accessibility baseline

Accessibility is usually treated as a compliance topic. It is a quality topic: a UI that cannot be driven by keyboard, that has unlabelled controls and invisible focus, is a UI with broken input handling. The people it locks out are the people most likely to be persistent users, and the fixes are cheapest before the components exist.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the main {primary} journey completes with a keyboard and a screen reader, including its error states, before any styling is called finished.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any project with a UI. Four items cover most of the value, and all four are cheap.

## The practice

1. **Semantic elements first.** A `<button>` for actions, `<a>` for navigation, real `<label>` for inputs, headings in order. ARIA is a patch, not a foundation: prefer the native element.
2. **Keyboard operability.** Every interactive element is reachable and operable by keyboard, in a sensible order, with no traps. Test the primary journey with the mouse unplugged.
3. **Visible focus.** Never `outline: none` without a replacement. Focus must be visible at all times, and move deliberately after a dialog opens or a validation fails.
4. **Announce changes.** Validation errors are associated with their field and announced; loading and error states are announced politely; toasts are not the only channel.
5. **Contrast and target size.** Body text at 4.5:1, large text at 3:1, targets at least 24×24px (44×44 for touch).
6. **Never encode meaning in colour alone.** Add text, icon or pattern.

## Checklist

- [ ] Primary journey completable with keyboard only.
- [ ] Every input has a programmatically associated label.
- [ ] Focus is visible everywhere, and managed after navigation and dialogs.
- [ ] Error messages are announced and focus moves to the first invalid field.
- [ ] Contrast meets 4.5:1 for body text.
- [ ] Images have alt text, or are marked decorative.
- [ ] One automated check (axe) in CI catches the regressions that are mechanical.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A dialog that does not move focus.
- An error announced only visually.
- `outline: none` with no replacement.
- Icon-only buttons with no accessible name.
- Axe configured so that it fails on nothing.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| Accessibility is a later polish pass. | Focus and labels are structural; retrofitting is a rewrite. | Build the keyboard path first. |
| We will test with a screen reader before launch. | Before launch is release week. | Keyboard-only pass on the primary journey each pull request. |
| Placeholder text works as a label. | It disappears the moment someone types. | Programmatic label, always. |
| Contrast is a design concern. | It is a testable failure. | 4.5:1 in the token set. |
| Focus outlines look bad. | Removing them removes the keyboard. | Style them; never remove them. |

## Anti-patterns

- **A `div` with an onClick.** Not focusable, not announced, not a button.
- **`aria-label` everywhere instead of visible text.** Screen-reader-only usability, sighted-user confusion.
- **An accessibility audit at the end.** Retrofitting focus management means rewriting components.
- **A screen-reader-only checkbox in a custom control.** The pattern exists; use it, do not invent it.

## Why it works

The four baseline items are the same work as making the UI operable: labels, focus, order, feedback. They also catch a class of bug that affects everyone — a modal that traps focus incorrectly traps it for mouse users too, just less visibly.

## Cost and when to skip

Low if done with the component: minutes. High if retrofitted: a component rewrite. Automated tools catch perhaps a third of issues, so one keyboard walkthrough per journey is still required.
