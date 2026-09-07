// Text shaping for Telegram: markdown → Telegram HTML, and length-safe chunking.
//
// Telegram caps a message at 4096 characters *after entities parsing*. Chunking the
// SOURCE text (not the rendered HTML) at line boundaries and converting each chunk
// independently keeps every chunk under the cap, never splits an HTML tag, and gives
// the plain-text fallback the exact same boundaries as the HTML variant.

export const TELEGRAM_MAX_LEN = 4096;
/** Target chunk size in source characters — headroom under the 4096-after-parsing cap. */
export const TELEGRAM_SOFT_LEN = 3500;

export function normalizeTelegramText(text: string): string {
  return text.replace(/[\u2010-\u2015\u2212]/g, "-");
}

// --- Markdown → Telegram HTML conversion (ported from nanobot) ---

export function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML special characters
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links [text](url) — before bold/italic to handle nested cases
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic _text_ (avoid matching inside words like some_var_name)
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // 11. Restore inline code with HTML tags
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks with HTML tags
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

// --- Chunking ---

/**
 * Split source text into pieces of at most `softLen` characters, cutting at a blank line,
 * then a line break, then a space (never before 40% of the window, so chunks stay substantial),
 * with a hard cut as the last resort. A fenced code block that straddles a cut is closed at the
 * end of the chunk and reopened (same language tag) at the start of the next, so each chunk
 * renders on its own.
 */
export function splitTelegramText(text: string, softLen: number = TELEGRAM_SOFT_LEN): string[] {
  if (text.length <= softLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  const minCut = Math.floor(softLen * 0.4);

  while (rest.length > softLen) {
    const window = rest.slice(0, softLen);
    let chunk: string | null = null;
    for (const sep of ["\n\n", "\n", " "]) {
      const idx = window.lastIndexOf(sep);
      if (idx >= minCut) {
        chunk = rest.slice(0, idx);
        rest = rest.slice(idx + sep.length);
        break;
      }
    }
    if (chunk === null) {
      chunk = rest.slice(0, softLen);
      rest = rest.slice(softLen);
    }

    // Balance a code fence cut in half: close it here, reopen it on the next chunk.
    const fences = chunk.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      const openAt = chunk.lastIndexOf("```");
      const tagEnd = chunk.indexOf("\n", openAt);
      const tag = chunk.slice(openAt + 3, tagEnd === -1 ? chunk.length : tagEnd).trim();
      chunk = chunk.replace(/\s+$/, "") + "\n```";
      rest = "```" + tag + "\n" + rest;
    }
    chunks.push(chunk);
  }
  chunks.push(rest);
  return chunks;
}

export interface TelegramChunk {
  /** The source slice, safe to send as plain text. */
  plain: string;
  /** The same slice rendered as Telegram HTML. */
  html: string;
}

/** Normalize, strip reaction directives, split, and render each chunk to HTML independently. */
export function renderTelegramChunks(text: string, softLen: number = TELEGRAM_SOFT_LEN): TelegramChunk[] {
  const normalized = normalizeTelegramText(text).replace(/\[react:[^\]\r\n]+\]/gi, "");
  return splitTelegramText(normalized, softLen).map((plain) => ({ plain, html: markdownToTelegramHtml(plain) }));
}
