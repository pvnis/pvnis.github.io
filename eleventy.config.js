import { feedPlugin } from "@11ty/eleventy-plugin-rss";
import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import markdownItAnchor from "markdown-it-anchor";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(syntaxHighlight);
  eleventyConfig.amendLibrary("md", (md) =>
    md.use(markdownItAnchor, {
      level: [2, 3],
      permalink: markdownItAnchor.permalink.headerLink({ safariReaderFix: true }),
    })
  );

  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy({ "src/CNAME": "CNAME" });
  eleventyConfig.addPassthroughCopy({ "src/.nojekyll": ".nojekyll" });

  eleventyConfig.addCollection("posts", (api) =>
    api.getFilteredByGlob("src/posts/**/*.md").filter((p) => !p.data.draft || process.env.ELEVENTY_DRAFTS)
  );

  const fmt = (d, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(d);
  eleventyConfig.addFilter("readableDate", (d) => fmt(d, { day: "numeric", month: "long", year: "numeric" }));
  eleventyConfig.addFilter("isoDate", (d) => d.toISOString().slice(0, 10));
  eleventyConfig.addFilter("readingTime", (content) => {
    const words = String(content).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 230)) + " min read";
  });

  eleventyConfig.addPlugin(feedPlugin, {
    type: "atom",
    outputPath: "/feed.xml",
    collection: { name: "posts", limit: 20 },
    metadata: {
      language: "en",
      title: "Pavonis",
      subtitle: "Field notes on open radio, FPGAs and systems software.",
      base: "https://pvnis.github.io/",
      author: { name: "Pavonis" },
    },
  });

  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
