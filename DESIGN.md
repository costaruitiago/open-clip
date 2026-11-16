# Design System: Edit Bay

This document codifies the design language and implementation patterns for the studio interface. It is a living document intended to guide all future UI work.

**Source of truth**: `frontend/src/index.css`. The values below mirror what ships. When the two disagree, the stylesheet wins and this document is the thing that needs fixing.

## Philosophy: Quiet Chrome, Loud Footage

The interface is a tool for creators turning long recordings into short clips. Its character is exact, unhurried and editorial: a night edit bay rather than a dashboard.

- **The clips carry the colour.** Every page is mostly footage. The chrome around it (navigation, buttons, panels) stays graphite and hairline so the frames read first.
- **One accent, used rarely.** The brand ember marks what is happening now, or the exception. Nothing else is orange.
- **Hierarchy from size and colour, not weight.** Weights are 400 and 500, with 600 only for the wordmark. Sentence case everywhere.
- **The readout is the signature.** Timecodes, Jev scores, counts and file names are set in the system monospace with tabular figures, like the readouts on an edit bay.

Quiet is not an excuse for an inaccessible interface. Where the two conflict, contrast wins. See [Accessibility Floor](#accessibility-floor).

## Foundation

### Colors

A graphite ramp with no tint, because any hue in the surfaces would fight the footage. Every colour that carries text is chosen to clear 4.5:1 against the surface it sits on, in **both** themes.

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--bg` | `#FAFAFA` | `#141415` | Page surface |
| `--bg-raised` | `#FFFFFF` | `#19191B` | Cards, menus, controls |
| `--bg-secondary` | `#F4F4F5` | `#232325` | Selected rows, hover, recessed panels |
| `--text` | `#171717` | `#EDEDED` | Primary text |
| `--text-secondary` | `#525252` | `#A1A1A6` | Secondary text, nav items |
| `--text-muted` | `#737373` | `#85858B` | Meta and captions only |
| `--text-disabled` | `#737373` | `#85858B` | Dead text, see below |
| `--hairline` | text at 10% | text at 8% | `--border-color`, every border |
| `--hairline-strong` | text at 18% | text at 16% | Inputs, hovered cards, dashed drop zones |
| `--accent` | `#C42F00` | `#FF7A52` | 5.3:1 / 7.3:1. Pairs with `--on-accent` |
| `--success` | `#16A34A` | `#4CC38A` | Pairs with `--on-success` |
| `--error` | `#DC2626` | `#E5484D` | |
| `--warning` | `#D97706` | `#E09A00` | Partly done. Text form is `--warning-text` |

**On the accent.** The brand orange is `#C42F00`, darkened from the `#FF3E00` this document specified for years, which was 3.36:1 on the page and failed AA everywhere it was applied. The dark theme lifts it to `#FF7A52` for the same reason in reverse.

**On disabled text.** Fading text with `opacity` is how a checked colour silently stops passing. Dead text keeps a checked contrast and says it is dead some other way: no underline, `cursor: not-allowed`, and a label that names the precondition. The `opacity: 0.5` in `button:disabled` fades a whole control, which is a different job.

**What each colour means.** The palette is small enough that each colour has to mean one thing, everywhere:

- `--accent`: **happening now, or the exception.** A running pipeline step, a clip being cut, a clip whose captions or overlay title are unlocked from the project's, the publish action on a clip card, a highlight's hook and social copy.
- `--success`: **finished, and not undoable from here.** A done pipeline step's dot, captions burned into a file, a clip Postiz has published. Publication to YouTube is deliberately *not* in this list: the application cannot see a video deleted on YouTube afterwards, so any badge claiming a clip is published goes stale silently.
- `--error`: **failed, or about to destroy something.** A failed step, a failed save, delete.

A state that is none of these is not coloured. Neutral is the default and stays the majority of the page.

**Tints, not fills.** A state rarely fills a whole control. A running or failed pipeline step takes an 8% `color-mix` tint of its colour with the colour as text, and done or partial steps keep the neutral surface with a status dot. Solid fills are reserved for the primary button.

**Accent and error are adjacent hues.** Because of that, **status must never be conveyed by colour alone**. Every status surface also carries a text label. See `statusLabel()` in `PipelineController.tsx`.

### Typography

- **Interface**: the system UI font (`system-ui`). No web fonts and no external requests
- **Readouts**: the system monospace (`ui-monospace`) with `tabular-nums`, through the `.mono` class or `--font-mono`, for timecodes, scores, counts, dates in meta lines and file names
- **Scale**:
  - Body: `14px`, line height 1.45
  - Secondary and meta: `12px` to `13px`
  - `h1`: `clamp(1.75rem, 3vw, 2rem)`, 500 weight, `-0.01em` tracking
  - `h2`: `1.25rem`, 500 weight
  - `.wordmark`: `1rem`, 600 weight. It repeats on every route and must not compete with the page `h1`
- **No uppercase labels, no wide tracking, no italic for emphasis.** Letter spacing is 0 under 16px.
- **Nothing under 12px** in the interface. Captions and titles rendered over the picture are content, not interface, and follow their own styling.

### Spacing

A 4px grid. These are the shipped values:

- `--space-xs`: `4px`
- `--space-sm`: `8px`
- `--space-md`: `12px`
- `--space-lg`: `16px`
- `--space-xl`: `32px`

Space inside a group is smaller than space between groups. Do not hard-code spacing in component styles; every literal is a token that failed to get used.

### Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `6px` | Tags, keycaps, small buttons |
| `--radius` | `8px` | Buttons, inputs, selects, nav items |
| `--radius-lg` | `12px` | Cards, panels, alerts, menus |
| `--radius-xl` | `16px` | The upload drop zone |

Nested radius: inner = outer minus the padding between them, never below 4px. The clip card's media is `11px`: the card's 12px less its 1px border.

## Patterns

### Containers & Borders

- **Borders**: use the `--border` token (`1px solid var(--hairline)`). Inputs and hovered cards take `--hairline-strong`.
- **Containers**: a card is `--bg-raised`, a hairline and `--radius-lg`. Avoid a bordered block inside a bordered block; separate regions inside a card with a single hairline rule instead.
- **Shadows**: only on things that float over the page, like menus and modals, through `--shadow-float`. Nothing at rest has a shadow, and nothing glows. On dark, depth comes from the surface steps.

### Layout

Reflowing layouts live in `index.css`, because inline styles cannot express media or container queries. Use the existing classes rather than re-typing them inline:

- `.card-grid` — `auto-fill`, 300px track minimum
- `.split-grid` — `auto-fit`, 320px track minimum
- `.social-grid` — `auto-fit`, 180px track minimum
- `.pipeline-steps` — `auto-fit`, 140px track minimum: the pipeline when it *is* the page (a project with no highlights yet)
- `.pipeline-strip` — the same pipeline as a tool on a page about something else: a flex row of label-width buttons with the run-everything button among them, one line on any normal window. `PipelineController` takes `prominence="compact"` for it, and on the project page it is folded behind a trigger in `.project-tools` — the pipeline runs once, so on a project that has already run it earns no permanent height. The trigger carries a `.status-badge` with whatever the row would have said, and the panel opens itself when a step starts running or fails
- `.project-actions` / `.nav-action` — the pipeline, the project settings, the writing, the export and delete, in the primary bar beside the navigation. `.project-actions__menu--wide` is the writing's: long-form content, so it is wider and takes a `max-height` with its own scrollbar. All three act on the whole project rather than on anything in view, so they are chrome; they render only on a project route. The pipeline opens as a menu that hangs over the page (`.project-actions__menu`) rather than reflowing it
- `.project-detail` / `.project-clips` — the project page. It is the clip grid and nothing else: every control belonging to the project is in the primary bar, the title is `.visually-hidden` (the breadcrumb draws the name, with `aria-current`), and there is no readout counting what is already visible below it. It was a two-column split with a sticky aside holding the source video, which took 40% of the row and half the fold for the one video on the page nobody needs to watch
- `.clip-manager` — wraps the clip grid and overrides its track from the project's target aspect ratio, so a portrait project gets narrow tracks and a landscape one wide

Every grid track minimum is wrapped in `min(Npx, 100%)`. This is what stops a fixed minimum from overflowing a viewport narrower than the minimum, and it is the reason to use the class instead of an inline `minmax(300px, 1fr)`.

### Buttons & Interactivity

Use the `Button` component (`components/Button.tsx`). Variants: `primary`, `ghost`, `danger`. Sizes: `sm`, `md`, `lg`.

- **Primary**: a `--text` fill with `--bg` text. One per view at most.
- **Ghost**: `--bg-raised`, a hairline and `--text`. The default for secondary actions.
- **Danger**: `--error` text on a transparent ground, with an `--error` tint on hover.
- **Navigation and project actions** (`.nav-action`): borderless `--text-secondary` text that takes a `--bg-secondary` surface on hover or when its menu is open.
- **Icon buttons on clip cards** are borderless and `--text-secondary`. Colour on one of them is a state, never decoration.
- **Hover**: a surface step (`--btn-hover-bg`). Nothing moves on hover.
- **Active**: `scale(0.98)`.
- **Disabled**: `opacity: 0.5` and `not-allowed`, from the base `button:disabled` rule. Do not write it inline. Hover and active are suppressed for disabled buttons.
- **Selects** use `.options-bar__select`, which carries the whole geometry. Do not re-type it inline.
- **Say why it is disabled.** A disabled button's label, or its tooltip where the control is an icon, is where the reason lives.
- **Icons** are inline line SVGs at 16px with a 1.5 stroke in `currentColor`. No emoji or text glyphs (`✕`, `▼`, `📅`) as icons.

### Links

There is one rule for `a`, in `index.css`: `--text-accent`, underlined. The application had none for a long time, so every link rendered in the user agent's `#0000EE` — 2.3:1 on the dark theme's background, and a blue that belongs to no palette here.

### Status Indicators

Use the `.status-badge` class. It fixes the geometry (1px `--hairline-strong` border, 4px corners, 12px, 500 weight) so every state reads as the same object. Pipeline steps carry a 6px status dot ahead of their name, coloured through the `--step-dot` custom property: green done, amber partly done, a hairline ring still to do, and the accent for running.

Always pair the colour with a text label.

### Motion

- **Easing**: one curve, `--ease-out-quart`, now `cubic-bezier(0.22, 1, 0.36, 1)`. Nothing overshoots.
- **Duration**: 150ms for hover, press and colour changes, 180ms for menus, 300ms for entrances.
- **Entrances**: one short fade and 8px rise. Staggers are 50ms and stop after six items.
- **Nothing loops unless it is live.** The running step's dot breathes and a spinner turns while work runs; nothing else repeats. The pipeline finishing is said once, by a flat green wash that fades.
- **Transition named properties only**, never `all`. Animate `transform` and `opacity`, never `width`, `height`, `top` or `left`.
- **`prefers-reduced-motion: reduce` is honoured globally** in `index.css`.

### Accessibility Floor

Non-negotiable, and checked at review:

- **Contrast**: 4.5:1 for text, 3:1 for non-text and focus indicators, in both themes.
- **Touch targets**: 44×44px minimum on coarse pointers. With a mouse, compact controls may be 36px; the `(pointer: coarse)` rules in `index.css` restore 44px.
- **Focus**: `:focus-visible` is a 2px `--accent` outline at 2px offset, defined globally. Do not remove it or override it per-component.
- **Status is never colour-only**: pair every colour-coded state with text.
- **Every working region is named**: a bare `<section>` is neither a landmark nor a heading. Give it an `aria-labelledby` pointing at a real heading — `.visually-hidden` where the design does not want a visible one — or a screen reader's heading and landmark lists are both empty.
- **Disabled means a disabled control**: `aria-disabled` on a `<span>` does nothing. A span has no role for the state to attach to, and it is not in the tab order.
- **Opacity is not a styling tool on text.** Fading a label is how a contrast-checked colour silently stops passing.

## Enforcement

See `frontend/src/INTERACTION_GUIDELINES.md` for the interaction rules that gate code review (no `window.alert` / `confirm` / `prompt`; all confirmations are in-UI, keyboard accessible, ARIA-labelled).
