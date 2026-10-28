import crypto from "node:crypto";
import { promisify } from "node:util";

import { config } from "./config.js";

const scrypt = promisify(crypto.scrypt);

/* =========================================================
   SUBCHAVES (HKDF a partir da MASTER_KEY)
========================================================= */

function deriveKey(label) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      config.masterKey,
      Buffer.alloc(0),
      `screencast/${label}/v1`,
      32
    )
  );
}

const DATA_KEY = deriveKey("data-encryption");
const INDEX_KEY = deriveKey("blind-index");
const PEPPER_KEY = deriveKey("password-pepper");

/* =========================================================
   TOKENS
========================================================= */

export function randomToken(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("base64url");
}

export function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("base64url");
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

/* =========================================================
   CIFRA EM REPOUSO (AES-256-GCM)
   Formato: v1.<iv>.<tag>.<ciphertext> (base64url)
   O AAD amarra o valor ao seu dono e campo, então um valor
   copiado para outro usuário/campo não decifra.
========================================================= */

export function encrypt(plaintext, aad) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    DATA_KEY,
    iv
  );

  cipher.setAAD(Buffer.from(aad));

  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final()
  ]);

  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function decrypt(payload, aad) {
  const [version, iv, tag, ciphertext] =
    String(payload).split(".");

  if (version !== "v1") {
    throw new Error("Formato de cifra desconhecido.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    DATA_KEY,
    Buffer.from(iv, "base64url")
  );

  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

/*
 * Índice cego: permite procurar um usuário pelo e-mail
 * sem guardar o e-mail em texto puro.
 */
export function blindIndex(kind, value) {
  return crypto
    .createHmac("sha256", INDEX_KEY)
    .update(`${kind}:${value}`)
    .digest("base64url");
}

/* =========================================================
   SENHAS (HMAC pepper + scrypt)
   N=2^16, r=8, p=1  → ~64 MiB por hash.
========================================================= */

const SCRYPT = {
  N: 2 ** 16,
  r: 8,
  p: 1,
  keylen: 32
};

function pepper(password) {
  return crypto
    .createHmac("sha256", PEPPER_KEY)
    .update(String(password).normalize("NFKC"))
    .digest();
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);

  const hash = await scrypt(
    pepper(password),
    salt,
    SCRYPT.keylen,
    {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 256 * SCRYPT.N * SCRYPT.r
    }
  );

  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, expected] =
    String(stored || "").split("$");

  if (scheme !== "scrypt") {
    return false;
  }

  const expectedBuffer =
    Buffer.from(expected, "base64url");

  const hash = await scrypt(
    pepper(password),
    Buffer.from(salt, "base64url"),
    expectedBuffer.length,
    {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * Number(N) * Number(r)
    }
  );

  return crypto.timingSafeEqual(hash, expectedBuffer);
}

/*
 * Hash descartável usado quando o e-mail não existe, para que
 * o tempo de resposta não revele quais e-mails têm conta.
 */
let dummyHash = null;

export async function burnPasswordCheck(password) {
  if (!dummyHash) {
    dummyHash = await hashPassword(randomToken());
  }

  await verifyPassword(password, dummyHash);
}

/* =========================================================
   RATE LIMIT (janela deslizante simples em memória)
========================================================= */

export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();

    for (const [key, list] of hits) {
      const fresh = list.filter(time => now - time < windowMs);

      if (fresh.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, fresh);
      }
    }
  }, windowMs).unref();

  return function limited(key) {
    const now = Date.now();

    const list = (hits.get(key) || [])
      .filter(time => now - time < windowMs);

    list.push(now);
    hits.set(key, list);

    return list.length > max;
  };
}
