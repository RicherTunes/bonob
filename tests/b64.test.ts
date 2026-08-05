import { b64Encode, b64Decode } from "../src/b64";

describe("b64", () => {
    const value = "foobar100";
    const encoded = Buffer.from(value).toString("base64");

    describe("encode", () => {
        it("should encode", () => {
            expect(b64Encode(value)).toEqual(encoded);
        });
    });
    describe("decode", () => {
        it("should decode", () => {
            expect(b64Decode(encoded)).toEqual(value);
        });
    });

    // Genre ids are minted as b64Encode(genreName) and decoded back before being sent to
    // getAlbumList2. Decoding as "ascii" masks the high bit of every byte, so every non-ASCII
    // genre asked Navidrome for a genre that does not exist and browsed to an empty list -
    // silently, and the empty page was then cached AND persisted, so it survived restarts.
    //
    // Measured on the live library: 24 of 1444 genres affected, 141 albums unreachable through
    // them. The accented "Electronique" decoded to a string containing a literal TAB, produced by
    // the masked UTF-8 continuation byte.
    describe("non-ASCII round trip", () => {
        it.each([
            "Électronique",
            "Chanson française",
            "Musique concrète",
            "Québécois",
            "Musiques de Noël",
            "日本語",
            "🎵 emoji genre",
        ])("round-trips %s unchanged", (v) => {
            expect(b64Decode(b64Encode(v))).toEqual(v);
        });

        it("never yields a control character from a valid non-ASCII round trip", () => {
            // The old decoder produced a TAB inside the accented genre name; a control character
            // would then also be stripped by sanitizeXml downstream, compounding the corruption.
            const out = b64Decode(b64Encode("Électronique"));
            const hasControlChar = out
                .split("")
                .some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
            expect(hasControlChar).toBe(false);
        });
    });
});