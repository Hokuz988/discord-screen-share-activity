import React, { useEffect, useRef, useState } from "react";

import { IN_DISCORD } from "../lib/api.js";
import { QUALITY_PRESETS } from "../hooks/useRoom.js";

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
    return "Tudo que toca no PC, menos o som do próprio Discord.";
  }

  if (canExcludeOwnAudio) {
    return "Tudo que toca no PC, menos este navegador. A call do Discord pode entrar.";
  }

  return "Tudo que toca no PC, inclusive a call do Discord.";
}

const AUDIO_OPTIONS = [
  { id: "tab", label: "Som da aba", detail: () => "Só o som da aba escolhida. O Discord nunca entra." },
  { id: "system", label: "Som do computador", detail: systemAudioDetail },
  { id: "none", label: "Sem som", detail: () => "Só a imagem." }
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
      className="dialog"
      aria-labelledby="share-title"
      onClose={onClose}
      onClick={event => event.target === ref.current && onClose()}
    >
      <form className="dialog-body" onSubmit={confirm}>
        <h2 id="share-title">Compartilhar tela</h2>

        <fieldset className="options">
          <legend>Qualidade</legend>
          <div className="segmented">
            {Object.entries(QUALITY_PRESETS).map(([id, preset]) => (
              <label key={id} className={prefs.quality === id ? "checked" : ""}>
                <input
                  type="radio"
                  name="quality"
                  value={id}
                  checked={prefs.quality === id}
                  onChange={() => setPrefs(current => ({ ...current, quality: id }))}
                />
                <span>{preset.label}</span>
                <span className="fine mono">{preset.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="options">
          <legend>Som</legend>
          <div className="radio-list">
            {AUDIO_OPTIONS.map(option => (
              <label key={option.id} className={prefs.audio === option.id ? "checked" : ""}>
                <input
                  type="radio"
                  name="audio"
                  value={option.id}
                  checked={prefs.audio === option.id}
                  onChange={() => setPrefs(current => ({ ...current, audio: option.id }))}
                />
                <span className="radio-label">
                  <span>{option.label}</span>
                  <span className="fine">{option.detail()}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="fine">
          {prefs.audio === "tab"
            ? "No seletor, abra “Guia do Chrome” e marque “Compartilhar áudio da aba”. "
            : "Vai transmitir um jogo? "}
          <a href="/guia-audio.html" target="_blank" rel="noopener noreferrer">
            Como tirar o som do Discord
          </a>
        </p>

        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" autoFocus>
            Escolher tela
          </button>
        </div>
      </form>
    </dialog>
  );
}
