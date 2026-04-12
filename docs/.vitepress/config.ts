import { defineConfig } from "vitepress";

/**
 * VitePress configuration for the ziku documentation site.
 *
 * SEO: sitemap, OGP, structured data, and clean URLs are enabled.
 * AI: llms.txt is served from /public for AI tool discovery.
 * Deploy: GitHub Pages via .github/workflows/docs.yml.
 */
export default defineConfig({
  title: "ziku",
  description:
    "A bi-directional dev environment template that evolves with you. Keep your templates alive with push, pull, and 3-way merge.",
  lang: "en",

  // GitHub Pages deploys under /ziku/
  base: "/ziku/",

  // Clean URLs without .html suffix
  cleanUrls: true,

  // Dev Container 環境ではコンテナ外からアクセスするために 0.0.0.0 バインドが必要
  vite: {
    server: {
      host: true,
    },
  },

  // 内部計画ドキュメントと未公開記事をサイトから除外
  srcExclude: ["plan-*.md", "articles/**"],

  // Sitemap for search engines
  sitemap: {
    hostname: "https://tktcorporation.github.io/ziku/",
  },

  // <head> tags for SEO and OGP
  head: [
    // OGP
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "ziku — bi-directional template sync" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A CLI tool that bi-directionally syncs dev environment configs between template repos and projects. Push, pull, and 3-way merge.",
      },
    ],
    ["meta", { property: "og:url", content: "https://tktcorporation.github.io/ziku" }],
    // Twitter Card
    ["meta", { name: "twitter:card", content: "summary" }],
    // JSON-LD structured data
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "ziku",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Cross-platform",
        description:
          "A bi-directional dev environment template manager that keeps templates alive with push, pull, and 3-way merge.",
        url: "https://tktcorporation.github.io/ziku",
        author: {
          "@type": "Person",
          name: "tktcorporation",
          url: "https://github.com/tktcorporation",
        },
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: "https://opensource.org/licenses/MIT",
      }),
    ],
  ],

  // Theme configuration
  themeConfig: {
    logo: "/logo.svg",

    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Commands", link: "/guide/commands" },
      {
        text: "Links",
        items: [
          { text: "npm", link: "https://www.npmjs.com/package/ziku" },
          {
            text: "Changelog",
            link: "https://github.com/tktcorporation/ziku/blob/main/CHANGELOG.md",
          },
        ],
      },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "How it Works", link: "/guide/how-it-works" },
          { text: "Commands", link: "/guide/commands" },
        ],
      },
      {
        text: "Reference",
        items: [{ text: "File Lifecycle", link: "/architecture/file-lifecycle" }],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/tktcorporation/ziku" },
      { icon: "npm", link: "https://www.npmjs.com/package/ziku" },
    ],

    editLink: {
      pattern: "https://github.com/tktcorporation/ziku/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © tktcorporation",
    },

    search: {
      provider: "local",
    },
  },
});
