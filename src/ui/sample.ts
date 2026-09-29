import type { DocumentRecord } from '@/storage/types';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

const paragraphs = [
  'Inkwell reads along as you write. It underlines the smallest span that needs attention and stays quiet when your text is fine.',
  'Try it here: this sentance has a typo, and this this one repeats a word. Yesterday i bought a apple on the way home.',
  'Hover or click an underline to see what Inkwell suggests. From the keyboard, press F8 to jump to the next issue, Enter to accept, and Escape to close the card.',
  'Their is more it can do when AI checks are on: it could of caught words that are spelled correctly but used wrongly, which a dictionary alone never sees.',
  'Select any phrase to improve it, shorten it, or change its tone. The proposal appears in place, and nothing changes until you accept it.',
];

export const SAMPLE_DOCUMENT: Partial<Pick<DocumentRecord, 'title' | 'content' | 'text' | 'wordCount'>> = {
  title: 'Welcome to Inkwell',
  content: { type: 'doc', content: paragraphs.map(p) },
  text: paragraphs.join('\n\n'),
  wordCount: paragraphs.join(' ').split(/\s+/).length,
};
