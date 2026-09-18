# Frontend UI Design Workflow

This is the repository workflow for creating, redesigning, and materially
refining the frontend. It keeps product truth, design truth, implementation,
motion, and rendered QA separate while giving them an explicit handoff order.

The default pipeline is:

```text
frontend-app-builder
  -> Impeccable
  -> find-animation-opportunities
  -> transitions-dev
  -> transitions-polish
  -> frontend-testing-debugging
```

The pipeline is conditional by scope. It is the required default for new
surfaces, redesigns, restyles, modernizations, and other UI work large enough
to establish or change a visual system. A small fix inside an established
design system should use only the stages that can materially improve that
fix.

## Design authority and repository artifacts

Keep these concerns in separate artifacts:

| Artifact | Owns | Does not own |
| --- | --- | --- |
| `PRODUCT.md` | Users, product purpose, workflows, positioning, durable constraints, confirmed product facts, and accessibility commitments | Visual styling, component recipes, or implementation procedure |
| `DESIGN.md` | The incumbent or approved visual system: typography, color and surface treatment, spacing, layout, component patterns, responsive behavior, interaction principles, and motion principles | Product claims, agent orchestration, or every implementation lint rule |
| `docs/ui-design-workflow.md` | The sequence, stage ownership, handoffs, approval gates, conditional stages, and QA evidence | Product or visual decisions for a particular screen |
| `AGENTS.md` | The short mandatory routing rule that makes this workflow discoverable to agents and contributors | The full workflow or a duplicate design system |
| `docs/lint.md` and source code | Enforceable implementation constraints, theme tokens, shared variants, and component contracts | The complete rationale for the product's visual direction |

When `PRODUCT.md` or `DESIGN.md` is missing, do not treat the repository as a
blank slate. Inspect the existing product, routes, components, tokens, and
rendered UI. Impeccable's `init` captures durable product context, while
`document` can record the incumbent UI before a redesign replaces or evolves
it. Do not invent product claims, testimonials, metrics, or capabilities.

## Scope gates

| Work type | Required path | Notes |
| --- | --- | --- |
| New app, new major surface, redesign, restyle, or modernization | Full pipeline below | Concept approval is required before implementation proceeds. |
| Targeted UI refinement inside the existing system | Impeccable targeted work → applicable motion stages → frontend testing | Skip `frontend-app-builder` unless a new visual direction or concept is needed. |
| UI change with no motion or state-transition impact | Design stage → frontend testing | Skip animation discovery and transition implementation/polish. |
| Backend-only or non-rendered change | Repository engineering workflow | Do not invoke the UI pipeline. |
| Mobile, touch, PWA, full-screen, sheet, carousel, or phone-specific work | Add `mobile-native` before final device QA | The phone and a real device, not desktop emulation, are the source of truth. |

The workflow should be thorough for major surfaces without forcing expensive
concepting or motion work onto a one-line UI fix. When a stage is skipped,
record the reason in the task handoff or completion report.

## Stage 0: Load context and define the surface

Before design work:

1. Inspect the active worktree, branch, status, target route or component, and
   existing UI state.
2. Read `PRODUCT.md` and `DESIGN.md` when present. If either is absent, treat
   code and rendered UI as evidence of the incumbent rather than permission to
   invent facts or visual direction.
3. Read the relevant frontend rules in `AGENTS.md`, `docs/lint.md`, and the
   existing shared components, theme tokens, and responsive conventions.
4. Define the surface, user goal, primary flow, required states, responsive
   targets, and acceptance evidence.
5. For Impeccable work, run its context loader once per session and follow the
   selected command's reference instructions before editing UI.

The surface brief must identify whether the work is primarily `Persuade`,
`Operate`, `Read`, or `Experience`. App and dashboard work is normally
`Operate`; a marketing page for the same product may be `Persuade`.

## Stage 1: `frontend-app-builder`

Use this stage for new or substantially redesigned visual surfaces.

Responsibilities:

