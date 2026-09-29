import { Editor, Extension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { BlockId } from './extensions/block-id';
import { createSuggestionsPlugin, type SuggestionsCallbacks } from './suggestions-plugin';
import { createPreviewPlugin } from './preview-plugin';
import { createFocusPlugin } from './focus-plugin';
import { sanitizePastedHTML } from './paste';

export interface CreateEditorOptions {
  element: HTMLElement;
  content: JSONContent;
  callbacks: SuggestionsCallbacks;
  ariaLabel?: string;
}

export function createInkwellEditor(opts: CreateEditorOptions): Editor {
  // Highest priority so card/preview keys (Enter, Tab, Esc) are handled before list/paragraph keymaps.
  const InkwellCore = Extension.create({
    name: 'inkwellCore',
    priority: 1000,
    addProseMirrorPlugins() {
      return [createSuggestionsPlugin(opts.callbacks), createPreviewPlugin(), createFocusPlugin()];
    },
  });

  return new Editor({
    element: opts.element,
    content: opts.content,
    autofocus: false,
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
        },
        undoRedo: { depth: 500, newGroupDelay: 500 },
        dropcursor: { width: 2, class: 'ink-dropcursor' },
        trailingNode: false,
      }),
      Placeholder.configure({
        placeholder: ({ node, pos }) => (pos === 0 && node.type.name === 'paragraph' ? 'Begin writing…' : ''),
        showOnlyCurrent: true,
      }),
      BlockId,
      InkwellCore,
    ],
    editorProps: {
      attributes: {
        class: 'ink-prose',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'sentences',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': opts.ariaLabel ?? 'Document',
        'data-testid': 'editor',
      },
      transformPastedHTML: sanitizePastedHTML,
    },
  });
}
