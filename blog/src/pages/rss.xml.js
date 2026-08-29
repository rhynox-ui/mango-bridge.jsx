// src/pages/rss.xml.js
import rss from "@astrojs/rss";

export async function GET(context) {
  const posts = Object.values(import.meta.glob("./blog/*.md", { eager: true }));
  return rss({
    title: "Mango Protocol Blog",
    description: "Updates from Mango Protocol — the non-custodial cross-chain bridge and launchpad.",
    site: context.site,
    items: posts.map((post) => ({
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      pubDate: post.frontmatter.date,
      link: post.url,
    })),
  });
}
