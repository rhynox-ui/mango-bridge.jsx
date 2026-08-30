# Mango Protocol Blog

Static blog for `blog.mangoprotocol.site`, built with [Astro](https://astro.build). Separate Vercel project from the main app (`mango-bridge.jsx`) — no wallet/bridge dependencies, just markdown.

## Adding a new post

Add a new `.md` file in `src/pages/blog/`, with this frontmatter:

```md
---
layout: ../../layouts/BlogPost.astro
title: "Your post title"
description: "One sentence, shows on the homepage list."
date: "2026-08-29"
---

Your post content here, in normal markdown.
```

That's it — it shows up on the homepage automatically, sorted by `date`, newest first. No other file needs touching.

### Or use the admin page

Go to `/admin`, log in with the blog admin secret, and fill in the form. It
commits a new `.md` file straight to `main` via `api/create-post.js` (GitHub's
Contents API) — same result as adding the file by hand, just from a browser.
Requires `BLOG_ADMIN_SECRET` and `GITHUB_TOKEN` (a fine-grained PAT scoped to
this repo, Contents: Read and Write) set as env vars on the
`mango-protocol-blog` Vercel project. `/admin` isn't linked anywhere in the
nav — it's reachable only by going straight to the URL.

## Local development

```bash
npm install
npm run dev
```

## Deploy

Pushes to `main` deploy automatically via Vercel (same as the main site).
