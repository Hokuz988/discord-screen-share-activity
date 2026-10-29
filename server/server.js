import http from "node:http";

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { config } from "./src/config.js";
import { createAuthRouter, requireAuth } from "./src/auth.js";
import { attachSignaling } from "./src/signaling.js";
import { createRateLimiter } from "./src/security.js";
import { loadStore } from "./src/store.js";

/* =========================================================
   APP
========================================================= */

await loadStore();

const app = express();
const server = http.createServer(app);

const signaling = attachSignaling(server);

if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(
  cors({
    origin:
      config.allowedOrigins.length > 0
        ? config.allowedOrigins
        : true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600
  })
);

app.use(express.json({ limit: "16kb" }));

/* =========================================================
   HTTP
========================================================= */

app.get("/health", (_, res) => {
  res.json({ ok: true, ...signaling.stats() });
});

app.use(
  "/auth",
  createAuthRouter({
    onSessionsRevoked: hashes => signaling.closeSessions(hashes)
  })
);

/* =========================================================
   TURN
   Só para usuários logados — antes qualquer um podia gerar
   credenciais TURN na sua conta Cloudflare.
========================================================= */

const turnLimited = createRateLimiter({
  windowMs: 60_000,
  max: 20
});

app.get("/turn-credentials", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (turnLimited(req.session.user.id)) {
    return res.status(429).json({ error: "Muitas requisições." });
  }

  if (!config.turnKeyId || !config.turnApiToken) {
    return res.status(503).json({ error: "TURN não configurado." });
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.turnKeyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.turnApiToken}`,
        "Content-Type": "application/json"
      },
      /*
       * Credencial vencida derruba transmissões longas que passam
       * pelo TURN (a alocação não renova). 6 h cobre uma sessão de
       * jogo; o cliente busca credenciais novas a cada 10 min.
       */
      body: JSON.stringify({ ttl: 6 * 60 * 60 })
    }
  );

  if (!response.ok) {
    console.error("[TURN] Cloudflare respondeu", response.status);
    return res.status(502).json({ error: "Falha ao gerar credenciais TURN." });
  }

  return res.json(await response.json());
});

/* =========================================================
   ERRORS
========================================================= */

app.use((_, res) => {
  res.status(404).json({ error: "Não encontrado." });
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Requisição grande demais." });
  }

  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON inválido." });
  }

  if (error?.status === 503) {
    return res.status(503).json({ error: error.message });
  }

  console.error("[HTTP]", error?.message || error);
  res.status(500).json({ error: "Erro interno." });
});

/* =========================================================
   START
========================================================= */

server.listen(config.port, "0.0.0.0", () => {
  console.log(`ScreenCast server em :${config.port}`);
  console.log(` Google login: ${config.googleClientId ? "on" : "off"}`);
  console.log(` TURN: ${config.turnKeyId ? "on" : "off"}`);
  console.log(` Origens: ${config.allowedOrigins.join(", ") || "*"}`);
});