- Create a complete, readable visual concept for the requested surface before
  implementation. Include required downstream sections, states, responsive
  continuation, and detail views rather than only a hero or header.
- Preserve the product information architecture, supplied copy, required
  workflows, and existing technical constraints. Image generation must not
  invent unrelated product claims, navigation, metrics, or capabilities.
- Obtain design approval before treating the concept as the implementation
  specification.
- Extract the approved system: typography, colors, spacing, radii, elevation,
  component families, variants, icon treatment, asset roles, responsive rules,
  and initial motion cues.
- Implement the accepted design faithfully in the repository's existing
  framework, routing, component, styling, accessibility, and asset conventions.

Handoff to Impeccable:

- accepted concept or reference screenshots;
- exact visible copy and required states;
- extracted tokens and component inventory;
- affected routes and responsive targets;
- known deviations or unresolved design decisions.

The accepted concept is a design authority. Do not allow a later stage to
silently replace its hierarchy, copy, visual world, or interaction model. If
Impeccable identifies a structural or visual-direction change, pause for
approval and record the revised concept as the new authority before coding
continues.

For a small refinement inside an established system, this stage may be
skipped. Do not generate a competing concept merely to make a small fix look
more elaborate.

## Stage 2: Impeccable

Use Impeccable to make the approved surface coherent, usable, accessible, and
faithful to the product. It is the design-direction and craft review stage,
not a license to introduce a second unrelated visual system.

Depending on the request, use its appropriate mode or command:

- `shape` for UX and UI planning before code;
- `new-work` for a new visual world or major replacement surface;
- `critique` for a heuristic design review;
- `audit` for accessibility, responsive, and technical quality checks;
- `polish`, `layout`, `typeset`, `clarify`, `harden`, or `animate` for scoped
  improvements.

Responsibilities:

- Resolve hierarchy, information architecture, cognitive load, copy clarity,
  accessibility, responsive behavior, and edge states.
- Respect `PRODUCT.md`, the accepted concept, user-provided constraints, and
  existing business facts.
- Preserve the repository's shared component contracts and declared theme
  tokens. A redesign may deliberately change tokens and variants, but that
  change must be explicit and browser-verified.
- Keep visual QA bounded: inspect the completed surface in a batched pass,
  fix the material findings, and perform at most one confirmation pass.

Handoff to animation discovery:

- the static and interactive surface exists in code;
- loading, empty, success, validation, error, open, close, and selected states
  relevant to the target have been identified;
- the design direction and component boundaries are settled;
- accessibility and reduced-motion expectations are known.

If Impeccable changes the approved visual direction, update the accepted design
spec and, when the change is durable, `DESIGN.md`. Do not leave the code,
concept, and design document describing different systems.

## Stage 3: `find-animation-opportunities`

Run this as a read-only motion gate after the target UI and its meaningful
states exist.

The skill must:

- inspect the actual surface and existing motion vocabulary;
- search for feedback gaps, teleporting state, missing spatial relationships,
  group entrances, and gesture seams;
- reject high-frequency or information-dense motion that would make the
  product slower or harder to use;
- cap the surviving list and provide exact properties, duration, easing,
  reduced-motion behavior, and hover capability gates;
- include rejected candidates and the reason each failed the gate.

It does not edit source code. Only approved opportunities move to the next
stage. If no candidate survives, skip transition implementation and record
that restraint is the result.

## Stage 4: `transitions-dev`

Use `transitions-dev` only for the approved motion opportunities. Match the
transition to the UI element and interaction story; do not install the entire
catalog or add motion because a snippet exists.

Implementation rules:

- Prefer existing project conventions and plain CSS for simple transitions.
- Install the selected transition's variables and CSS once; do not duplicate
  the universal motion-token block or create parallel token names.
- Preserve the documented HTML/state hooks and the full
  `prefers-reduced-motion` guard.
- Animate `transform` and `opacity` where appropriate; avoid `transition: all`
  and unrelated layout animation.
