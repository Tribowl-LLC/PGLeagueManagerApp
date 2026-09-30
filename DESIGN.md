---
name: LeagueVault
description: Current production visual system for Familiar A public and bowler flows, plus the distinct incumbent admin interface.
colors:
  # Shared semantic defaults. Familiar A route-scoped colors are listed below.
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
  # Incumbent staff/admin canvas.
  app-shell: "#f8fafc"
  navigation-deep: "#0f172a"
  navigation-100: "oklch(96.8% 0.007 247.896)"
  navigation-200: "oklch(92.9% 0.013 255.508)"
  navigation-300: "oklch(86.9% 0.022 252.894)"
  navigation-400: "oklch(70.4% 0.04 256.788)"
  navigation-500: "oklch(55.4% 0.046 257.417)"
  navigation-800: "oklch(27.9% 0.041 260.031)"
  navigation-900: "oklch(20.8% 0.042 265.755)"
  # The blue-violet accent belongs primarily to staff/admin navigation.
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
  public-white: "#fff"
  public-focus: "#4d7db6"
  public-story-copy: "#d6e1ef"
  public-eyebrow: "#476889"
  public-success-surface: "#e5f4eb"
  public-success-text: "#166641"
  public-danger-surface: "#f9eae7"
  public-danger-border: "#ebd5d1"
  public-danger-copy: "#6e4c48"
  public-danger-strong: "#8e392f"
  public-danger-action: "#9b3d31"
  public-danger-action-hover: "#873329"
  public-danger-shadow: "rgb(155 61 49 / .16)"
  public-secondary-border: "#aebed0"
  public-link: "#204c7e"
  public-input-border: "#b9c7d6"
  public-placeholder: "#7c8ba0"
  # Familiar A authenticated bowler shell and Pay surfaces.
  familiar-navy: "#0f172a"
  familiar-ink: "#0f172a"
  familiar-muted: "#475569"
  familiar-line: "rgb(100 116 139 / 0.24)"
  familiar-surface: "#ffffff"
  familiar-canvas: "#f1f5f9"
  familiar-nav-active: "#0f172a"
  familiar-nav-active-surface: "rgb(15 23 42 / 0.08)"
  familiar-paid: "#166534"
  familiar-danger: "#dc2626"
typography:
  # Familiar A is the current public and bowler type system.
  body:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  label:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  public-wordmark:
    fontFamily: "Instrument Sans"
    fontSize: "27px"
  public-wordmark-mobile:
    fontFamily: "Instrument Sans"
    fontSize: "25px"
  public-story-min:
    fontFamily: "Instrument Sans"
    fontSize: "34px"
  public-story-max:
    fontFamily: "Instrument Sans"
    fontSize: "40px"
  public-title-min:
    fontFamily: "Instrument Sans"
    fontSize: "28px"
  public-title-max:
    fontFamily: "Instrument Sans"
    fontSize: "31px"
  public-body:
    fontFamily: "Instrument Sans"
    fontSize: "15px"
  public-label:
    fontFamily: "Instrument Sans"
    fontSize: "13px"
  public-eyebrow:
    fontFamily: "Instrument Sans"
    fontSize: "11px"
  # The incumbent authenticated admin interface retains its system-sans stack.
  admin-body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  admin-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  admin-section:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  admin-label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  admin-meta:
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
  public-shell: "14px"
  public-button: "8px"
  public-field: "7px"
  public-inset: "9px"
  public-progress: "4px"
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
    typography: "{typography.admin-label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.admin-label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.admin-label}"
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
    typography: "{typography.admin-meta}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  navigation-item:
    backgroundColor: "{colors.navigation-deep}"
    textColor: "{colors.navigation-300}"
    typography: "{typography.admin-label}"
    rounded: "{rounded.md}"
    padding: "0.625rem 0.75rem"
  bowler-mobile-navigation-item:
    backgroundColor: "{colors.familiar-surface}"
    textColor: "{colors.familiar-muted}"
    typography: "{typography.label}"
    rounded: "7px"
    padding: "0.5rem"
