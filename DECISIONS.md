# DECISIONS.md — Little Slate House Website Build

Decisions made autonomously during the build (2026-06-20). Recorded here so you can review and redirect.

---

## Stack & tooling

**Astro 5 + Tailwind CSS v4**
Chosen per the brief. Tailwind v4 uses CSS `@import "tailwindcss"` rather than a config file — the v4 approach is simpler and faster. No config file needed.

**`serve` for static file preview**
Used `npm install -g serve` to serve the built `dist/` folder on port 4321. This is a simple, dependency-free approach. For production, the site goes to Cloudflare Pages (see BUILD-REPORT.md).

**No TypeScript strict mode on .astro files**
Astro's type generation handles component types. Strict mode is on in `tsconfig.json` but data files use TypeScript directly.

---

## Colour palette

**Base: Tailwind `stone` family** (warm greys, not cool grey)
- Background: `stone-50` (warm off-white)
- Body text: `stone-900`
- Muted text: `stone-600`/`stone-400`

**Brand accent: Tailwind `slate-700`** (#334155)
This reads as "Lake District slate" — a dark blue-grey with warmth. Used for CTAs, the nav, the page headers, and the footer.

Decision: avoided green (too generic/outdoorsy), avoided blue (implies water/lake — brand rule says NOT lakeside), avoided red/orange. Slate is named in the property name so it's the right call.

---

## Page structure

**Six pages:** Home, The House, Keswick & the Area, Gallery, Availability & Enquiry, 404.

No separate Contact page — the enquiry form is embedded in Availability & Enquiry, which is the natural destination for anyone wanting to get in touch. This avoids duplicating the form. The footer and every page CTA links to `/availability/`.

---

## Hero section

Used a CSS gradient (`from-slate-900 via-slate-800 to-slate-700`) as the hero background, with the `PRO-01.jpg` image layered on top at 30% opacity. When the real photo drops in, it becomes the dominant image. This means the hero works well even before photos arrive.

---

## Gallery

**Masonry layout via CSS `columns`** — no JavaScript grid library. The filter tabs are vanilla JS (no React needed). The `data-filter` attribute drives show/hide. Fast, accessible, no dependencies.

**Placeholder overlay approach:** images use `onerror` + a JS loop to show a labelled placeholder when the file is missing. The overlay shows the Shot ID and alt text so it's clear what should go there.

---

## Enquiry form

**POST to n8n webhook** (configurable URL). Form is entirely client-side HTML + fetch — no server needed. A honeypot field (`name="website"`, hidden, `tabindex="-1"`) traps simple bots without needing CAPTCHA.

**Webhook URL is a placeholder** — n8n credentials not available at build time. Instructions to connect it are in BUILD-REPORT.md. The form shows a graceful error message if the URL is not yet set.

---

## Availability calendar

**Placeholder only.** The brief mentions feeding a Travel Chapter iCal feed later. For now, a clearly-labelled placeholder card sits in the sidebar. The `TODO` note is in the component. No code needed once a calendar embed or iframe widget is provided.

---

## Schema.org

Used `VacationRental` type (more specific than `LodgingBusiness`). Key properties: `numberOfRooms: 3`, `occupancy.maxValue: 6`, `address.addressLocality: Keswick`. The schema is in the base `Layout.astro` and outputs on every page. It correctly places the property in Keswick, not on the lake.

---

## Analytics

Left a commented-out placeholder in `Layout.astro` for either Cloudflare Web Analytics or Plausible. Neither requires cookies. Decision: don't sign up at build time — this is a go-live step for Gareth to choose.

---

## n8n webhook for preview

Since n8n admin credentials weren't available during the build, the form webhook URL remains a placeholder. An importable n8n workflow JSON is at `n8n-workflows/website-enquiry-handler.json`. Setup steps are in BUILD-REPORT.md.

---

## What was NOT built (out of scope)

- **Payment / booking engine** — enquiry-led only, per brief.
- **Reviews** — no fabricated reviews per brief. No review widget added.
- **Prices / rates** — marked as PLACEHOLDER in the sidebar. Fill in before go-live.
- **Availability calendar** — placeholder with TODO note.
- **Parking details** — marked as PLACEHOLDER. Gareth to confirm exact arrangement.
- **Exact postcode** — only `CA12` (Keswick general) used in schema. Full postcode to be confirmed.
