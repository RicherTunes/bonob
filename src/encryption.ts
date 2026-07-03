import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "crypto";
import { option as O, either as E } from "fp-ts";
import { Either, left, right } from 'fp-ts/Either'
import { pipe } from "fp-ts/lib/function";
import jws from "jws";

const ALGORITHM = "aes-256-cbc";
const IV = randomBytes(16);

export type Hash = {
  iv: string;
  encryptedData: string;
};

export type Encryption = {
  encrypt: (value: string) => string;
  decrypt: (value: string) => Either<string, string>;
};

export const jwsEncryption = (secret: string): Encryption => {
  return {
    encrypt: (value: string) => jws.sign({
      header: { alg: 'HS256' },
      payload: value,
      secret: secret,
    }),
    decrypt: (value: string) => {
      // Verify the signature with a pinned algorithm BEFORE trusting the payload.
      // jws.decode() alone does not verify, so without this a client could forge a
      // token (e.g. alg:none) and have its payload accepted. Pinning HS256 also
      // prevents algorithm-confusion attacks.
      try {
        if (!jws.verify(value, "HS256", secret)) {
          return left("Invalid signature");
        }
      } catch {
        return left("Invalid signature");
      }
      return pipe(
        jws.decode(value),
        O.fromNullable,
        O.map(it => it.payload),
        O.match(
          () => left("Failed to decrypt jws"),
          (payload) => right(payload)
        )
      );
    }
  }
}

export const cryptoEncryption = (secret: string): Encryption => {
  const key = createHash("sha256")
    .update(String(secret))
    .digest("base64")
    .substring(0, 32);

  return {
    encrypt: (value: string) => {
      const cipher = createCipheriv(ALGORITHM, key, IV);
      return `${IV.toString("hex")}.${Buffer.concat([
        cipher.update(value),
        cipher.final(),
      ]).toString("hex")}`;
    },
    decrypt: (value: string) => pipe(
      right(value),
      E.map(it => it.split(".")),
      E.flatMap(it => it.length == 2 ? right({ iv: it[0]!, data: it[1]! }) : left("Invalid value to decrypt")),
      E.map(it => ({
        hash: it,
        decipher: createDecipheriv(
          ALGORITHM,
          key,
          Buffer.from(it.iv, "hex")
        )
      })),
      E.map(it => Buffer.concat([
        it.decipher.update(Buffer.from(it.hash.data, "hex")),
        it.decipher.final(),
      ]).toString())
    ),
  };
};

export default jwsEncryption;
