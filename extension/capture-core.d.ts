export function readSelectedFragment(): { title: string; url: string; quote: string }
export function buildCapsule(input: { title: string; url: string; quote: string; capturedAt?: string; timezone?: string }): import('../src/web-capture-import').WebCaptureCapsule