- Keep the diff scoped to the approved motion and its necessary orchestration.

Because `transitions-dev` and `transitions-polish` both use the
`transitions review` wording, invoke this stage explicitly as
“use `transitions-dev` to apply [the selected transition]” or use its
`transitions apply` command. Do not rely on an ambiguous generic “review my
transitions” request when both skills are installed.

Handoff to motion polish:

- the selected transitions are implemented;
- the affected states work in the real component;
- reduced-motion behavior is present;
- no unrelated CSS or component refactor is mixed into the motion diff.

## Stage 5: `transitions-polish`

Use `transitions-polish` after motion exists to normalize and refine it. This
stage is about timing quality, not discovering or installing new transition
recipes.

It should evaluate:

- duration, distance, scale, blur, and easing against the usage;
- open/close asymmetry;
- hover-in versus hover-out behavior;
- stagger totals and intent delays;
- whether a value has a legitimate matching token at all.

The skill must propose changes and receive confirmation before editing. If the
project does not already import its motion-token root, offer a one-time
installation in the project's global stylesheet or a single dedicated motion
token file. Never duplicate the token block. Use the explicit
`transitions-polish` skill name when requesting this stage to avoid the command
overlap described above.

## Stage 6: `frontend-testing-debugging`

Use this as the final rendered validation stage, and also during implementation
when a visible regression needs immediate feedback.

The final check must define the target flow and verify:

1. the intended route and page identity;
2. meaningful content renders and no framework error overlay appears;
3. relevant console errors and warnings are resolved or explained;
4. the core interaction produces the expected visible state;
5. desktop and at least one mobile-sized viewport when practical;
6. no clipping, overlap, overflow, unreadable text, missing assets, broken
   focus behavior, or scroll traps are present;
7. the accepted concept and latest rendered screenshot agree on copy, layout,
   typography, palette, spacing, assets, responsive behavior, and motion.

Use the Browser plugin first when it is available. If it is unavailable or a
permitted fallback is required, use Playwright and record the reason. Do not
write screenshots, traces, or temporary reports into the repository unless the
task explicitly requests committed artifacts.

`frontend-app-builder`'s concept-to-screenshot fidelity check and Impeccable's
bounded visual review remain required; this final stage adds independent
rendered interaction, console, responsive, and browser evidence. A passing
build alone is not visual QA.

## Supporting skills and cross-cutting checks

These skills support the pipeline when their concern is present; they are not
additional mandatory stages for every UI task:

- `pick-ui-library`: invoke before adding a UI dependency. Inspect
  `package.json` first and preserve existing libraries when they already solve
  the problem. Do not replace the repository's existing shadcn/Radix stack by
  default.
- `mobile-native`: invoke for touch, phone, PWA, safe-area, viewport, keyboard,
  sheet, carousel, or full-screen behavior. Verify applicable fixes on real
  hardware.
- `build-web-apps:react-best-practices`: use after meaningful React component,
  rendering, data-fetching, or performance changes.
- `build-web-apps:shadcn`: use when adding, composing, debugging, or changing
  shadcn components and variants.
- `docs/lint.md`: follow its design-system rules for theme tokens, typed
  variants, shared components, static classes, and responsive states.

After changing shared components, variants, theme values, or dependencies, run
the repository's uncached `npm run lint` in addition to the focused tests and
rendered QA appropriate to the surface.

## Definition of done

A UI task is ready for handoff when:

- the applicable stages and skipped stages are recorded;
- the product and design decisions have an identified source of truth;
- the accepted concept or scoped design decision is implemented without
  unapproved visual drift;
- motion is purposeful, restrained, tokenized where appropriate, and accessible;
- responsive and relevant mobile behavior has been checked;
- the core interaction and rendered screenshots provide evidence;
- focused checks, lint, and tests required by the changed files have passed or
  their limitations are reported;
- temporary concept or QA artifacts are not left in the repository unless they
  are intentional project assets.
