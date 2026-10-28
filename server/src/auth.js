import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { config } from "./config.js";

import {
  burnPasswordCheck,
  createRateLimiter,
  hashPassword,
  randomToken,
  safeEqual,
  verifyPassword
} from "./security.js";

import {
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  findUserByEmail,
  findUserByGoogle,
  normalizeEmail,
  publicUser,
  resolveSession,
  updateUser
} from "./store.js";

/* =========================================================
   VALIDATION
========================================================= */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

function cleanName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function validatePassword(password) {
  if (typeof password !== "string") {
    return "Senha inválida.";
  }

  if (password.length < 10) {
    return "A senha precisa ter pelo menos 10 caracteres.";
  }

  if (password.length > 128) {
    return "A senha pode ter no máximo 128 caracteres.";
  }

  return null;
}

/* =========================================================
   SESSION HELPERS
========================================================= */

function bearer(req) {
  const header = req.get("authorization") || "";

  return header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
}

export function requireAuth(req, res, next) {
  const session = resolveSession(bearer(req));

  if (!session) {
    return res.status(401).json({
      error: "Sessão expirada. Entre novamente."
    });
  }

  req.session = session;
  next();
}

async function issueSession(res, user) {
  const token = randomToken(32);

  await createSession(user.id, token);

  res.set("Cache-Control", "no-store");

  return res.json({
    token,
    user: publicUser(user)
  });
}

/* =========================================================
   GOOGLE
   Verifica o ID token (assinatura, emissor, audiência e
   validade) contra as chaves públicas do Google.
========================================================= */

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

async function verifyGoogleCredential(credential, nonce) {
  const { payload } = await jwtVerify(credential, googleKeys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: config.googleClientId,
    maxTokenAge: "10m"
  });

  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error("Conta Google sem e-mail verificado.");
  }

  /*
   * O nonce foi gerado pelo navegador que abriu o login: um
   * token capturado de outro lugar não serve aqui.
   */
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, nonce)) {
    throw new Error("Nonce inválido.");
  }

  return payload;
}

/* =========================================================
   ROUTER
========================================================= */

export function createAuthRouter({ onSessionsRevoked }) {
  const router = express.Router();

  const authLimited = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20
  });

  function limit(req, res, next) {
    if (authLimited(req.ip)) {
      return res.status(429).json({
        error: "Muitas tentativas. Aguarde alguns minutos."
      });
    }

    next();
  }

  router.get("/config", (_, res) => {
    res.json({
      google: Boolean(config.googleClientId)
    });
  });

  /* ---------------- SIGNUP ---------------- */

  router.post("/signup", limit, async (req, res) => {
    const name = cleanName(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (name.length < 2) {
      return res.status(400).json({
        error: "Digite um nome com pelo menos 2 caracteres."
      });
    }

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({
        error: "E-mail inválido."
      });
    }

    const passwordError = validatePassword(password);

    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    if (findUserByEmail(email)) {
      return res.status(409).json({
        error: "Já existe uma conta com esse e-mail. Tente entrar."
      });
    }

    const user = await createUser({
      name,
      email,
      passwordHash: await hashPassword(password)
    });

    return issueSession(res, user);
  });

  /* ---------------- LOGIN ---------------- */

  router.post("/login", limit, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "").slice(0, 128);

    const fail = () =>
      res.status(401).json({
        error: "E-mail ou senha incorretos."
      });

    const user = findUserByEmail(email);

    if (!user || !user.passwordHash) {
      await burnPasswordCheck(password);
      return fail();
    }

    if (user.lockedUntil > Date.now()) {
      return res.status(429).json({
        error: "Conta bloqueada temporariamente por excesso de tentativas."
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);

    if (!ok) {
      const failedLogins = (user.failedLogins || 0) + 1;

      await updateUser(user, {
        failedLogins,
        lockedUntil:
          failedLogins >= MAX_FAILED_LOGINS
            ? Date.now() + LOCK_MS
            : 0
      });

      return fail();
    }

    await updateUser(user, {
      failedLogins: 0,
      lockedUntil: 0
    });

    return issueSession(res, user);
  });

  /* ---------------- GOOGLE ---------------- */

  router.post("/google", limit, async (req, res) => {
    if (!config.googleClientId) {
      return res.status(503).json({
        error: "Login com Google não está configurado."
      });
    }

    const credential = String(req.body?.credential || "");
    const nonce = String(req.body?.nonce || "");

    if (
      !credential ||
      credential.length > 4096 ||
      !/^[a-f0-9]{48}$/.test(nonce)
    ) {
      return res.status(400).json({ error: "Credencial inválida." });
    }

    let profile;

    try {
      profile = await verifyGoogleCredential(credential, nonce);
    } catch {
      return res.status(401).json({
        error: "Não foi possível validar o login do Google."
      });
    }

    let user = findUserByGoogle(profile.sub);

    if (!user) {
      const existing = findUserByEmail(profile.email);

      if (existing) {
        /*
         * O cadastro por senha não prova posse do e-mail, mas o
         * Google prova. Ao vincular, a senha antiga é descartada
         * e todas as sessões caem — impede que alguém crie uma
         * conta com o e-mail de outra pessoa e espere ela logar.
         */
        await updateUser(existing, {
          googleSub: profile.sub,
          passwordHash: null,
          failedLogins: 0,
          lockedUntil: 0
        });

        const revoked = await deleteUserSessions(existing.id);
        onSessionsRevoked(revoked);

        user = existing;
      } else {
        user = await createUser({
          name: cleanName(profile.name) || profile.email.split("@")[0],
          email: profile.email,
          googleSub: profile.sub
        });
      }
    }

    return issueSession(res, user);
  });

  /* ---------------- SESSION ---------------- */

  router.get("/me", requireAuth, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ user: publicUser(req.session.user) });
  });

  router.post("/logout", requireAuth, async (req, res) => {
    await deleteSession(req.session.hash);
    onSessionsRevoked([req.session.hash]);

    res.json({ ok: true });
  });

  return router;
}