---

# Design System: LeagueVault

This document records the current production Familiar A design for public
account and authenticated bowler routes, alongside the distinct incumbent
admin interface. Production code is the behavioral and responsive source of
truth; this document records the current visual system. The standalone preview
is a fictional reference and experiment lab, not a production specification.
Future changes should preserve the product and accessibility constraints in
[`PRODUCT.md`](PRODUCT.md).

## Overview

**Admin design label: "The Quiet Operations Console."** This describes the
incumbent staff interface. Familiar A is the current public and bowler design.

LeagueVault has two distinct production interface systems. The staff/admin
application keeps its restrained operational layout, system-sans typography,
dark navy navigation, and blue-violet active accent. Public account pages and
authenticated bowler pages use Familiar A: Instrument Sans, a navy and cool
gray palette, responsive branded framing, and open, readable content surfaces.

The staff desktop experience is an admin console with a persistent dark
sidebar, sticky light header, responsive content area, tables, cards, forms,
and dialogs. The Familiar A bowler shell uses a centered Perfect Game logo on a
navy mobile brand bar, a league selector, and a four-item white bottom
navigation. At desktop widths it changes to a persistent navy sidebar and a
white league header. Public account pages use Familiar A's story-and-form
layout.

The Perfect Game assets are used as configured organization-facing branding
in the public and bowler flows. The navy and cool-gray Familiar A surfaces are
separate from the staff/admin interface's blue-violet active-navigation
accent.

**Key Characteristics:**

- Familiar A uses Instrument Sans, navy structure, cool-gray surfaces, and
  restrained borders and shadows.
- Public account pages use a desktop story panel and form canvas, collapsing
  to a compact branded navy bar on phones.
- Bowler navigation is responsive: a navy desktop sidebar or white mobile
  bottom bar, with a pale navy-gray active state.
- The separate admin interface retains its system-sans type, navy sidebar,
  and blue-violet active accent.
- Both systems favor readable operational content, semantic states, and
  modest corner rounding over decoration.

## Colors

The production palettes are scoped by interface. Familiar A public and bowler
pages use Instrument Sans with navy structure and cool-gray, white, and light
slate surfaces. The staff/admin interface retains the incumbent semantic
palette: navy carries structure and primary actions, while blue-violet marks
admin active navigation and focus. The CSS also contains a dark semantic theme
and extended state ramps; the admin shell uses fixed navigation and app-shell
tokens, so dark mode remains a partial capability rather than a fully
harmonized theme.

### Primary

- **Deep navy primary** (`hsl(222 47% 11%)` via `--primary`): Primary buttons,
  high-confidence actions, and strong emphasis.
- **Admin blue-violet active accent** (`oklch(58.5% 0.233 277.117)`): Active
  navigation, selected states, and focus emphasis in the incumbent staff/admin
  interface.
- **Familiar A navy active state** (`#0f172a`): Selected bowler navigation,
  primary actions, and structural emphasis in public and bowler flows.

### Neutral

- **White canvas** (`hsl(0 0% 100%)` via `--background`): Public-flow and
  component backgrounds.
- **Admin app shell** (`#f8fafc`): Cool-slate canvas behind white staff/admin
  surfaces.
- **Familiar A bowler canvas** (`#f1f5f9`): Overview background behind white
  content; Pay, History, and Profile use white page backgrounds.
- **White card** (`hsl(0 0% 100%)` via `--card`): Cards, dialogs, and elevated
  content surfaces.
- **Near-black body text** (`hsl(20 14.3% 4.1%)` via `--foreground`): Default
  readable text in the shared/admin component system; Familiar A uses its scoped
  navy ink color.
