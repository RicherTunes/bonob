import { randomBytes } from "crypto";

// Generate a random alphanumeric-ish string of the given length.
// Backed by crypto.randomBytes for cryptographic strength.
// Default length 32 matches the previous randomstring.generate() default.
export const generateRandomString = (length = 32): string =>
  randomBytes(Math.ceil(length * 0.75))
    .toString("base64url")
    .replace(/[-_]/g, "")
    .slice(0, length);

// Uniform random integer in [0, max). Backed by crypto.randomBytes and rejection-sampled so the
// modulo bias that `randomBytes % max` introduces cannot skew the result. Used to pick album
// offsets for the Random Albums section, where a biased sample would quietly favour part of the
// catalog forever.
export const randomInt = (max: number): number => {
  if (!Number.isFinite(max) || max <= 0) return 0;
  if (max === 1) return 0;
  const range = Math.ceil(Math.log2(max) / 8) || 1;
  const limit = Math.floor(256 ** range / max) * max;
  for (;;) {
    let value = 0;
    const bytes = randomBytes(range);
    for (let i = 0; i < range; i++) value = value * 256 + bytes[i]!;
    if (value < limit) return value % max;
  }
};
