import crypto from "node:crypto";
import path from "node:path";

/* =========================================================
   ENV
========================================================= */

const isProduction =
  process.env.NODE_ENV === "production";

function list(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

/*
 * MASTER_KEY: 32+ bytes em base64.
 * Gere com:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Todas as chaves (cifra dos dados, índice cego, pepper das senhas)
 * são derivadas dela via HKDF. Perder essa chave = perder os dados.
 */
function loadMasterKey() {
  const raw = process.env.MASTER_KEY;

  if (raw) {
    /*
     * Aceita base64 de 32+ bytes ou qualquer segredo aleatório
     * de 32+ caracteres (ex.: o botão "Generate" do Render). A
     * chave só alimenta o HKDF, então os bytes brutos servem.
     */
    const decoded = Buffer.from(raw, "base64");

    if (
      decoded.length >= 32 &&
      decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")
    ) {
      return decoded;
    }

    if (raw.length >= 32) {
      return Buffer.from(raw, "utf8");
    }

    throw new Error(
      "MASTER_KEY curta demais: use pelo menos 32 caracteres aleatórios."
    );
  }

  if (isProduction) {
    throw new Error(
      "MASTER_KEY não configurada. Defina-a antes de subir em produção."
    );
  }

  console.warn(
    "[CONFIG] MASTER_KEY ausente — usando chave temporária. " +
    "Contas criadas agora ficarão ilegíveis após reiniciar."
  );

  return crypto.randomBytes(32);
}

export const config = {
  isProduction,

  port:
    Number(process.env.PORT) || 8787,

  masterKey:
    loadMasterKey(),

  /*
   * Origens autorizadas (CORS + WebSocket).
   * Ex.: https://SEU_CLIENT_ID.discordsays.com,http://localhost:5173
   * Vazio = qualquer origem (aceitável só em desenvolvimento).
   */
  allowedOrigins:
    list(process.env.ALLOWED_ORIGINS),

  /*
   * Atrás de proxy (Render, Fly, Nginx) o IP real vem em
   * X-Forwarded-For. Necessário para o rate limit funcionar.
   */
  trustProxy:
    (process.env.TRUST_PROXY ?? (isProduction ? "1" : "0")) === "1",

  googleClientId:
    process.env.GOOGLE_CLIENT_ID || "",

  turnKeyId:
    process.env.TURN_KEY_ID || "",

  turnApiToken:
    process.env.TURN_API_TOKEN || "",

  /*
   * Postgres (ex.: Neon grátis). Sem isso, usa arquivo local —
   * que some a cada deploy em hospedagens grátis.
   */
  databaseUrl:
    process.env.DATABASE_URL || "",

  dataDir:
    path.resolve(
      process.env.DATA_DIR || "./data"
    ),

  sessionTtlMs:
    7 * 24 * 60 * 60 * 1000,

  maxProducers: 3
};

if (isProduction && !config.databaseUrl) {
  console.warn(
    "[CONFIG] DATABASE_URL vazio — contas em arquivo local, que some a cada deploy."
  );
}

if (
  isProduction &&
  config.allowedOrigins.length === 0
) {
  console.warn(
    "[CONFIG] ALLOWED_ORIGINS vazio — qualquer site poderá chamar a API."
  );
}
