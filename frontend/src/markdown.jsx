// Minimal, dependency-free markdown renderer for assistant answers.
// Produces React elements (no innerHTML), so model output is never executed.
// Supports: paragraphs, headings (#, ##, ###), bullet and numbered lists,
// fenced code blocks, inline code, **bold**, *italic*, and strips stray *.

const ORDERED_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const HEADING_RE = /^\s*(#{1,3})\s+(.*)$/;

function renderInline(text, keyPrefix) {
  const nodes = [];
  // Tokens: `code`, **bold**, *italic*, _italic_
  // Emphasis markers must hug non-space text (so "a * b * c" is not italic),
  // and underscores only count at word boundaries (snake_case stays intact).
  const re =
    /(`[^`\n]+`)|(\*\*(?=\S)[^*\n]*?\S\*\*|\*\*\S\*\*)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|((?<![A-Za-z0-9])_(?=\S)[^_\n]*?\S_(?![A-Za-z0-9]))/g;
  let last = 0;
  let match;
  let i = 0;

  const pushText = (raw) => {
    if (!raw) return;
    // Remove any leftover asterisks that did not form a valid pair.
    const cleaned = raw.replace(/\*+/g, "");
    if (cleaned) nodes.push(cleaned);
  };

  while ((match = re.exec(text)) !== null) {
    pushText(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (match[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (match[3] || match[4]) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    last = match.index + token.length;
  }
  pushText(text.slice(last));
  return nodes;
}

function renderLines(lines, keyPrefix) {
  // Join consecutive lines of a paragraph with soft line breaks.
  const out = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br-${idx}`} />);
    out.push(...renderInline(line, `${keyPrefix}-l${idx}`));
  });
  return out;
}

export function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (may be missing while streaming)
      blocks.push(
        <pre key={`b${k++}`}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      blocks.push(<Tag key={`b${k++}`}>{renderInline(h[2], `h${k}`)}</Tag>);
      i += 1;
      continue;
    }

    // Bullet list
    if (BULLET_RE.test(line)) {
      const items = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        items.push(lines[i].match(BULLET_RE)[1]);
        i += 1;
      }
      blocks.push(
        <ul key={`b${k++}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ul${k}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (ORDERED_RE.test(line)) {
      const items = [];
      const start = Number(line.match(ORDERED_RE)[1]) || 1;
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        items.push(lines[i].match(ORDERED_RE)[2]);
        i += 1;
      }
      blocks.push(
        <ol key={`b${k++}`} start={start}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol${k}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph: gather until blank line or a block starter
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`b${k++}`}>{renderLines(para, `p${k}`)}</p>);
  }

  return blocks;
}
