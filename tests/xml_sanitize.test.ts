import { sanitizeXml, getMetadataResult, searchResult, inSmapiOrder, orderEmittedMedia } from "../src/smapi";

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

describe("media element ordering against the WSDL", () => {
  // AbstractMedia is an xs:sequence: id, itemType, ... title ... and mediaCollection extends it
  // with artist/artistId ... canPlay ... albumArtURI. Every tile builder emitted itemType BEFORE
  // id, so every tile bonob ever sent was schema-invalid. Rather than hand-reorder each builder
  // (and have the next one drift again), ordering is applied centrally to every emitted item.
  it("puts id before itemType and title after both", () => {
    const ordered = inSmapiOrder({
      itemType: "album",
      albumArtURI: "http://art",
      title: "In Rainbows",
      id: "album:1",
      artistId: "artist:1",
      artist: "Radiohead",
      canPlay: true,
    });
    expect(Object.keys(ordered)).toEqual([
      "id",
      "itemType",
      "title",
      "artist",
      "artistId",
      "canPlay",
      "albumArtURI",
    ]);
  });

  // trackMetadata has its OWN sequence and reuses names (artist, album, albumArtURI) at different
  // positions than mediaCollection, so it must be ordered by its own list. These fields only ever
  // appear NESTED - an earlier version of this test ordered them at the top level, which is a
  // shape bonob never emits.
  it("keeps nested trackMetadata fields in trackMetadata order", () => {
    const ordered: any = inSmapiOrder({
      itemType: "track",
      id: "track:1",
      title: "A Song",
      trackMetadata: {
        trackNumber: 3,
        albumArtURI: "http://art",
        duration: 240,
        artist: "An Artist",
        artistId: "artist:1",
        album: "An Album",
        albumId: "album:1",
      },
    });
    expect(Object.keys(ordered.trackMetadata)).toEqual([
      "artistId",
      "artist",
      "albumId",
      "album",
      "duration",
      "albumArtURI",
      "trackNumber",
    ]);
  });

  it("preserves unknown keys (attributes, nested objects) rather than dropping them", () => {
    const ordered = inSmapiOrder({
      itemType: "playlist",
      attributes: { readOnly: false },
      id: "playlist:1",
      title: "Road trip",
    });
    expect(Object.keys(ordered)).toContain("attributes");
    expect((ordered as any).attributes).toEqual({ readOnly: false });
    expect(Object.keys(ordered).indexOf("id")).toBeLessThan(
      Object.keys(ordered).indexOf("itemType")
    );
  });

  it("orders nested trackMetadata too", () => {
    const ordered: any = inSmapiOrder({
      itemType: "track",
      id: "track:1",
      title: "All I Need",
      mimeType: "audio/flac",
      trackMetadata: { trackNumber: 5, artistId: "artist:1", album: "X" },
    });
    expect(Object.keys(ordered.trackMetadata)).toEqual([
      "artistId",
      "album",
      "trackNumber",
    ]);
  });
});


describe("orderEmittedMedia covers a bare media body", () => {
  // getMediaMetadataResult's body IS the media item, not a wrapper containing mediaCollection or
  // mediaMetadata. The first version only looked for those two key NAMES, so the PLAYBACK metadata
  // path silently bypassed ordering entirely - the exact id-before-itemType violation the ordering
  // work set out to remove, still live, while the comment claimed the path was covered.
  it("orders a track envelope whose body is the item itself", () => {
    const out: any = orderEmittedMedia({
      getMediaMetadataResult: {
        itemType: "track",
        id: "track:1",
        mimeType: "audio/flac",
        title: "A Song",
        trackMetadata: { albumArtURI: "x", artistId: "a", trackNumber: 2, albumId: "al" },
      },
    });
    expect(Object.keys(out.getMediaMetadataResult).slice(0, 2)).toEqual(["id", "itemType"]);
    expect(Object.keys(out.getMediaMetadataResult.trackMetadata)).toEqual([
      "artistId",
      "albumId",
      "albumArtURI",
      "trackNumber",
    ]);
  });

  it("orders a radio station envelope body too", () => {
    const out: any = orderEmittedMedia({
      getMediaMetadataResult: { itemType: "stream", id: "radio:1", title: "A Station", mimeType: "audio/mpeg" },
    });
    expect(Object.keys(out.getMediaMetadataResult).slice(0, 2)).toEqual(["id", "itemType"]);
  });

  it("still orders a wrapper body (getExtendedMetadataResult)", () => {
    const out: any = orderEmittedMedia({
      getExtendedMetadataResult: {
        mediaCollection: { itemType: "album", id: "album:1", title: "An Album" },
      },
    });
    expect(Object.keys(out.getExtendedMetadataResult.mediaCollection).slice(0, 2)).toEqual([
      "id",
      "itemType",
    ]);
  });
});
