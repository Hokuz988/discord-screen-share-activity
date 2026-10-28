import { GOOGLE_CLIENT_ID } from "./api.js";

/* =========================================================
   GOOGLE IDENTITY SERVICES
   O Google devolve um ID token assinado; o servidor valida a
   assinatura e a audiência antes de aceitar.
========================================================= */

let loading = null;

function loadScript() {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }

  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");

      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => {
        loading = null;
        reject(new Error("Não foi possível carregar o login do Google."));
      };

      document.head.appendChild(script);
    });
  }

  return loading;
}

export const googleEnabled = Boolean(GOOGLE_CLIENT_ID);

export async function renderGoogleButton(element, { onCredential, text }) {
  await loadScript();

  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: response => onCredential(response.credential),
    ux_mode: "popup",
    auto_select: false,
    cancel_on_tap_outside: true,
    use_fedcm_for_prompt: true
  });

  element.replaceChildren();

  window.google.accounts.id.renderButton(element, {
    type: "standard",
    theme: "filled_black",
    size: "large",
    shape: "rectangular",
    text,
    logo_alignment: "center",
    width: Math.min(element.clientWidth || 400, 400)
  });
}

export function googleSignOut() {
  window.google?.accounts?.id?.disableAutoSelect();
}
