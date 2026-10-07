# pvnis.github.io

Pavonis engineering blog, built with [Eleventy](https://www.11ty.dev/) and deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## Writing a post

Add a Markdown file to `src/posts/` named `YYYY-MM-DD-slug.md`:

```markdown
---
title: "Post title"
description: "One-sentence summary for the index, feed and link previews."
author: Your Name
date: 2026-10-06
tags: [posts, OCUDU]
---
```

It is published at `/blog/<slug>/`. Add `draft: true` to keep a post out of the build; `npm run drafts` previews drafts locally.

## Local preview

```bash
npm ci
npm run serve   # http://localhost:8080
```

## One-time GitHub setup

Repository Settings → Pages → Build and deployment → Source: **GitHub Actions**.
