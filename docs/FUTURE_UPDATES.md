# Future updates

Running list of ideas discussed but not yet implemented for this repo
(mango-bridge.jsx / mangoprotocol.site) — mirrors the same convention
mango-mobile's own docs/FUTURE_UPDATES.md already uses. Add to this
list as new ideas come up; move an item to "Done" (with the PR) once
it ships.

## Features

1. **Separate subdomains: `stats.mangoprotocol.site`, `blog.mangoprotocol.site`.**
   Discussed alongside building the referral admin dashboard
   (`?admin-referrals=1` on the main site) — that page lives as a route
   inside this same app, which is the simpler option for an
   internal/admin tool. A public-facing stats page or blog is a
   different shape: its own content, its own update cadence, arguably
   its own simpler tech stack (doesn't need this app's wallet/bridge
   dependencies at all), so a separate Vercel project on a subdomain
   fits better than another route here.

   **What this actually takes**, so it's not vague when picked up:
   - A new Vercel project (this account's plan is Pro — no limit on
     number of projects/domains) pointed at either a new repo or a new
     root directory in this one, whichever `stats`/`blog` end up
     needing.
   - The subdomain itself (`stats.mangoprotocol.site` /
     `blog.mangoprotocol.site`) added as a Domain on that new Vercel
     project — DNS for the apex `mangoprotocol.site` is already on
     Vercel, so this is an in-dashboard step, not a registrar change.
   - `stats`: real content to decide — likely bridge/launchpad volume,
     total swaps, referral program size (the admin dashboard's own
     data, made public and read-only), sourced from `api/token-activity.js`'s
     already-existing `fetchProtocolStats`/`fetchLaunchStats` rather
     than a new pipeline.
   - `blog`: a real content/publishing decision first (static
     markdown-in-repo vs. a headless CMS) — not yet made, worth a
     deliberate choice rather than defaulting to whichever is fastest
     to stand up.

   Not started. No code, no Vercel project, no DNS record exists for
   either yet — this entry exists so the idea isn't lost, not because
   any part of it is in progress.
