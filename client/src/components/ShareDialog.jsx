import React, { useEffect, useRef, useState } from "react";

import { IN_DISCORD } from "../lib/api.js";
import { QUALITY_PRESETS } from "../hooks/useRoom.js";
import { MonitorIcon } from "./Icons.jsx";

const PREFS_KEY = "screencast.share-prefs";

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");

    return {
      quality: QUALITY_PRESETS[saved.quality] ? saved.quality : "balanced",
      audio: ["none", "tab", "system"].includes(saved.audio) ? saved.audio : "tab"
    };
  } catch {
    return { quality: "balanced", audio: "tab" };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

const canExcludeOwnAudio = Boolean(
  navigator.mediaDevices?.getSupportedConstraints?.().restrictOwnAudio
);

function systemAudioDetail() {
  if (canExcludeOwnAudio && IN_DISCORD) {
    return "Tudo que toca no PC, menos o som do próprio Discord (a call).";
  }

  if (canExcludeOwnAudio) {
    return "Tudo que toca no PC, menos este navegador. Se o Discord estiver aberto, a call entra.";
  }

  return "Tudo que toca no PC — inclusive a call do Discord, se estiver aberta.";
}

const AUDIO_OPTIONS = [
  { id: "none", label: "Sem áudio", detail: () => "Só a imagem." },
  { id: "tab", label: "Som da aba (recomendado)", detail: () => "Só o que toca na aba escolhida. Nunca inclui o Discord." },
  { id: "system", label: "Som do computador", detail: systemAudioDetail }
];

export function ShareDialog({ onConfirm, onClose }) {
  const ref = useRef(null);
  const [prefs, setPrefs] = useState(loadPrefs);

  useEffect(() => {
    const dialog = ref.current;

    dialog?.showModal();

    return () => dialog?.close();
  }, []);

  function confirm(event) {
    event.preventDefault();
    savePrefs(prefs);
    onConfirm(prefs);
  }

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="share-title"
      onClose={onClose}
      onClick={event => event.target === ref.current && onClose()}
    >
      <form className="modal-body" onSubmit={confirm}>
        <div className="modal-head">
          <div>
            <h2 id="share-title">Compartilhar tela</h2>
            <p>Escolha a qualidade e o som antes de selecionar a tela.</p>
          </div>
          <button type="button" className="icon-btn ghost" aria-label="Fechar" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <fieldset className="choice-group">
          <legend>Qualidade</legend>
          <div className="choice-grid">
            {Object.entries(QUALITY_PRESETS).map(([id, preset]) => (
              <label key={id} className={`choice-card ${prefs.quality === id ? "checked" : ""}`}>
                <input
                  type="radio"
                  name="quality"
                  value={id}
                  checked={prefs.quality === id}
                  onChange={() => setPrefs(current => ({ ...current, quality: id }))}
                />
                <strong>{preset.label}</strong>
                <span>{preset.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice-group">
          <legend>Áudio</legend>
          {AUDIO_OPTIONS.map(option => (
            <label key={option.id} className={`choice-row ${prefs.audio === option.id ? "checked" : ""}`}>
              <input
                type="radio"
                name="audio"
                value={option.id}
                checked={prefs.audio === option.id}
                onChange={() => setPrefs(current => ({ ...current, audio: option.id }))}
              />
              <span className="radio-dot" aria-hidden="true" />
              <span className="choice-text">
                <strong>{option.label}</strong>
                <span>{option.detail()}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="notice compact">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
          <p>
            {prefs.audio === "tab"
              ? "No seletor, escolha a aba “Guia do Chrome” e marque “Compartilhar áudio da aba”."
              : "Para nunca vazar a call do Discord, prefira compartilhar uma aba com o som da aba."}
          </p>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-secondary btn-lg" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-lg" autoFocus>
            <MonitorIcon size={16} />
            Escolher tela
          </button>
        </div>
      </form>
    </dialog>
  );
}
