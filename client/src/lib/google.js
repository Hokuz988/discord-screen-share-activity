import { GOOGLE_CLIENT_ID } from "./api.js";

/* =========================================================
   LOGIN COM GOOGLE (OpenID Connect, popup)
   Abre a tela de login do Google numa janela. Ela volta para
   /google-callback.html, que devolve o ID token por um
   BroadcastChannel (funciona mesmo quando o Google corta o
   window.opener). O servidor valida assinatura, audiência e
   o nonce antes de aceitar.

   Nenhum script do Google roda no site.
========================================================= */

export const googleEnabled = Boolean(GOOGLE_CLIENT_ID);

const CHANNEL = "screencast-google-auth";
const TIMEOUT_MS = 5 * 60 * 1000;

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));

  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function openCentered(url) {
  const width = 500;
  const height = 640;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  return window.open(
    url,
    "google-login",
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`
  );
}

/*
 * Precisa ser chamado direto no clique, senão o navegador
 * bloqueia o popup.
 */
export function signInWithGoogle() {
  const state = randomString();
  const nonce = randomString();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${location.origin}/google-callback.html`,
    response_type: "id_token",
    scope: "openid email profile",
    prompt: "select_account",
    state,
    nonce
  });

  const popup = openCentered(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  );

  if (!popup) {
    return Promise.reject(
      new Error("O navegador bloqueou a janela do Google. Libere popups e tente de novo.")
    );
  }

  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL);

    const finish = (error, value) => {
      clearTimeout(timeout);
      channel.close();

      try {
        popup.close();
      } catch {}

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    channel.onmessage = event => {
      const data = event.data || {};

      if (data.state !== state) {
        return;
      }

      if (data.error || !data.idToken) {
        finish(
          new Error(
            data.error === "access_denied"
              ? "Login com Google cancelado."
              : "O Google não concluiu o login. Tente de novo."
          )
        );
        return;
      }

      finish(null, { credential: data.idToken, nonce });
    };

    /*
     * Não dá para detectar a janela fechada: o Google corta o
     * vínculo com o popup (COOP) e popup.closed vira true na
     * hora. Por isso a tela não trava esperando — o usuário pode
     * clicar de novo a qualquer momento.
     */
    const timeout = setTimeout(() => {
      finish(new Error("O login com Google expirou. Tente de novo."));
    }, TIMEOUT_MS);
  });
}
