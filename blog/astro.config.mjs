// astro.config.mjs
//
// Real, deployed site URL — needed for RSS/sitemap links to be
// absolute rather than relative, and for anything Astro generates
// that embeds the site's own origin.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://blog.mangoprotocol.site",
});
