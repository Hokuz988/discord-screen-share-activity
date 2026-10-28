/* =========================================================
   CRIPTOGRAFIA PONTA A PONTA DA SALA

   Convite = "<CÓDIGO>.<CHAVE>"
   - CÓDIGO vai para o servidor (identifica a sala).
   - CHAVE (256 bits aleatórios) nunca sai do navegador.

   Da chave derivamos (HKDF-SHA256, amarrado ao código):
   - uma chave AES-256-GCM que cifra ofertas/respostas WebRTC;
   - um "keyCheck" (HMAC) que o servidor usa para recusar quem
     não tem o convite completo, sem conseguir obter a chave.

   O SDP carrega o fingerprint DTLS que protege o vídeo. Como
   ele só trafega cifrado e autenticado, nem o servidor de
   sinalização consegue se colocar no meio da conexão.
========================================================= */

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_SIGNAL_AGE_MS = 2 * 60 * 1000;

function toBase64Url(bytes) {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));

  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/* =========================================================
   INVITE
========================================================= */

export function generateRoomSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function formatInvite(code, secret) {
  return `${code}.${secret}`;
}

export function parseInvite(value) {
  const match = String(value || "")
    .trim()
    .match(/([A-Za-z0-9]{6,12})\.([A-Za-z0-9_-]{43})/);

  if (!match) {
    return null;
  }

  return {
    code: match[1].toUpperCase(),
    secret: match[2]
  };
}

/* =========================================================
   KEYS
========================================================= */

async function hkdf(secret, info, usage) {
  const base = await subtle.importKey(
    "raw",
    fromBase64Url(secret),
    "HKDF",
    false,
    ["deriveKey", "deriveBits"]
  );

  const params = {
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("screencast-room-v1"),
    info: encoder.encode(info)
  };

  if (usage === "bits") {
    return subtle.deriveBits(params, base, 256);
  }

  return subtle.deriveKey(
    params,
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/*
 * O keyCheck não depende do código (que só existe depois que o
 * servidor cria a sala), então é calculado direto da chave.
 */
export async function computeKeyCheck(secret) {
  return toBase64Url(await hkdf(secret, "key-check", "bits"));
}

export async function createRoomCipher(secret, code) {
  const key = await hkdf(secret, `signal:${code}`, "key");

  return {
    async seal(message, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const plaintext = encoder.encode(
        JSON.stringify({ ...message, ts: Date.now() })
      );

      const ciphertext = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
        key,
        plaintext
      );

      return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
    },

    /*
     * context = sala|de|para|producer|tipo. Se o servidor trocar
     * remetente, destino ou tipo, a autenticação do GCM falha.
     */
    async open(payload, context) {
      const [iv, ciphertext] = String(payload).split(".");

      const plaintext = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(iv),
          additionalData: encoder.encode(context)
        },
        key,
        fromBase64Url(ciphertext)
      );

      const message = JSON.parse(decoder.decode(plaintext));

      if (Math.abs(Date.now() - Number(message.ts)) > MAX_SIGNAL_AGE_MS) {
        throw new Error("Sinal expirado.");
      }

      return message;
    }
  };
}

export function signalContext({ code, from, to, producerId, kind }) {
  return [code, from, to, producerId, kind].join("|");
}
