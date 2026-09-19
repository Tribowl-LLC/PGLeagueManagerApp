---
name: LeagueVault
description: Incumbent UI baseline for bowling league operations and bowler self-service.
colors:
  background: "hsl(var(--background))"
  foreground: "hsl(var(--foreground))"
  primary: "hsl(var(--primary))"
  primary-foreground: "hsl(var(--primary-foreground))"
  card: "hsl(var(--card))"
  card-foreground: "hsl(var(--card-foreground))"
  muted: "hsl(var(--muted))"
  muted-foreground: "hsl(var(--muted-foreground))"
  border: "hsl(var(--border))"
  input: "hsl(var(--input))"
  ring: "hsl(var(--ring))"
  app-shell: "#f8fafc"
  navigation-deep: "#0f172a"
  navigation-100: "oklch(96.8% 0.007 247.896)"
  navigation-200: "oklch(92.9% 0.013 255.508)"
  navigation-300: "oklch(86.9% 0.022 252.894)"
  navigation-400: "oklch(70.4% 0.04 256.788)"
  navigation-500: "oklch(55.4% 0.046 257.417)"
  navigation-800: "oklch(27.9% 0.041 260.031)"
  navigation-900: "oklch(20.8% 0.042 265.755)"
  brand-accent-50: "oklch(96.2% 0.018 272.314)"
  brand-accent-400: "oklch(67.3% 0.182 276.935)"
  brand-accent-500: "oklch(58.5% 0.233 277.117)"
  brand-accent-600: "oklch(51.1% 0.262 276.966)"
  brand-accent-700: "oklch(45.7% 0.24 277.023)"
  danger-500: "oklch(63.7% 0.237 25.331)"
  danger-700: "oklch(50.5% 0.213 27.518)"
  positive-500: "oklch(69.6% 0.17 162.48)"
  positive-700: "oklch(50.8% 0.118 165.612)"
  success-500: "oklch(72.3% 0.219 149.579)"
  warning-400: "oklch(82.8% 0.189 84.429)"
  warning-600: "oklch(66.6% 0.179 58.318)"
  caution-400: "oklch(85.2% 0.199 91.936)"
  info-500: "oklch(62.3% 0.214 259.815)"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  section:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "calc(var(--radius) - 4px)"
  md: "calc(var(--radius) - 2px)"
  lg: "var(--radius)"
  xl: "0.75rem"
  2xl: "1rem"
  full: "9999px"
spacing:
  space-1: "0.25rem"
  space-2: "0.5rem"
  space-3: "0.75rem"
  space-4: "1rem"
  space-6: "1.5rem"
  space-8: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    height: "2.5rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.lg}"
    padding: "1.5rem"
  badge:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.meta}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  navigation-item:
    backgroundColor: "{colors.navigation-deep}"
    textColor: "{colors.navigation-300}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.625rem 0.75rem"
---

# Design System: LeagueVault

This document records the current visual system extracted from the committed
client implementation. It is an incumbent baseline for review, not approval
of the future redesign direction. A future redesign should preserve the
product and accessibility constraints in [`PRODUCT.md`](PRODUCT.md), then
replace this baseline after a new visual world is explicitly approved.

## Overview

**Creative North Star: "The Quiet Operations Console"** *(descriptive label
for the incumbent system; not an approved future visual direction.)*

The current interface is restrained, utility-first, and built for repeated
operational work. It uses white and cool-slate surfaces, dark navy structural
chrome, and a blue-violet accent for active and focus states. The visual
hierarchy comes from spacing, modest type-weight changes, borders, and tonal
separation rather than decorative imagery or expressive typography.

The desktop experience is an admin console with a persistent dark sidebar,
sticky light header, responsive content area, tables, cards, forms, and dialogs.
The bowler experience is more phone-oriented: a compact white header, centered
content, and a four-item bottom navigation. Public account flows use a
centered white card on a plain background and can adopt organization-provided
logos.

The LeagueVault logo asset itself is a high-contrast, engraved bowling emblem
in slate, navy, and off-white. The application shell currently uses a related
navy/cool-neutral foundation but its active accent is a separate blue-violet
token family. This relationship should be treated as an incumbent observation
to evaluate during redesign, not as a requirement to preserve unchanged.

**Key Characteristics:**

