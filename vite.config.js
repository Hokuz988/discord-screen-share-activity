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
 * Bloqueia scripts de terceiros, limitando o estrago de um XSS
 * (ex.: roubar o token de sessão).
 */
function contentSecurityPolicy(env) {
  const google = "https://accounts.google.com";

  const connect = [
    "'self'",
    origin(env.VITE_API_URL),
    origin(env.VITE_SIGNALING_URL),
    `${google}/gsi/`
  ].filter(Boolean);

  const policy = [
    "default-src 'self'",
    `script-src 'self' ${google}/gsi/client`,
    `style-src 'self' 'unsafe-inline' ${google}/gsi/style`,
    `frame-src ${google}/gsi/`,
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: https://*.googleusercontent.com",
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
