/** Rewrites the generated blocks of docs/how.md from code. Run: pnpm --filter @carbon/web gen:how */
import { readFile, writeFile } from 'node:fs/promises';
import { GENERATED_SECTIONS, spliceSection } from '../src/lib/how-doc';
import { generatedSections } from '../src/lib/how-sections';
import { howDocPath } from '../src/lib/how-path';

const path = howDocPath();
let doc = await readFile(path, 'utf8');
const sections = generatedSections();
for (const name of GENERATED_SECTIONS) doc = spliceSection(doc, name, sections[name]);
await writeFile(path, doc);
console.log(`updated ${GENERATED_SECTIONS.join(', ')} in docs/how.md`);