- Cool neutral surfaces and dark navy structural chrome.
- Blue-violet accent for active, focus, and primary action states.
- Compact-to-medium operational density with small-to-medium rounded corners.
- Restrained borders and shadows; depth is mostly tonal.
- Responsive desktop admin shell and mobile bowler navigation.

## Colors

The incumbent palette is semantic and state-oriented: light neutral surfaces
carry most of the interface, navy carries structure and primary actions, and a
blue-violet accent identifies active navigation and focus. The CSS also
contains a dark semantic theme and extended state ramps, but the current shell
uses several fixed navigation and app-shell tokens, so dark mode should be
considered a partial incumbent capability rather than a fully harmonized theme.

### Primary

- **Deep navy primary** (`hsl(222 47% 11%)` via `--primary`): Primary buttons,
  high-confidence actions, and strong emphasis.
- **Blue-violet active accent** (`oklch(58.5% 0.233 277.117)`): Active
  navigation, selected states, and accent emphasis.

### Neutral

- **White canvas** (`hsl(0 0% 100%)` via `--background`): Public-flow and
  component backgrounds.
- **Cool app shell** (`#f8fafc`): The admin and bowler application canvas
  behind white surfaces.
- **White card** (`hsl(0 0% 100%)` via `--card`): Cards, dialogs, and elevated
  content surfaces.
- **Near-black body text** (`hsl(20 14.3% 4.1%)` via `--foreground`): Default
  readable text.
- **Navigation navy** (`#0f172a`): Persistent desktop sidebar and mobile
  navigation sheet.
- **Cool navigation gray** (`oklch(86.9% 0.022 252.894)` through
  `oklch(20.8% 0.042 265.755)`): Sidebar text, borders, hover surfaces, and
  hierarchy.
- **Muted surface and text** (`hsl(60 4.8% 95.9%)` and
  `hsl(25 5.3% 44.7%)`): Secondary information, placeholders, and supporting
  copy.

### State colors

- **Danger red** (`oklch(63.7% 0.237 25.331)`): Destructive actions, errors,
  and pending-work badges.
- **Positive green** (`oklch(69.6% 0.17 162.48)`): Healthy, paid, or successful
  states.
- **Success green** (`oklch(72.3% 0.219 149.579)`): Success messaging and
  confirmation accents.
- **Warning amber** (`oklch(82.8% 0.189 84.429)` through
  `oklch(66.6% 0.179 58.318)`): Attention and past-due states.
- **Caution yellow** (`oklch(85.2% 0.199 91.936)`): Pending or review-needed
  states.
- **Information blue** (`oklch(62.3% 0.214 259.815)`): Informational feedback
  and provider status where used.

### Named Rules

**The Status-by-Meaning Rule.** State colors communicate operational meaning;
they are not decorative accents. Preserve distinct danger, success, warning,
caution, and information roles when adding or redesigning components.

## Typography

**Display Font:** None; the incumbent uses the system sans stack.

**Body Font:** `ui-sans-serif, system-ui, sans-serif`.

**Label/Mono Font:** Labels use the same system sans stack. Monospace appears
only where data presentation requires it, such as selected technical values or
payment details.

**Character:** The type system is compact, neutral, and highly legible. It
uses weight and size changes to separate operational hierarchy, not a custom
editorial face or expressive display treatment.

### Hierarchy

- **Title** (semibold or bold, `text-2xl` / `1.5rem`): Page titles, card
  titles, and primary public-flow headings.
- **Section** (semibold or bold, `text-lg` / `1.125rem`): Dialog titles,
  section headings, and grouped operational content.
- **Body** (normal, browser/Tailwind base size, approximately `1rem`): Main
  descriptions, form text, and data context.
- **Label** (medium, `text-sm` / `0.875rem`): Form labels, navigation labels,
  buttons, table headers, and compact controls.
- **Meta** (normal or medium, `text-xs` / `0.75rem`): Supporting metadata,
  timestamps, small status labels, and mobile navigation labels.

### Named Rules

**The Utility-First Type Rule.** Use the system sans stack and a restrained
weight/size hierarchy. Do not introduce display typography into operational
surfaces without an approved redesign direction.

## Layout

- **Admin shell:** A fixed desktop sidebar is `16rem` wide when expanded and
  `5rem` when collapsed. The sidebar is hidden below the `md` breakpoint and
  replaced by a left-side mobile sheet that is `18rem` wide.