- **Navigation navy** (`#0f172a`): Persistent staff/admin desktop sidebar and
  mobile navigation sheet; Familiar A also uses navy for its mobile brand bar
  and desktop bowler sidebar.
- **Cool navigation gray** (`oklch(86.9% 0.022 252.894)` through
  `oklch(20.8% 0.042 265.755)`): Staff/admin sidebar text, borders, hover
  surfaces, and hierarchy.
- **Muted surface and text** (`hsl(60 4.8% 95.9%)` and
  `hsl(25 5.3% 44.7%)`): Secondary information, placeholders, and supporting
  copy in the shared/admin component system. Familiar A uses its route-scoped
  cool gray and muted tokens.

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

Familiar A is the default for public account and authenticated bowler pages.
The staff/admin interface retains its incumbent system-sans stack.

**Familiar A font:** Instrument Sans, with a system-sans fallback.

**Admin font:** `ui-sans-serif, system-ui, sans-serif`. Monospace appears only
where data presentation requires it, such as selected technical values or
payment details.

**Character:** Familiar A uses clear Instrument Sans headings and compact
supporting labels. The admin system remains compact and neutral, using modest
weight and size changes rather than expressive display typography.

### Hierarchy

- **Title** (semibold or bold, `text-2xl` / `1.5rem`): Page titles, card
  titles, and primary public-flow headings in each surface's scoped font.
- **Section** (semibold or bold, `text-lg` / `1.125rem`): Dialog titles,
  section headings, and grouped operational content.
- **Body** (normal, browser/Tailwind base size, approximately `1rem`): Main
  descriptions, form text, and data context.
- **Label** (medium, `text-sm` / `0.875rem`): Form labels, navigation labels,
  buttons, table headers, and compact controls.
- **Meta** (normal or medium, `text-xs` / `0.75rem`): Supporting metadata,
  timestamps, small status labels, and mobile navigation labels.

### Named Rules

**The Scoped Type Rule.** Use Instrument Sans in Familiar A public and bowler
surfaces, and the system-sans stack in the incumbent staff/admin interface.
Keep a restrained weight and size hierarchy, and do not introduce additional
fonts without a design decision.

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
- **Bowler shell:** The mobile layout uses a 76px navy logo bar, a separate
  league-selector row, a centered `max-w-4xl` content column, and fixed
  four-column bottom navigation with safe-area padding. From 1024px, it uses a
  navy sidebar and a white league header instead of the bottom bar; the sidebar
  is 204px through 1120px and 224px above that.
- **Public flows:** The shared Familiar A shell uses a 40/60 story-panel and
  form-canvas split, up to 1256px wide, with a 770px desktop minimum height
  capped by the viewport height.
  At 800px and below it becomes a full-height page with a 76px navy brand bar
  above the form canvas; the centered form column is up to 460px wide. Cards
  remain scoped content within that layout rather than defining the page shell.
- **Responsive behavior:** Tables remain horizontally scrollable when their
  data cannot collapse safely. Admin grids commonly move from one column to
  two, three, or six columns at `sm`, `md`, and `lg` breakpoints. Bowler flows
  prioritize touch targets, readable cards, and bottom navigation.
- **Rhythm:** The implementation primarily uses Tailwind's quarter-rem
  spacing scale, with recurring gaps and paddings of `0.5rem`, `0.75rem`,
  `1rem`, `1.5rem`, and `2rem`.

## Elevation & Depth

The incumbent admin interface uses a hybrid of tonal layering and restrained
elevation. The app shell is cool slate, content surfaces are white, the desktop
sidebar is dark navy, and borders carry much of the separation. Cards generally
use `shadow-sm`; interactive dashboard cards may move to `shadow-md`; the
sidebar uses a stronger `shadow-xl`. The admin header shadow is
`0 1px 2px rgba(0, 0, 0, 0.02)`. The legacy mobile-navigation utility retains
`0 -4px 12px rgba(0, 0, 0, 0.06)`, while the shipped Familiar A bowler
navigation overrides it with `0 -4px 12px rgb(100 116 139 / 0.08)`.

