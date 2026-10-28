import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/*
 * CSP só no build: em dev o Vite injeta scripts inline (HMR).
 * Bloqueia qualquer script de terceiros, limitando o estrago
 * de um XSS (ex.: roubar o token de sessão).
 */
function contentSecurityPolicy(env) {
  const apiOrigin = origin(
    env.VITE_API_URL || "https://screen-share-activity.onrender.com"
  );

  const connect = [
    "'self'",
    apiOrigin,
    apiOrigin.replace(/^http/, "ws"),
    origin(env.VITE_SIGNALING_URL)
  ].filter(Boolean);

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'none'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join("; ");

  return {
    name: "csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      );
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    plugins: [react(), contentSecurityPolicy(env)],
    server: {
      port: 5173,
      host: "0.0.0.0"
    },
    build: {
      sourcemap: false
    }
  };
});
