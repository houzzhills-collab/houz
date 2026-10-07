/**
 * The one email layout every message uses. Templates describe content as
 * blocks; this renders them to table-based, inline-styled HTML (what email
 * clients reliably support) and to an equivalent plain-text part. All dynamic
 * text is HTML-escaped here, so templates never build markup themselves.
 */

export type Tone = "neutral" | "success" | "warning" | "danger";

export type Block =
  | { kind: "paragraph"; text: string }
  /** Label/value summary, such as a booking or a receipt. `total` emphasises the last row. */
  | { kind: "details"; title?: string; rows: ReadonlyArray<readonly [label: string, value: string]>; total?: boolean }
  | { kind: "callout"; tone: Tone; title?: string; text: string }
  | { kind: "button"; label: string; url: string }
  /** A value the reader must copy exactly, such as a temporary password. */
  | { kind: "code"; label: string; value: string }
  | { kind: "table"; headers: readonly string[]; rows: ReadonlyArray<readonly string[]> };

export type EmailContent = {
  subject: string;
  /** Inbox preview text shown after the subject. */
  preheader: string;
  eyebrow: string;
  tone: Tone;
  heading: string;
  blocks: readonly Block[];
  /** Why the reader received this email, shown in the footer. */
  reason: string;
};

/** `tagline` sits under the name, as in the workspace logo (e.g. "Property operations"). */
export type Brand = { propertyName: string; webUrl: string | null; tagline?: string };

export type RenderedEmail = { subject: string; html: string; text: string };

const COLORS = {
  ink: "#202b35",
  body: "#4a505a",
  muted: "#8a8f98",
  line: "#ece8df",
  gold: "#c9a84c",
  page: "#f3f1ec",
  panel: "#faf8f3",
};

