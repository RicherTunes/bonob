import { option as O } from "fp-ts";
import { Either, left, right } from 'fp-ts/Either'
import { pipe } from "fp-ts/lib/function";
import jws from "jws";

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

// REMOVED: cryptoEncryption. It had no callers anywhere in src/ - only its own tests kept it
// alive - and it carried a real crypto defect waiting for whoever adopted it next: a MODULE-LEVEL
// `const IV = randomBytes(16)` reused for every encryption in the process, plus a key derived by
// truncating base64 of a sha256. Reusing an IV across messages under one key is exactly what CBC
// mode must not do. Dead code with a landmine in it is worse than no code, so it is gone rather
// than fixed: nothing needs it.

export default jwsEncryption;
