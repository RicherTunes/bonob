import { sanitizeXml, getMetadataResult, searchResult } from "../src/smapi";

// Build control characters at runtime; never place a literal control char in source.
const ch = (n: number) => String.fromCharCode(n);

describe("sanitizeXml", () => {
  it("strips every character that is illegal in XML 1.0", () => {
    for (const n of [0, 1, 4, 8, 0x0b, 0x0c, 0x0e, 0x1f, 0xfffe, 0xffff]) {
      expect(sanitizeXml("a" + ch(n) + "b")).toEqual("ab");
    }
  });

  it("preserves the XML-legal whitespace controls (tab, LF, CR)", () => {
    const s = "a" + ch(9) + ch(10) + ch(13) + "b";
    expect(sanitizeXml(s)).toEqual(s);
  });

  it("preserves normal unicode, emoji, and XML metacharacters (the soap layer escapes those)", () => {
    const s = "cafe " + String.fromCodePoint(0x1f3b5) + " & < > \" ' end";
    expect(sanitizeXml(s)).toEqual(s);
  });

  it("strips unpaired UTF-16 surrogates but keeps valid pairs (emoji)", () => {
    // lone high (no following low) and lone low (no preceding high) are both illegal in XML 1.0
    expect(sanitizeXml("a" + ch(0xd800) + "b")).toEqual("ab");
    expect(sanitizeXml("a" + ch(0xdc00) + "b")).toEqual("ab");
    // a valid surrogate pair (musical note emoji) survives intact
    const emoji = ch(0xd83c) + ch(0xdfb5);
    expect(sanitizeXml("x" + emoji + "y")).toEqual("x" + emoji + "y");
  });

  it("recurses into nested arrays and objects", () => {
    const input = {
      title: "x" + ch(4),
      items: [{ name: "y" + ch(0) }, { name: "z" }],
      meta: { deep: { s: "q" + ch(7) } },
    };
    expect(sanitizeXml(input)).toEqual({
      title: "x",
      items: [{ name: "y" }, { name: "z" }],
      meta: { deep: { s: "q" } },
    });
  });

  it("passes non-string primitives through unchanged", () => {
    expect(sanitizeXml(42)).toEqual(42);
    expect(sanitizeXml(true)).toEqual(true);
    expect(sanitizeXml(null)).toBeNull();
    expect(sanitizeXml(undefined)).toBeUndefined();
  });

  it("cleans a realistic mediaCollection page and only touches the bad field", () => {
    const clean = { itemType: "album", id: "album:2", title: "Good", artist: "Fine" };
    const result = sanitizeXml({
      count: 2,
      index: 0,
      total: 2,
      mediaCollection: [
        {
          itemType: "album",
          id: "album:1",
          title: "Awaken" + ch(4) + " My Love!",
          artist: "Childish" + ch(1) + " Gambino",
        },
        clean,
      ],
    });
    expect(result.mediaCollection[0].title).toEqual("Awaken My Love!");
    expect(result.mediaCollection[0].artist).toEqual("Childish Gambino");
    expect(result.mediaCollection[1]).toEqual(clean);
    expect(result.count).toEqual(2);
  });
});

describe("SMAPI element order (xs:sequence is mandatory)", () => {
  // The WSDL declares mediaList as an xs:sequence: index, then count, then total. We emitted
  // count first, because getMetadataResult built {count, index, total, ...} and the soap library
  // serializes object keys in insertion order. Every browse and search response bonob has ever
  // sent was therefore schema-invalid. Sonos S2 tolerates it, which is precisely why it went
  // unnoticed - and precisely why it is worth fixing before a firmware or a stricter client does
  // not. Found by validating 14 captured PRODUCTION responses against the WSDL schema.
  it("getMetadataResult emits index, count, total in WSDL order", () => {
    const keys = Object.keys(getMetadataResult({ mediaCollection: [] }).getMetadataResult);
    expect(keys.slice(0, 3)).toEqual(["index", "count", "total"]);
  });

  it("searchResult emits index, count, total in WSDL order", () => {
    const keys = Object.keys(searchResult({ mediaCollection: [] }).searchResult);
    expect(keys.slice(0, 3)).toEqual(["index", "count", "total"]);
  });

  it("still lets an explicit index/total override the defaults", () => {
    const r = getMetadataResult({ mediaCollection: [1, 2] as any[], index: 40, total: 900 })
      .getMetadataResult;
    expect(r.index).toEqual(40);
    expect(r.count).toEqual(2);
    expect(r.total).toEqual(900);
    expect(Object.keys(r).slice(0, 3)).toEqual(["index", "count", "total"]);
  });
});