const TONES: Record<Tone, { accent: string; tint: string }> = {
  neutral: { accent: "#6b7280", tint: "#f3f4f6" },
  success: { accent: "#4f8a5f", tint: "#eef6f0" },
  warning: { accent: "#a27c31", tint: "#fbf5e8" },
  danger: { accent: "#b0574a", tint: "#fbefec" },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** Only absolute http(s) links are rendered; anything else is dropped rather than risk a javascript: URL. */
function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Escapes text and keeps the author's line breaks. */
function prose(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return `<p style="margin:0 0 18px;font:15px/1.65 ${FONT};color:${COLORS.body};">${prose(block.text)}</p>`;
    case "details": {
      const rows = block.rows
        .map(([label, value], index) => {
          const last = index === block.rows.length - 1;
          const emphasise = block.total && last;
          const border = last ? "" : `border-bottom:1px solid ${COLORS.line};`;
          return `<tr>
            <td style="padding:11px 18px;${border}font:13px/1.4 ${FONT};color:${COLORS.muted};vertical-align:top;">${escapeHtml(label)}</td>
            <td align="right" style="padding:11px 18px;${border}font:${emphasise ? "700 16px" : "600 14px"}/1.4 ${FONT};color:${COLORS.ink};text-align:right;vertical-align:top;">${prose(value)}</td>
          </tr>`;
        })
        .join("");
      const title = block.title
        ? `<p style="margin:0 0 8px;font:700 11px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(block.title)}</p>`
        : "";
      return `${title}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border-collapse:separate;background:${COLORS.panel};border:1px solid ${COLORS.line};border-radius:10px;">${rows}</table>`;
    }
    case "callout": {
      const tone = TONES[block.tone];
      const title = block.title ? `<strong style="display:block;margin:0 0 4px;font:700 14px/1.4 ${FONT};color:${tone.accent};">${escapeHtml(block.title)}</strong>` : "";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>
        <td style="padding:14px 18px;background:${tone.tint};border-left:4px solid ${tone.accent};border-radius:6px;font:14px/1.6 ${FONT};color:${COLORS.body};">${title}${prose(block.text)}</td>
      </tr></table>`;
    }
    case "button": {
      const url = safeUrl(block.url);
      if (!url) return "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 26px;"><tr>
        <td align="center" bgcolor="${COLORS.ink}" style="border-radius:8px;background:${COLORS.ink};">
          <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:14px 28px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(block.label)} &rarr;</a>
        </td>
      </tr></table>`;
    }
    case "code":
      return `<p style="margin:0 0 8px;font:700 11px/1 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(block.label)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>
          <td style="padding:16px 18px;background:${COLORS.panel};border:1px dashed ${COLORS.gold};border-radius:8px;font:600 17px/1.4 ${MONO};letter-spacing:1px;color:${COLORS.ink};word-break:break-all;">${escapeHtml(block.value)}</td>
        </tr></table>`;
    case "table": {
      const head = block.headers
        .map((header, index) => `<th align="${index === 0 ? "left" : "right"}" style="padding:10px 14px;border-bottom:1px solid ${COLORS.line};font:700 11px/1.2 ${FONT};letter-spacing:1px;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(header)}</th>`)
        .join("");
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, index) => `<td align="${index === 0 ? "left" : "right"}" style="padding:10px 14px;border-bottom:1px solid ${COLORS.line};font:${index === 0 ? "600 " : ""}14px/1.4 ${FONT};color:${COLORS.ink};">${escapeHtml(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border-collapse:collapse;background:${COLORS.panel};border:1px solid ${COLORS.line};"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "details": {
      const width = Math.max(...block.rows.map(([label]) => label.length));
      const rows = block.rows.map(([label, value]) => `  ${`${label}:`.padEnd(width + 2)}${value.replace(/\n/g, `\n  ${" ".repeat(width + 2)}`)}`).join("\n");
      return block.title ? `${block.title.toUpperCase()}\n${rows}` : rows;
    }
    case "callout":
      return block.title ? `** ${block.title} **\n${block.text}` : `** ${block.text}`;
    case "button":
      return safeUrl(block.url) ? `${block.label}: ${block.url}` : "";
    case "code":
      return `${block.label}: ${block.value}`;
    case "table":
      return [block.headers.join(" | "), ...block.rows.map((row) => row.join(" | "))].join("\n");
  }
}

export function renderEmail(content: EmailContent, brand: Brand): RenderedEmail {
  const tone = TONES[content.tone];
  const name = escapeHtml(brand.propertyName);
  const initial = escapeHtml(brand.propertyName.trim().charAt(0).toUpperCase() || "H");
  const site = brand.webUrl ? safeUrl(brand.webUrl) : null;
  const year = new Date().getFullYear();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td style="background:${COLORS.ink};border-radius:14px 14px 0 0;padding:26px 36px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="42" height="42" align="center" style="width:42px;height:42px;border-radius:11px;background:#2c3946;font:26px/42px ${SERIF};color:#ffffff;">${initial}<span style="color:${COLORS.gold};">.</span></td>
          <td style="padding-left:14px;">
            <div style="font:700 14px/1.2 ${FONT};letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;">${name}</div>
            ${brand.tagline ? `<div style="margin-top:5px;font:600 10px/1.2 ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:${COLORS.gold};">${escapeHtml(brand.tagline)}</div>` : ""}
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="height:3px;line-height:3px;font-size:0;background:${COLORS.gold};">&nbsp;</td></tr>
      <tr><td style="background:#ffffff;padding:38px 36px 18px;border-radius:0 0 14px 14px;">
        <p style="margin:0 0 10px;font:700 11px/1 ${FONT};letter-spacing:1.8px;text-transform:uppercase;color:${tone.accent};">${escapeHtml(content.eyebrow)}</p>
        <h1 style="margin:0 0 22px;font:normal 27px/1.25 ${SERIF};color:${COLORS.ink};">${escapeHtml(content.heading)}</h1>
        ${content.blocks.map(renderBlock).join("\n")}
        <p style="margin:8px 0 18px;font:15px/1.6 ${FONT};color:${COLORS.body};">Warm regards,<br><span style="font-family:${SERIF};color:${COLORS.ink};font-size:17px;">${name}</span></p>
      </td></tr>
      <tr><td align="center" style="padding:24px 24px 8px;font:12px/1.7 ${FONT};color:${COLORS.muted};">
        ${escapeHtml(content.reason)}<br>
        ${site ? `<a href="${escapeHtml(site)}" style="color:${COLORS.muted};text-decoration:underline;">${escapeHtml(new URL(site).host)}</a> &middot; ` : ""}&copy; ${year} ${name}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    brand.propertyName.toUpperCase(),
    "",
    content.eyebrow.toUpperCase(),
    content.heading,
    "",
    ...content.blocks.map(blockText).filter(Boolean).flatMap((part) => [part, ""]),
    "Warm regards,",
    brand.propertyName,
    "",
    "--",
    content.reason,
    ...(site ? [site] : []),
  ].join("\n");

  return { subject: content.subject, html, text };
}
