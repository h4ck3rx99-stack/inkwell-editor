// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { sanitizePastedHTML } from '@/editor/paste';
import { mockCorrections, mockWrite } from '@/server/ai/providers/mock';
import { cleanStreamed } from '@/editor/session';
import { schema } from './helpers/pm';

describe('paste sanitization', () => {
  it('strips styles, classes, scripts and tracking attributes', () => {
    const html = '<style>p{color:red}</style><p class="MsoNormal" style="color:red" data-x="1" onclick="evil()">Hello <span style="font-family:Comic Sans">world</span><script>alert(1)</script></p>';
    const out = sanitizePastedHTML(html);
    expect(out).toBe('<p>Hello world</p>');
  });

  it('unwraps the Google Docs bold wrapper but keeps real bold/italic', () => {
    const html = '<b style="font-weight:normal;" id="docs-internal-guid-123"><p><span style="font-weight:700">Bold</span> and <span style="font-style:italic">italic</span></p></b>';
    expect(sanitizePastedHTML(html)).toBe('<p><strong>Bold</strong> and <em>italic</em></p>');
  });

  it('keeps safe links and drops javascript: links', () => {
    expect(sanitizePastedHTML('<a href="https://x.com" target="_blank" rel="x">ok</a><a href="javascript:alert(1)">bad</a>')).toBe(
      '<a href="https://x.com">ok</a><a>bad</a>',
    );
  });

  it('drops Office namespace tags and images', () => {
    expect(sanitizePastedHTML('<p>Hi<o:p></o:p><img src="x.png"></p>')).toBe('<p>Hi</p>');
  });

  it('parses into clean editor content with no foreign marks', () => {
    const html = sanitizePastedHTML('<h2 style="color:red">Title</h2><p><u>under</u> <font color="red">text</font> <strong>b</strong></p>');
    const dom = new window.DOMParser().parseFromString(html, 'text/html').body;
    const doc = PMDOMParser.fromSchema(schema).parse(dom);
    expect(doc.child(0).type.name).toBe('heading');
    expect(doc.child(1).textContent).toBe('under text b');
    // Pasted blocks never carry block ids: the editor assigns fresh ones.
    expect(doc.child(1).attrs.bid).toBeNull();
  });
});

describe('mock provider', () => {
  it('reports issues the way a model does: original + prefix, never offsets', () => {
    const issues = mockCorrections('Well, their is alot to do.');
    expect(issues.map((i) => i.original)).toEqual(['alot', 'their is']);
    expect(issues[1]).toMatchObject({ prefix: 'Well, ', replacements: ['there is'] });
    expect(Object.keys(issues[0]!)).not.toContain('start');
  });

  it('produces deterministic, visibly different rewrites', () => {
    const task = { kind: 'write' as const, dialect: 'en-US' as const, goal: 'general' as const };
    expect(mockWrite({ ...task, action: 'shorter', text: 'This is really very important in order to win.' })).toBe('This is important to win.');
    expect(mockWrite({ ...task, action: 'tone', tone: 'formal', text: "I don't know." })).toBe('I do not know.');
    const improved = mockWrite({ ...task, action: 'improve', text: 'The plan is fine' });
    expect(improved).not.toBe('The plan is fine');
  });
});

describe('cleanStreamed', () => {
  it('strips fences and wrapping quotes from rewrites only', () => {
    expect(cleanStreamed('```\nHello there.\n```', 'rewrite')).toBe('Hello there.');
    expect(cleanStreamed('"Hello there."', 'rewrite')).toBe('Hello there.');
    expect(cleanStreamed(' and more.', 'continue')).toBe(' and more.');
  });
});