### Shadow Vocabulary

- **Admin app header:** `0 1px 2px rgba(0, 0, 0, 0.02)`; quiet separation from
  the scrolling content.
- **Legacy mobile-navigation utility:** `0 -4px 12px rgba(0, 0, 0, 0.06)`;
  retained as the global utility default.
- **Familiar A bowler mobile navigation:** `0 -4px 12px rgb(100 116 139 / 0.08)`;
  the route-scoped override separates the fixed bottom navigation from content.
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

The admin/shared default radius token is `0.5rem` (`8px`). Controls use `rounded-md`, which
resolves to `6px`; small controls and close buttons use `rounded-sm`, which
resolves to `4px`; cards use `rounded-lg`, which resolves to `8px`. Pills,
status chips, and progress indicators use fully rounded geometry. The bowler
dashboard hero and some prominent content cards use `rounded-2xl` (`16px`) as
a larger, friendlier exception. Familiar A's selected bottom-navigation item
uses a restrained `7px` radius, not the pill shape used by badges and progress
indicators.

Borders are generally one pixel and use semantic input, border, navigation, or
state colors. Form controls have a rectangular field silhouette with modest
rounding, while badges and compact status indicators are pill-shaped.

## Components

The following component recipes describe shared and incumbent admin defaults.
Public and bowler routes use their scoped Familiar A details where described
in the sections below.

### Buttons

- **Shape:** `rounded-md` (`6px`), with `h-10` (`40px`) as the default control
  height.
- **Primary:** Deep navy background, primary-foreground text, `0.5rem 1rem`
  padding, and a medium label. Admin controls use the system-sans stack;
  Familiar A controls inherit Instrument Sans from their scoped shell.
- **Destructive:** Destructive red background and foreground for irreversible
  or dangerous actions.
- **Secondary / Outline / Ghost:** Neutral surface with a border for outline
  actions; tonal hover surface for ghost actions; muted secondary fill where a
  lower-emphasis action is appropriate.
- **Hover / Focus:** Admin/shared control color transitions use approximately
  `200ms`. Admin focus uses a visible two-pixel ring with a two-pixel offset;
  Familiar A uses the visible, scoped focus treatment described in its route
  styles. Disabled buttons reduce opacity and disable pointer interaction.
- **Icon buttons:** Default icon buttons are `40px`; compact icon sizes of
  `24px` and `32px` are also used for dense toolbars.

### Badges and Chips

- **Style:** `rounded-full`, compact horizontal padding, `text-xs`, and
  semibold text. Background, border, and text colors come from the semantic
  state or navigation family.
- **State:** Use positive/success, warning/caution, danger, and pending tones
  according to meaning. Admin active context may use its blue-violet token;
  Familiar A bowler navigation uses a pale navy-gray fill with navy icon and
  text.

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

- **Admin/shared style:** Full width, `40px` high, `rounded-md`, one-pixel
  input border, background-colored fill, `0.5rem 0.75rem` padding, and
  `text-sm` content.
- **Focus:** Admin/shared controls use a visible two-pixel semantic ring with a
  two-pixel offset; do not rely on a subtle border-color change alone.
- **Error / Disabled:** Error messages use semantic destructive styling.
  Disabled controls reduce opacity and communicate the disabled state through
  native semantics as well as styling.
- **Provider exception:** Square payment fields and wallet buttons preserve
  provider-required styling and should not be normalized into ordinary product
  fields.

### Navigation

- **Admin desktop:** Fixed dark navy sidebar with `16rem` / `5rem` expanded and
  collapsed widths, `rounded-md` navigation rows, `0.75rem` horizontal
  padding, and `0.625rem` vertical padding. Active rows use a translucent
  blue-violet background and blue-violet text/icon.
