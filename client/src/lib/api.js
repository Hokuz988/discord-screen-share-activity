/* =========================================================
   CONFIG
========================================================= */

/*
 * Dentro do Discord, o iframe só pode falar com o próprio
 * domínio (*.discordsays.com). O servidor é alcançado pelo
 * URL Mapping "/api" → seu servidor, configurado no
 * Developer Portal.
 */
export const IN_DISCORD =
  location.hostname.endsWith(".discordsays.com");

const DISCORD_PROXY = `${location.host}/.proxy/api`;

export const API_URL = IN_DISCORD
  ? `https://${DISCORD_PROXY}`
  : (
      import.meta.env.VITE_API_URL ||
      "https://screen-share-activity.onrender.com"
    ).replace(/\/+$/, "");

export const SIGNALING_URL = IN_DISCORD
  ? `wss://${DISCORD_PROXY}`
  : import.meta.env.VITE_SIGNALING_URL ||
    API_URL.replace(/^http/, "ws");

/* O popup do Google é bloqueado dentro do Discord. */
export const GOOGLE_CLIENT_ID = IN_DISCORD
  ? ""
  : import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

/* =========================================================
   SESSION TOKEN
========================================================= */

const TOKEN_KEY = "screencast.session";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {}
}

/* =========================================================
   REQUEST
========================================================= */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const token = getToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit"
    });
  } catch {
    throw new ApiError("Servidor indisponível. Tente de novo em instantes.", 0);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(data.error || `Erro ${response.status}`, response.status);
  }

  return data;
}

export const api = {
  signup: payload => request("/auth/signup", { method: "POST", body: payload }),
  login: payload => request("/auth/login", { method: "POST", body: payload }),
  google: (credential, nonce) => request("/auth/google", { method: "POST", body: { credential, nonce } }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  turn: () => request("/turn-credentials")
};