- **Admin header:** The content header is sticky, `4rem` high, white, and
  separated from the content by a cool navigation border. It uses `1rem`
  horizontal padding on small screens and `2rem` from `md` upward.
- **Admin content:** The scrollable content area uses `1rem`, `1.5rem`, and
  `2rem` padding at small, medium, and large breakpoints. The inner content is
  centered with the `max-w-350` utility (approximately `87.5rem`).
- **Bowler shell:** The bowler layout uses a centered `max-w-4xl` content
  column, a compact `3.5rem` top header, and a fixed four-column bottom
  navigation with safe-area padding.
- **Public flows:** Login, registration, password, and verification screens
  use a centered `max-w-md` card with `1rem` outer padding and a mobile-first
  top alignment that centers at the `sm` breakpoint.
- **Responsive behavior:** Tables remain horizontally scrollable when their
  data cannot collapse safely. Admin grids commonly move from one column to
  two, three, or six columns at `sm`, `md`, and `lg` breakpoints. Bowler flows
  prioritize touch targets, readable cards, and bottom navigation.
- **Rhythm:** The implementation primarily uses Tailwind's quarter-rem
  spacing scale, with recurring gaps and paddings of `0.5rem`, `0.75rem`,
  `1rem`, `1.5rem`, and `2rem`.

## Elevation & Depth

The incumbent uses a hybrid of tonal layering and restrained elevation. The
app shell is cool slate, content surfaces are white, the desktop sidebar is
dark navy, and borders carry much of the separation. Cards generally use
`shadow-sm`; interactive dashboard cards may move to `shadow-md`; the sidebar
uses a stronger `shadow-xl`. The explicit global header shadow is
`0 1px 2px rgba(0, 0, 0, 0.02)` and the mobile bottom-navigation shadow is
`0 -4px 12px rgba(0, 0, 0, 0.06)`.

### Shadow Vocabulary

- **App header:** `0 1px 2px rgba(0, 0, 0, 0.02)`; quiet separation from the
  scrolling content.
- **Mobile navigation:** `0 -4px 12px rgba(0, 0, 0, 0.06)`; separation above the
  fixed bottom navigation.
- **Card rest state:** Tailwind `shadow-sm`; low-contrast lift for white cards
  above the app shell.
- **Interactive card state:** Tailwind `shadow-md`; used selectively on
  hoverable dashboard cards.
- **Sidebar:** Tailwind `shadow-xl`; establishes the fixed navigation plane.

### Named Rules

**The Tonal-First Rule.** Establish hierarchy with surfaces and borders before
adding stronger shadows. Elevation should clarify a plane, dialog, or active
interaction rather than decorate a routine data surface.

## Shapes

The default radius token is `0.5rem` (`8px`). Controls use `rounded-md`, which
resolves to `6px`; small controls and close buttons use `rounded-sm`, which
resolves to `4px`; cards use `rounded-lg`, which resolves to `8px`. Pills,
status chips, progress indicators, and selected mobile-navigation backgrounds
use fully rounded geometry. The bowler dashboard hero and some prominent
content cards use `rounded-2xl` (`16px`) as a larger, friendlier exception.

Borders are generally one pixel and use semantic input, border, navigation, or
state colors. Form controls have a rectangular field silhouette with modest
rounding, while badges and compact status indicators are pill-shaped.

## Components

### Buttons

- **Shape:** `rounded-md` (`6px`), with `h-10` (`40px`) as the default control
  height.
- **Primary:** Deep navy background, primary-foreground text, `0.5rem 1rem`
  padding, medium system-sans label, and a slightly darker/lighter hover
  treatment through the primary token.
- **Destructive:** Destructive red background and foreground for irreversible
  or dangerous actions.
- **Secondary / Outline / Ghost:** Neutral surface with a border for outline
  actions; tonal hover surface for ghost actions; muted secondary fill where a
  lower-emphasis action is appropriate.
- **Hover / Focus:** Color transitions use approximately `200ms`. Focus uses a
  visible two-pixel ring with a two-pixel offset. Disabled buttons reduce
  opacity and disable pointer interaction.
- **Icon buttons:** Default icon buttons are `40px`; compact icon sizes of
  `24px` and `32px` are also used for dense toolbars.

