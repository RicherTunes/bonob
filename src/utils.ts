import { DOMParser, XMLSerializer, Node } from '@xmldom/xmldom';

export function takeWithRepeats<T>(things:T[], count: number) {
  const result = [];
  for(let i = 0; i < count; i++) {
    result.push(things[i % things.length])
  }
  return result;
}

function xmlRemoveWhitespaceNodes(node: Node) {
  let child = node.firstChild;
  while (child) {
      const nextSibling = child.nextSibling;
      if (child.nodeType === 3 && !child.nodeValue?.trim()) {
          // Remove empty text nodes
          node.removeChild(child);
      } else {
          // Recursively process child nodes
          xmlRemoveWhitespaceNodes(child);
      }
      child = nextSibling;
  }
}

export function xmlTidy(xml: string | Node) {
  const xmlToString = new XMLSerializer().serializeToString

  const xmlString = xml instanceof Node ? xmlToString(xml as any) : xml
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml') as unknown as Node;
  xmlRemoveWhitespaceNodes(doc);
  return xmlToString(doc as any);
}

const MIME_TYPE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;

export function isValidMimeType(value: string): boolean {
  return MIME_TYPE_REGEX.test(value);
}

// Anything client-supplied that reaches a log line is attacker-controlled. A CR/LF inside one lets
// a client forge whole additional log lines, and a bare quote lets it escape a quoted field - the
// defect class of GHSA-4vj7-5mj6-jm8m, which morgan 1.11.0 fixes for :remote-user only. Escape
// control characters, the quote, and the escape character itself, so a logged value can never be
// mistaken for log structure.
//
// This lives here because BOTH log surfaces need it and they must not import each other: the access
// log (server.ts, for the request line / referrer / user-agent) and the SMAPI degradation log
// (timeout.ts, whose context embeds a Sonos-supplied container id).
export function sanitizeLogValue(value: string | undefined): string {
  if (!value) return "";
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    // C0 and C1 control characters, including the CR/LF that would forge a new log line.
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out;
}

