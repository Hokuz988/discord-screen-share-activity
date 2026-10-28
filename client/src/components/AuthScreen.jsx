import React, { useEffect, useRef, useState } from "react";

import { api } from "../lib/api.js";
import { googleEnabled, renderGoogleButton } from "../lib/google.js";
import { EyeIcon, EyeOffIcon, LockIcon, MonitorIcon, ShieldIcon } from "./Icons.jsx";

/* =========================================================
   FORÇA DA SENHA (só indicativo; a regra real é no servidor)
========================================================= */

function passwordScore(password) {
  let score = 0;

  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;

  return score;
}

const SCORE_LABELS = ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"];

/* =========================================================
   GOOGLE BUTTON
========================================================= */

function GoogleButton({ mode, onCredential }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    renderGoogleButton(ref.current, {
      onCredential,
      text: mode === "signup" ? "signup_with" : "continue_with"
    }).catch(() => setFailed(true));
  }, [mode]);

  if (failed) {
    return (
      <p className="hint center">
        O login com Google não carregou aqui. Use e-mail e senha.
      </p>
    );
  }

  return <div className="google-slot" ref={ref} />;
}

/* =========================================================
   SCREEN
========================================================= */

export function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isSignup = mode === "signup";
  const score = passwordScore(password);

  function switchMode(next) {
    setMode(next);
    setError("");
  }

  async function finish(promise) {
    setLoading(true);
    setError("");

    try {
      const { token, user } = await promise;
      setPassword("");
      onAuthenticated(token, user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();

    if (loading) {
      return;
    }

    if (isSignup && password.length < 10) {
      setError("A senha precisa ter pelo menos 10 caracteres.");
      return;
    }

    finish(
      isSignup
        ? api.signup({ name, email, password })
        : api.login({ email, password })
    );
  }

  return (
    <main className="auth">
      <section className="auth-hero">
        <div className="brand">
          <span className="brand-mark"><MonitorIcon size={20} /></span>
          <span className="brand-name">ScreenCast</span>
        </div>

        <div className="auth-pitch">
          <h1>Sua tela, só para quem tem o convite.</h1>
          <p>
            Até 3 pessoas transmitindo ao mesmo tempo, direto no Discord.
            Vídeo ponta a ponta — nem o nosso servidor consegue ver.
          </p>
        </div>

        <ul className="auth-features">
          <li>
            <LockIcon size={20} />
            <div>
              <strong>Criptografia ponta a ponta</strong>
              <span>A chave da sala fica no convite, nunca no servidor.</span>
            </div>
          </li>
          <li>
            <ShieldIcon size={20} />
            <div>
              <strong>Senhas protegidas com scrypt</strong>
              <span>E-mail e nome cifrados em repouso com AES-256-GCM.</span>
            </div>
          </li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="segmented" role="tablist" aria-label="Modo">
            <button
              type="button"
              role="tab"
              aria-selected={!isSignup}
              className={!isSignup ? "active" : ""}
              onClick={() => switchMode("login")}
            >
              Entrar
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isSignup}
              className={isSignup ? "active" : ""}
              onClick={() => switchMode("signup")}
            >
              Criar conta
            </button>
          </div>

          <div className="auth-heading">
            <h2>{isSignup ? "Criar sua conta" : "Bem-vindo de volta"}</h2>
            <p>{isSignup ? "Leva menos de um minuto." : "Entre para criar ou assistir transmissões."}</p>
          </div>

          {googleEnabled && (
            <>
              <GoogleButton
                mode={mode}
                onCredential={credential => finish(api.google(credential))}
              />

              <div className="divider"><span>ou com e-mail</span></div>
            </>
          )}

          <form className="form" onSubmit={submit} noValidate>
            {isSignup && (
              <div className="field">
                <label htmlFor="auth-name">Nome de exibição</label>
                <input
                  id="auth-name"
                  type="text"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder="Como você quer aparecer"
                  maxLength={32}
                  autoComplete="nickname"
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="auth-email">E-mail</label>
              <input
                id="auth-email"
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="voce@exemplo.com"
                maxLength={254}
                autoComplete="email"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="auth-password">Senha</label>
              <div className="input-with-action">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={isSignup ? "Mínimo de 10 caracteres" : "Sua senha"}
                  maxLength={128}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  required
                />
                <button
                  type="button"
                  className="input-action"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  onClick={() => setShowPassword(value => !value)}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              {isSignup && password && (
                <div className="strength" aria-live="polite">
                  <div className="strength-bars">
                    {[0, 1, 2, 3].map(index => (
                      <span key={index} className={index < score ? `on s${score}` : ""} />
                    ))}
                  </div>
                  <span className="hint">{SCORE_LABELS[score]}</span>
                </div>
              )}
            </div>

            {error && <div className="alert" role="alert">{error}</div>}

            <button type="submit" className="btn btn-primary btn-lg" disabled={loading}>
              {loading ? "Aguarde…" : isSignup ? "Criar conta" : "Entrar"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