- **Admin mobile:** The same dark navigation is presented in a left sheet.
- **Bowler mobile:** White bottom navigation has four equal columns. Active
  items use a pale navy-gray rounded background, navy icon and text, and a
  small label; inactive items use muted slate. Desktop bowler navigation is a
  separate navy sidebar.
- **Admin focus:** Navigation links use a visible accent ring with a
  dark-navigation offset on the desktop shell. Familiar A bowler controls use
  their scoped three-pixel focus ring, and desktop sidebar links use a white
  ring.

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

## Current production public account flows: Familiar A

The public welcome, registration, verification, sign-in, password recovery,
privacy, account-deletion, email-change, profile-report, and payment-partner
response screens use the shipped Familiar A system. Authenticated bowler pages
use the same system as described below; authenticated admin pages retain the
distinct incumbent system above.

- **Layout:** On desktop, a 40/60 split pairs a deep-navy story panel with a
  cool-slate form canvas. On mobile, the story collapses to a 76px navy bar;
  the welcome bar centers “League Manager,” while other public pages center
  the official Perfect Game dark-background logo.
- **Brand and type:** The desktop story says “League Manager” and “League
  payments, simplified.” Instrument Sans is scoped to public pages. The
  official Perfect Game assets remain the logo source.
- **Color and surfaces:** Navy `#0f172a` carries primary actions and chrome,
  `#f8fafc` carries the canvas, and white cards have restrained borders and
  shadows. Red and green are reserved for destructive and successful states.
- **Controls:** Inputs are at least 48px high, buttons at least 50px high,
  focus remains visible, and phone inputs use 16px text to avoid mobile zoom.
  The public page styles live in `client/src/components/public-page-layout.css`
  and are registered as scoped utilities in `client/src/index.css`.
- **Motion:** Cards enter with a short decelerating rise; reduced-motion
  preferences remove the animation. Status and error copy remain legible
  without motion.

## Current production authenticated bowler flows: Familiar A

Familiar A is the shipped production design for Overview, Pay, History,
Profile, and their current states. Production code defines the behavior and
responsive implementation. The standalone preview is a fictional reference
and experiment lab; it is not the behavioral or visual source of truth.
Mobile and desktop are both supported and use the same type, color, and
component system. This design remains distinct from the admin UI.

- **Shell:** Center the official Perfect Game dark-background logo in a navy
  header. Place the active league selector below it. Keep a white four-item
  bottom navigation for Overview, Pay, History, and Profile, with a restrained
  pale active state. Content scrolls independently of the navigation.
- **Desktop shell:** At widths of 1024px and above,
  use a persistent navy sidebar with the Perfect Game logo, League
  Manager label, Overview, Pay, and History links, and a bottom Profile row
  showing the bowler avatar and name. Use a white top bar with the current
  league name, team, and configured league start time; show a right-aligned
  Switch league control when league switching is available. The sidebar is
  204px through 1120px and 224px above that. Center Overview and
  Pay content in a compact rail. On wider desktop, give Pay's Automatic
  payments and checkout columns the same 112px separation as History; use a
  24px gap for both pages from 1024px through 1120px. Keep History in an
  approximately 802px rail with 270px totals and 420px transactions on wider
  desktop, and 240px totals from 1024px through 1120px. Keep Profile as a
  narrow focused stack. Preserve the mobile logo bar, league selector, and
  bottom navigation below the desktop breakpoint; tablet widths retain a
  compact overflow-safe layout.
- **Typography and surfaces:** Use Instrument Sans, navy `#0f172a`, white
  page backgrounds on Pay, History, and Profile, and the light-slate
  Overview background. Use open space for sections; frame only the cards and
  controls framed by the production interface. Financial amounts use natural proportional
  numerals and an ordinary-sized dollar sign. On desktop, use `#0f172a` for
  primary text and actions, `rgb(71 85 105 / 0.78)` for muted copy, and
  route-scoped cool-gray borders: `rgb(100 116 139 / 0.24)` by default,
  `0.26` for desktop Pay lines, and `0.34` on some shell/profile borders;
  strong Pay dividers use `0.38`. Use `#166534` for paid/success states and
  `#dc2626` for danger states. Keep
  provider-branded wallet controls in their provider colors.
