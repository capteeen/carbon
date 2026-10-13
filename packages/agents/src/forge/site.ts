import { FOOTER_TEXT } from '@argon/core';

/** SPEC §5 palette. Colour only as iridescence; the page itself stays near-monochrome. */
export const PALETTE = {
  fogLight: '#B9C0CB',
  fogMid: '#9AA2AF',
  slate: '#5C6472',
  frost: '#E6EBF2',
  ink: '#2B313B',
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface SiteInput {
  name: string;
  ticker: string;
  lore: string;
  tagline: string;
  logoUri: string;
  bannerUri: string;
}

/** One-page static site for the coin. Self-contained HTML, no scripts. */
export function renderSite(i: SiteInput): string {
  const e = escapeHtml;
  const p = PALETTE;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(i.name)} ($${e(i.ticker)})</title>
<meta name="description" content="${e(i.tagline)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--fog-light:${p.fogLight};--fog-mid:${p.fogMid};--slate:${p.slate};--frost:${p.frost};--ink:${p.ink}}
*{box-sizing:border-box;margin:0}
body{background:linear-gradient(180deg,var(--frost),var(--fog-light) 60%,var(--fog-mid));color:var(--ink);font:14px/1.6 'Space Mono',ui-monospace,monospace;min-height:100vh}
header{position:relative}
.banner{display:block;width:100%;aspect-ratio:3/1;object-fit:cover;filter:saturate(.6)}
main{max-width:640px;margin:0 auto;padding:0 16px 48px}
.logo{width:120px;height:120px;border-radius:50%;margin-top:-60px;border:1px solid var(--frost);background:var(--frost);object-fit:cover}
.label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--slate);margin-top:24px}
h1{font-size:32px;line-height:1.1;margin-top:8px;letter-spacing:-.01em}
.ticker{color:var(--slate)}
.tag{margin-top:8px;color:var(--slate)}
.lore{margin-top:24px;padding-top:16px;border-top:1px solid var(--frost)}
footer{max-width:640px;margin:0 auto;padding:24px 16px;font-size:11px;color:var(--slate);border-top:1px solid var(--frost)}
</style>
</head>
<body>
<header><img class="banner" src="${e(i.bannerUri)}" alt=""></header>
<main>
<img class="logo" src="${e(i.logoUri)}" alt="${e(i.name)} logo">
<p class="label">////// COIN // $${e(i.ticker)}</p>
<h1>${e(i.name)} <span class="ticker">$${e(i.ticker)}</span></h1>
<p class="tag">// ${e(i.tagline)}</p>
<p class="lore">${e(i.lore)}</p>
</main>
<footer>${e(FOOTER_TEXT)}</footer>
</body>
</html>
`;
}