### Badges and Chips

- **Style:** `rounded-full`, compact horizontal padding, `text-xs`, and
  semibold text. Background, border, and text colors come from the semantic
  state or navigation family.
- **State:** Use positive/success, warning/caution, danger, and pending tones
  according to meaning. Active bowler context uses a pale blue-violet fill with
  a stronger accent dot or icon.

### Cards / Containers

- **Corner Style:** `rounded-lg` (`8px`) by default; larger bowler summary
  cards may use `rounded-2xl` (`16px`).
- **Background:** White card over the cool-slate app shell, or semantic state
  tints for success, positive, and danger variants.
- **Shadow Strategy:** `shadow-sm` at rest; interactive cards may use
  `shadow-md` on hover. Borders remain part of the component identity.
- **Border:** One-pixel semantic border, with state-specific border opacity for
  success, positive, and danger cards.
- **Internal Padding:** `1.5rem` by default, with `1rem`, `1.25rem`, or
  responsive reductions for compact and mobile contexts.

### Inputs / Fields

- **Style:** Full width, `40px` high, `rounded-md`, one-pixel input border,
  background-colored fill, `0.5rem 0.75rem` padding, and `text-sm` content.
- **Focus:** Visible two-pixel semantic ring with a two-pixel offset; do not
  rely on a subtle border-color change alone.
- **Error / Disabled:** Error messages use semantic destructive styling.
  Disabled controls reduce opacity and communicate the disabled state through
  native semantics as well as styling.
- **Provider exception:** Square payment fields and wallet buttons preserve
  provider-required styling and should not be normalized into ordinary product
  fields.

### Navigation

- **Desktop:** Fixed dark navy sidebar with `16rem` / `5rem` expanded and
  collapsed widths, `rounded-md` navigation rows, `0.75rem` horizontal
  padding, and `0.625rem` vertical padding. Active rows use a translucent
  blue-violet background and blue-violet text/icon.
- **Mobile admin:** The same dark navigation is presented in a left sheet.
- **Bowler mobile:** White bottom navigation has four equal columns. Active
  items use a pale blue-violet rounded background, stronger blue-violet icon
  and text, and a small label; inactive items use navigation gray.
- **Focus:** Navigation links use a visible accent ring with a dark-navigation
  offset on the desktop shell.

### Dialogs and Sheets

- **Dialogs:** White or semantic-background surface, `max-w-lg`, `1.5rem`
  padding, `rounded-lg` from `sm` upward, a dark translucent full-screen
  overlay, and Radix state animations for fade, zoom, and slide.
- **Sheets:** Use the same overlay and state animation vocabulary. Navigation
  sheets use the dark navy sidebar treatment; functional sheets use the
  standard background surface.
- **Motion:** Opening is generally more deliberate than closing for sheets;
  preserve reduced-motion behavior from the global stylesheet.

### Tables

- **Structure:** Full-width, horizontally scrollable table wrapper with
  `text-sm` content, `1rem` cell padding, `3rem` header height, and a one-pixel
  row divider.
- **State:** Rows use a subtle muted hover surface; selected rows use muted
  background. Cell tones support muted, destructive, success, and subtle
  variants.

## Do's and Don'ts

### Do:

- **Do** use semantic CSS tokens from `client/src/index.css` instead of
  inventing one-off colors.
- **Do** preserve the distinction between dark navigation chrome, light
  content surfaces, and semantic state colors.
- **Do** make keyboard focus visible with the established ring-and-offset
  treatment.
- **Do** keep admin and bowler responsive behavior distinct where their usage
  scenes differ.
- **Do** use borders and tonal layering before stronger shadows on operational
  content.
- **Do** honor reduced-motion behavior and provider-required payment control
  styling.

### Don't:

- **Don't** treat this incumbent palette or layout as the approved future
  visual world; replace it only after an explicit redesign direction is
  chosen.
- **Don't** introduce a new font family, decorative display treatment, or
  marketing-style visual language into routine operations without updating the
  design direction first.
- **Don't** use danger, warning, success, or information colors decoratively or
  interchangeably.
- **Don't** remove semantic labels, focus states, responsive behavior, or
  loading/empty/error/recovery states while changing visual styling.
- **Don't** normalize Square wallet and payment-provider controls without
  checking their provider requirements.
