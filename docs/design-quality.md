# Design quality bar

Omnifin treats interface quality as product behavior, not decoration added after an
API works. This document lets a contributor decide whether a user-facing slice is
ready for review.

## Visual direction

The design language is a **cinematic control room with adaptive liquid materials**:
artwork-derived colour, editorial typography, precise operational telemetry, and
technical depth that appears only when it is relevant. Dark mode uses OLED blacks and
controlled luminous accents. Light mode uses cool paper-like canvases and crisp,
low-chroma surfaces. Both modes preserve the same hierarchy and product identity.

Reusable behavior may come from accessible primitives, but appearance is authored
for Omnifin. Default component-library styling, generic dashboard cards, excessive
glass, and decorative motion do not meet the bar.

The material model is informed by Apple's published
[Liquid Glass introduction](https://developer.apple.com/videos/play/wwdc2025/219/) and
[Human Interface Guidelines for materials](https://developer.apple.com/design/human-interface-guidelines/materials),
then authored specifically for Omnifin rather than reproducing platform controls.

## Liquid material hierarchy

Liquid Glass is an interaction material, not a blur effect applied to every card.
Omnifin uses three deliberate layers:

1. **Content:** artwork, posters, text-heavy forms, tables, and long reading surfaces
   use opaque or nearly opaque standard materials. They remain stable and readable.
2. **Navigation and controls:** the rail, mobile navigation, search control, service
   pulse, profile control, and other floating command surfaces use regular liquid
   material. Ambient artwork colour may tint them subtly.
3. **Overlays:** search results, profile controls, drawers, and comparative workbenches
   use a thicker liquid material so text remains legible over changing content.

Glass surfaces use adaptive tint, saturation, an inner highlight, a defined edge, and
a restrained cast shadow. The optical edge is directional: a bright upper rim and
internal caustic imply incoming light, while the opposite edge carries a darker rim
and cast shadow. Backdrop saturation preserves colour passing through the material
without sacrificing local text contrast. Concentric geometry makes adjacent radii
feel cut from one shape. A glass surface is not nested inside another glass surface;
content inside an overlay returns to standard fills. Accent tint is reserved for
selection, status, or the primary action.

On pointer-capable devices, one passive document listener updates only the active
glass surface once per animation frame. Its specular highlight and rim illumination
follow the local pointer position, providing a restrained approximation of the
environment-responsive light play of a physical lens. Touch does not need this hover
feedback, and reduced motion suppresses it. The effect never changes hit geometry or
becomes necessary to understand state.

Poster rails remain part of the continuous content canvas. They have no container
fill of their own, and their scrollport reserves enough transparent optical space for
the fixed lift and scale of a focused card—including unusually wide cards at browser
zoom—so neither the transformed edge nor its shadow is clipped.

Motion may make a liquid control scale, blur, or morph to explain where an overlay
came from. It may not distort content, delay input, or continuously shimmer. Where
`backdrop-filter` is unavailable, the same components fall back to an opaque semantic
surface rather than becoming transparent.

## Appearance modes

Users can choose **System**, **Light**, or **Dark**. System is the default and follows
live operating-system colour-scheme changes. An explicit choice is stored only as a
same-site preference cookie so the server can render the correct theme before
hydration; it is not identity data and is not sent to an external service.

Every component consumes semantic canvas, text, line, fill, accent, and material
tokens. A theme is incomplete if it merely inverts the page background while leaving
hard-coded panel colours behind. Visual and accessibility checks cover representative
routes in both themes. The implementation also honours increased contrast, forced
colours, reduced motion, and reduced transparency; reduced transparency removes blur,
ambient noise, and nonessential aurora layers.

## State completeness

Every reusable component and route must deliberately cover:

- normal and selected;
- loading with a skeleton matching final geometry;
- empty with a useful next action;
- stale or offline with data age and recovery guidance;
- recoverable and terminal error;
- permission denied without exposing unavailable data;
- disabled or unsupported capability; and
- responsive desktop, tablet, mobile, and 10-foot layouts.

A feature is incomplete when only its populated happy path is designed.

## Interaction model

- Drawers preserve browsing context for deep comparison and technical work.
- Modals are reserved for short decisions that genuinely block progress.
- A command palette exposes expert shortcuts without crowding ordinary navigation.
- Poster rails, tables, calendars, drawers, and player controls support keyboard,
  touch, mouse, and directional navigation.
- Directional focus is scoped to a visible control group: left and right move within
  horizontal actions, up and down move within vertical navigation or operation lists,
  and calendar movement follows rendered geometry. Edge presses retain focus instead
  of falling through to page scrolling. Text-editing arrows remain available inside
  non-empty search fields.
- Touch targets are at least 44 by 44 CSS pixels. Focus is visible, unobscured, and
  restored logically after an overlay closes. Mobile scrollports reserve the sticky
  command bar and fixed navigation as focus-safe areas; directional browser tests
  verify focused posters and operation rows remain fully visible between them in
  accordance with WCAG 2.4.11.
- Destructive actions state their scope and consequence, require appropriate
  confirmation, and remain idempotent or guarded by current-state preconditions.

Operational controls stay quiet while systems are healthy. Activity, warning state,
or explicit user intent may progressively reveal rates, provenance, diagnostics, and
recovery actions.

## Motion

Motion explains hierarchy, causality, or spatial continuity. It must be
interruptible, and exits are shorter than entrances. Contextual icon swaps favour
opacity, scale, and a small blur over rotating unrelated glyphs. Press feedback is
subtle. Layout should not shift after data arrives.

`prefers-reduced-motion` removes nonessential travel, parallax, and sequencing while
preserving immediate state feedback. No workflow depends on an animation completing.

## Typography and telemetry

Editorial display type creates hierarchy; a highly legible sans-serif carries
navigation, metadata, and controls. Rates, ETAs, storage, dates, episode numbers, and
progress use tabular numerals. Labels use plain language before service-specific
jargon. Truncation never hides the only copy of essential information.

Icons are optically aligned and always have an accessible name when they carry
meaning. Radii are concentric across nested surfaces. Shadows are restrained and
layered rather than used as a substitute for hierarchy.

The standard profile is designed for desktop, tablet, and handheld use. A deployment
intended for television-distance viewing sets `OMNIFIN_DISPLAY_PROFILE=ten-foot`.
That explicit profile increases the inherited type scale, focus ring, control targets,
calendar metadata, and operational telemetry; viewport width alone never assumes the
viewer is across a room. Route tests may request the same profile only while the
server-gated test mode is active.

Deterministic visual fixtures use original CSS artwork treatments—contour, archive,
aperture, monolith, signal, and bloom—plus an explicit fallback. They make busy-art
contrast and artwork-derived colour review possible without network requests or
third-party media.

## Accessibility gate

The target is WCAG 2.2 AA. Review includes semantic landmarks, headings, form labels,
error association, contrast, zoom and reflow, screen-reader announcements, focus
order, keyboard and directional operation, target size, reduced motion, and
accessible authentication. Status is never conveyed by colour alone.

Automated accessibility tests are release blockers, but automated checks do not
replace manual keyboard, screen-reader, zoom, and high-contrast review.

## Performance gate

Representative production routes target:

- Lighthouse score of at least 90 for performance;
- Lighthouse score of at least 95 for accessibility and best practices;
- LCP at or below 2.5 seconds, INP at or below 200 milliseconds, and CLS at or below
  0.1 in the test profile; and
- no more than 250 KiB of compressed initial dashboard JavaScript.

Lighthouse CI measures LCP and CLS directly and uses Total Blocking Time at or below
200 milliseconds as the repeatable lab regression proxy for interaction latency. It
does **not** claim to measure INP: INP requires real interactions over a page visit and
is evaluated from browser field tooling in deployment-specific acceptance testing.
Omnifin does not collect or transmit field measurements because telemetry remains
disabled by default. The product target remains INP at or below 200 milliseconds.

The player, manual-search workbench, expanded calendar, and administrative tools are
loaded on demand. Images are sized, responsive, and lazy-loaded outside the initial
viewport. Server-state requests run in parallel when independent and are cancelled
when no longer useful.

## Three-pass review

Every vertical slice completes three deliberate passes:

1. **Interaction and composition:** task flow, hierarchy, state model, input methods,
   and responsive structure.
2. **Visual and motion refinement:** typography, colour, surfaces, optical alignment,
   illustration or artwork treatment, and purposeful transition details.
3. **Resilience review:** accessibility, performance, loading, empty, offline, error,
   permission, unsupported, and reduced-motion behavior.

Storybook stories cover every meaningful component state. Interaction and automated
accessibility tests run against those stories. Playwright visual baselines are
deterministic and screenshot changes require explicit review. Route-level browser
tests and manual inspection complete the evidence.

Route-level test mode is explicit and server-environment gated. It exercises both populated
demo views and production-first onboarding or unconfigured views without making
fixture selection available in ordinary deployments. Visual snapshots include the
rendering platform in their filename; a platform is supported in CI only after its
baseline has been generated and reviewed on that platform.

Route snapshots cover configured and first-run surfaces plus representative loading,
empty, quiet, offline, terminal-error, expanded-operation, and focus-visible states on
desktop and phone geometry. The 10-foot profile remains covered by its configured,
first-run, and authentication routes together with directional interaction assertions.

Darwin baselines are reviewed and committed with the foundation slice. Linux baselines
remain an explicit CI follow-up: the first Linux run uploads actual renderings for
manual inspection, and only reviewed images are committed. CI never auto-accepts a
cross-platform screenshot change.
