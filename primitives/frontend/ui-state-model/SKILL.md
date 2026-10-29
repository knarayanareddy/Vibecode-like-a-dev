---
id: frontend.ui-state-model
title: UI state model: loading, empty, error, success
module: frontend
summary: Define four states per screen before building it; the missing three are what make a product feel broken.
tier_min: 1
cost: low
priority: 4
tags: [ui, ux, states, loading, empty-state, error-handling]
triggers: [loading state, empty state, error state, ui states, spinner, ux polish]
enforces: [ui.states, ux.error-taxonomy]
artifacts: [05-verification.md, 01-product-brief.md]
---

# UI state model

Generated screens are built for the success case: data arrives, it renders, it looks finished. Then the list is empty, the request is slow, the server is down, and the screen shows a spinner forever or a blank panel.

Every data-driven screen has four states. A screen with one state is a mockup.

## When this applies

Any UI that reads data from outside the component.

## The practice

1. **Enumerate the states before building**: loading, empty, error, success. Add partial-success and stale-data if the screen refreshes.
2. **Design each state**, not just the success one:
   - Loading: skeleton or reserved space so layout does not jump; appear only after ~150ms to avoid flicker.
   - Empty: explain what would be here and give exactly one next action.
   - Error: say what failed in user terms, offer retry, preserve user input.
   - Partial: show what succeeded and mark what did not, rather than failing the whole screen.
3. **Classify errors** into user-correctable (inline, near the field), retryable (banner with retry), and unexpected (generic message + support code with the correlation ID). Never render a raw exception.
4. **Model state explicitly** as a discriminated union rather than three booleans: `{status: 'loading'} | {status: 'error', error} | {status: 'ready', data}`. Impossible states then cannot be rendered.
5. **Test the states**, not just the happy path: force each one in a story or a test.

## Checklist

- [ ] Every data screen has all four states, designed.
- [ ] Empty state has one clear next action.
- [ ] Error state offers retry and keeps user input.
- [ ] State is a discriminated union, not `isLoading` + `hasError` + `data`.
- [ ] Unexpected errors show a support code, not a stack trace.
- [ ] Loading does not cause layout shift; skeletons match final layout.

## Anti-patterns

- **A spinner as the error state.** Users wait forever for a failure.
- **`if (error) return null`.** A blank screen with no explanation is the worst available state.
- **Empty state that says "No data".** It answers nothing and suggests nothing.
- **Three booleans.** They permit `isLoading && hasError && data`, which you will eventually render.
- **Retry that reloads the whole page.** It discards the user's work.

## Why it works

The success path is the part a model can infer from the shape of similar apps; the failure paths are the part that requires knowing your users. Writing them down also surfaces backend requirements early: if the UI needs to distinguish a 403 from a 500, the API must not collapse them into one error.

## Cost and when to skip

Low: the states are cheap to design and expensive to retrofit onto components built for the happy path. Skip the partial-success state for v1; never skip error and empty.
