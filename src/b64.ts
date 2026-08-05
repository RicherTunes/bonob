export const b64Encode = (value: string) => Buffer.from(value).toString("base64");
// UTF-8, not "ascii". Genre ids are b64Encode(genreName), and decoding as ascii MASKS THE HIGH BIT
// of every byte, so every accented or non-Latin genre decoded to garbage and the browse asked
// Navidrome for a genre that does not exist. Measured on a 1444-genre French-language library: 24
// genres broken and 141 albums unreachable, silently - the empty result was then cached and
// persisted, so it survived restarts. The same decoder sits under the legacy token path, where an
// accented password would have failed to authenticate for the same reason.
export const b64Decode = (value: string) => Buffer.from(value, "base64").toString("utf8");