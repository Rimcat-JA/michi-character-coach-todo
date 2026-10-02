import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommentList } from './TaskMaterials';

describe('TaskMaterials comment author labels', () => {
  it('recipient comments show the sender label, owner comments show 本人', () => {
    const html = renderToStaticMarkup(createElement(CommentList, {
      comments: [
        { id: 'c1', taskId: 't', ownerId: 'o', body: '金曜までに見ます', createdAt: '2026-10-01T00:00:00.000Z', authorKind: 'share_recipient', authorLabel: '相手B' },
        { id: 'c2', taskId: 't', ownerId: 'o', body: '自分用メモ', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
    }));
    expect(html).toContain('共有相手 相手B');
    expect(html).toContain('金曜までに見ます');
    expect(html).toContain('本人');
  });
});
