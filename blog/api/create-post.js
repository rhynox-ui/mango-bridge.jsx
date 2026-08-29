// blog/api/create-post.js
//
// Publishes a new post by committing a markdown file straight to `main`
// via GitHub's Contents API — no CMS, no database. The blog already reads
// posts by globbing src/pages/blog/*.md (see src/pages/index.astro), so a
// new commit there is a real, immediate publish once Vercel's git
// integration redeploys.
//
// Needs its own GITHUB_TOKEN (fine-grained PAT, Contents: Read and Write,
// scoped to this repo) and BLOG_ADMIN_SECRET, set on the `mango-protocol-
// blog` Vercel project specifically — Vercel env vars are per-project, so
// these are separate from the main app's ADMIN_API_SECRET even though
// both live in the same repo.
//
// Auth follows the same pattern as api/v1/referral/admin-export.js in the
// main app: Bearer secret compared with crypto.timingSafeEqual, and CORS
// scoped to the blog's own origin (browsers preflight any cross-origin
// fetch that carries a custom Authorization header, so OPTIONS must be
// handled or the browser reports a bare "Failed to fetch").

import { timingSafeEqual } from "node:crypto";

const ALLOWED_ORIGINS = new Set(["https://blog.mangoprotocol.site"]);
const REPO_OWNER = "rhynox-ui";
const REPO_NAME = "mango-bridge.jsx";
const POSTS_DIR = "blog/src/pages/blog";

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function yamlString(s) {
  return JSON.stringify(s);
}

export default async function handler(request, response) {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed. This endpoint only supports POST." });
  }

  const secret = process.env.BLOG_ADMIN_SECRET;
  const token = process.env.GITHUB_TOKEN;
  const provided = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || !provided || !safeEqual(provided, secret)) {
    return response.status(401).json({ error: "Unauthorized." });
  }
  if (!token) {
    return response.status(500).json({ error: "GITHUB_TOKEN is not configured on this project." });
  }

  const { title, description, date, content } = request.body || {};
  if (!title || typeof title !== "string" || !title.trim()) {
    return response.status(400).json({ error: "title is required." });
  }
  if (!content || typeof content !== "string" || !content.trim()) {
    return response.status(400).json({ error: "content is required." });
  }
  const postDate = date && typeof date === "string" ? date : new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  if (!slug) {
    return response.status(400).json({ error: "title must contain at least one letter or number." });
  }

  const markdown = `---
layout: ../../layouts/BlogPost.astro
title: ${yamlString(title.trim())}
description: ${yamlString((description || "").trim())}
date: ${yamlString(postDate)}
---

${content.trim()}
`;

  const path = `${POSTS_DIR}/${slug}.md`;
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;

  try {
    const existing = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mango-blog-admin" },
    });
    if (existing.status === 200) {
      return response.status(409).json({ error: `A post already exists at ${path}. Use a different title.` });
    }

    const commitRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "mango-blog-admin",
      },
      body: JSON.stringify({
        message: `Add blog post: ${title.trim()}`,
        content: Buffer.from(markdown, "utf-8").toString("base64"),
        branch: "main",
      }),
    });

    if (!commitRes.ok) {
      const body = await commitRes.text();
      return response.status(502).json({ error: `GitHub commit failed (${commitRes.status}): ${body.slice(0, 300)}` });
    }

    return response.status(200).json({ data: { slug, path, url: `/blog/${slug}` } });
  } catch (err) {
    return response.status(500).json({ error: err?.message || "Failed to publish post." });
  }
}
