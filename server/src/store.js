import crypto from "node:crypto";

import { config } from "./config.js";
import { fileBackend, postgresBackend } from "./backends.js";

import {
  blindIndex,
  decrypt,
  encrypt,
  sha256
} from "./security.js";

/* =========================================================
   STORE
   Nenhum dado pessoal fica em texto puro: e-mail e nome são
   cifrados (AES-256-GCM), buscas usam índice cego (HMAC) e
   sessões guardam só o hash do token.

   Com DATABASE_URL usa Postgres (ex.: Neon grátis); sem ela,
   um arquivo JSON local.
========================================================= */

let backend = null;

let data = {
  users: {},
  sessions: {}
};

const byEmail = new Map();
const byGoogle = new Map();

function indexUser(user, previous = {}) {
  if (previous.emailIdx && previous.emailIdx !== user.emailIdx) {
    byEmail.delete(previous.emailIdx);
  }

  if (previous.googleIdx && previous.googleIdx !== user.googleIdx) {
    byGoogle.delete(previous.googleIdx);
  }

  if (user.emailIdx) {
    byEmail.set(user.emailIdx, user.id);
  }

  if (user.googleIdx) {
    byGoogle.set(user.googleIdx, user.id);
  }
}

function reindex() {
  byEmail.clear();
  byGoogle.clear();

  for (const user of Object.values(data.users)) {
    indexUser(user);
  }
}

function background(promise) {
  promise.catch(error => {
    console.error("[STORE] falha ao salvar:", error.message);
  });
}

export async function loadStore() {
  backend = config.databaseUrl
    ? await postgresBackend(config.databaseUrl)
    : fileBackend(config.dataDir);

  data = await backend.load();

  reindex();
  pruneSessions();

  console.log(
    `[STORE] ${Object.keys(data.users).length} contas carregadas (${backend.name})`
  );
}

/* =========================================================
   USERS
========================================================= */

export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

export function findUserByEmail(email) {
  const id = byEmail.get(
    blindIndex("email", normalizeEmail(email))
  );

  return id ? data.users[id] : null;
}

export function findUserByGoogle(sub) {
  const id = byGoogle.get(blindIndex("google", sub));

  return id ? data.users[id] : null;
}

export async function createUser({
  name,
  email,
  passwordHash = null,
  googleSub = null
}) {
  const id = crypto.randomUUID();
  const normalized = normalizeEmail(email);

  const user = {
    id,
    emailIdx: blindIndex("email", normalized),
    emailEnc: encrypt(normalized, `email:${id}`),
    nameEnc: encrypt(name, `name:${id}`),
    passwordHash,
    googleIdx: googleSub ? blindIndex("google", googleSub) : null,
    failedLogins: 0,
    lockedUntil: 0,
    createdAt: Date.now()
  };

  await backend.saveUser(user);

  data.users[id] = user;
  indexUser(user);

  return user;
}

export async function updateUser(user, changes) {
  const next = { ...changes };

  if ("googleSub" in next) {
    next.googleIdx = next.googleSub
      ? blindIndex("google", next.googleSub)
      : null;

    delete next.googleSub;
  }

  /* Login normal zera contadores que já estão zerados: não grava. */
  if (Object.entries(next).every(([key, value]) => user[key] === value)) {
    return user;
  }

  const previous = {
    emailIdx: user.emailIdx,
    googleIdx: user.googleIdx
  };

  Object.assign(user, next);
  indexUser(user, previous);

  await backend.saveUser(user);

  return user;
}

export function publicUser(user) {
  return {
    id: user.id,
    name: decrypt(user.nameEnc, `name:${user.id}`),
    email: decrypt(user.emailEnc, `email:${user.id}`),
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleIdx)
  };
}

/* =========================================================
   SESSIONS
   O token só existe no cliente; aqui fica o SHA-256 dele.
========================================================= */

export async function createSession(userId, token) {
  const hash = sha256(token);

  const session = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.sessionTtlMs
  };

  await backend.saveSession(hash, session);

  data.sessions[hash] = session;
}

export function resolveSession(token) {
  if (!token || typeof token !== "string" || token.length > 128) {
    return null;
  }

  const hash = sha256(token);
  const session = data.sessions[hash];

  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    delete data.sessions[hash];
    background(backend.deleteSessions([hash]));
    return null;
  }

  const user = data.users[session.userId];

  return user ? { hash, user } : null;
}

export async function deleteSession(hash) {
  delete data.sessions[hash];
  await backend.deleteSessions([hash]);
}

export async function deleteUserSessions(userId) {
  const removed = Object.entries(data.sessions)
    .filter(([, session]) => session.userId === userId)
    .map(([hash]) => hash);

  for (const hash of removed) {
    delete data.sessions[hash];
  }

  await backend.deleteSessions(removed);

  return removed;
}

function pruneSessions() {
  const now = Date.now();

  const expired = Object.entries(data.sessions)
    .filter(([, session]) => session.expiresAt < now)
    .map(([hash]) => hash);

  for (const hash of expired) {
    delete data.sessions[hash];
  }

  if (expired.length > 0) {
    background(backend.deleteSessions(expired));
  }
}

setInterval(pruneSessions, 60 * 60 * 1000).unref();