- **Overview:** Keep the Payment overview card and Latest payment card.
  Season totals show Paid, Remaining, and Season, with Past Due inserted only
  when positive. Rotating bowlers see Paid and Past Due only. The next bowling
  date does not appear between these cards.
- **Pay:** On mobile weekly-payment pages, show the two-column Due now and
  Remaining summary first, followed by Automatic payments when eligible, then
  One-time payment. At desktop widths, keep the page title across the content
  rail; place Automatic payments in the left column and the Due now/Remaining
  summary above One-time payment in the right column. The two amounts stay
  side by side within the summary at both sizes. Upfront and rotating members
  use their existing mode-specific layouts.
  The shipped one-time-pay layout follows the preview's 1 Simple arrangement:
  the selector changes a single coverage sentence as weeks are added. Existing,
  2 Quick choices, and 3 Summary first in the standalone lab remain comparison
  experiments, not production layout variants. Double-pay weeks include the
  applicable final weeks. Saved-card selection
  also offers an available device wallet and a new-card path. Upfront leagues
  present one full-balance payment, including partner selection when eligible.
  Rotating bowlers see a one-time-only payment view without Due now/Remaining
  summary boxes or automatic-payment setup; its coverage sentence describes
  the selected number of weeks. Provider-generated wallet confirmation remains
  native to the provider.
- **League switching:** Across Overview, Pay, History, and Profile on mobile and
  desktop, use one centered modal with the preview's title, helper, close action,
  and open/close motion. Each option shows only the league name and season range;
  mark the selected option with a check and other options with a down chevron.
  Keep season suffixes when names repeat. List only active bowler memberships
  in active leagues. Archived leagues do not appear in the switcher; this does
  not change existing direct links to archived History views. Preserve each
  page's existing selection, URL, storage, and payment-intent behavior.
- **History:** Show a Weeks paid line (`x/y weeks`) above the Season totals,
  using active canonical obligations rather than money or weekly-fee math.
  Follow it with Transactions. A confirmed self-only payment covering several
  canonical weeks names that count, and includes the server-confirmed final
  paired week when present. Keep single-week, shared, credit, and review rows'
  existing truthful labels. Rotating bowlers see Paid and Past Due only, with
  no Weeks paid line. Keep the real transaction evidence and detail actions.
- **Profile:** Present account details as rows and use focused dialogs for
  editing details, changing a password, managing saved payment methods and
  payment-partner links, and requesting deletion. Put Request deletion below
  Payment-partner links and Sign out alone at the bottom. Password fields have
  accessible show/hide controls.
- **Boundaries:** Keep current loading, error, authorization, payment quote,
  idempotency, and account-security behavior. Production code remains the
  source of truth for existing exceptional-state and recovery behavior when
  those details are not described here.

## Do's and Don'ts

### Do:

- **Do** use shared semantic tokens from `client/src/index.css` and the
  existing Familiar A scoped stylesheets instead of inventing one-off colors.
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

- **Don't** carry the incumbent authenticated-page styling into Familiar A
  public or bowler pages, or apply Familiar A styling to admin pages without a
  separate design decision.
- **Don't** replace Familiar A's Instrument Sans or the admin interface's
  system-sans stack without a design decision. Avoid decorative display
  treatment in routine operations.
- **Don't** use danger, warning, success, or information colors decoratively or
  interchangeably.
- **Don't** remove semantic labels, focus states, responsive behavior, or
  loading/empty/error/recovery states while changing visual styling.
- **Don't** normalize Square wallet and payment-provider controls without
  checking their provider requirements.
