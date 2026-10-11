/**
 * Deterministic content denylist (public on /how). Whole-word, case-insensitive
 * match on name, ticker and lore. The LLM classifier covers what a list cannot.
 */
import type { ContentFinding } from './formula.js';

export const DENYLIST: Record<ContentFinding['rule'], string[]> = {
  real_person: [
    'elon', 'musk', 'trump', 'biden', 'obama', 'kamala', 'harris', 'putin', 'zelensky', 'xi jinping', 'modi', 'macron',
    'bezos', 'zuckerberg', 'zuck', 'gates', 'vitalik', 'buterin', 'saylor', 'cz', 'changpeng', 'sbf', 'bankman',
    'taylor swift', 'kanye', 'ye west', 'drake', 'rihanna', 'beyonce', 'mrbeast', 'pope', 'king charles', 'satoshi nakamoto',
  ],
  protected_brand: [
    'disney', 'pixar', 'marvel', 'pokemon', 'pikachu', 'nintendo', 'mario', 'sonic', 'nike', 'adidas', 'gucci', 'apple',
    'google', 'gemini', 'microsoft', 'openai', 'chatgpt', 'tesla', 'spacex', 'starlink', 'amazon', 'meta', 'facebook',
    'instagram', 'tiktok', 'coca cola', 'cocacola', 'pepsi', 'mcdonalds', 'starbucks', 'netflix', 'spotify', 'ferrari',
    'lamborghini', 'rolex', 'louis vuitton', 'mickey', 'hello kitty', 'shrek', 'spongebob', 'pepe', 'doge', 'shiba inu',
    'binance', 'coinbase', 'solana', 'pump fun', 'pumpfun', 'phantom',
  ],
  sexual: ['sex', 'sexy', 'porn', 'nsfw', 'nude', 'nudes', 'naked', 'onlyfans', 'hentai', 'xxx', 'boobs', 'tits', 'dick', 'cum', 'milf', 'horny', 'fetish'],
  violent: [
    'kill', 'killer', 'murder', 'shoot', 'shooting', 'bomb', 'bombing', 'terror', 'terrorist', 'isis', 'jihad', 'genocide',
    'massacre', 'rape', 'nazi', 'hitler', 'suicide', 'behead', 'school shooter', 'gun', 'guns',
  ],
};

function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

export function checkDenylist(fields: Record<string, string>): ContentFinding[] {
  const out: ContentFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const w = words(value);
    for (const [rule, terms] of Object.entries(DENYLIST) as [ContentFinding['rule'], string[]][]) {
      for (const term of terms) {
        if (w.includes(` ${term} `)) out.push({ rule, evidence: `"${term}" in ${field}`, by: 'denylist' });
      }
    }
  }
  return out;
}
