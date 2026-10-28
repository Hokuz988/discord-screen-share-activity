import React, { useEffect, useRef, useState } from "react";

import { MAX_PRODUCERS } from "../hooks/useRoom.js";

import {
  CheckIcon,
  CopyIcon,
  ExpandIcon,
  EyeIcon,
  LockIcon,
  MonitorIcon,
  MuteIcon,
  StopIcon,
  VolumeIcon
} from "./Icons.jsx";

import { StatusDot, initials } from "./TopBar.jsx";

/* =========================================================
   VIDEO
========================================================= */

function Video({ stream, muted, className, onAutoplayBlocked }) {
  const ref = useRef(null);

  useEffect(() => {
    const video = ref.current;

    if (!video) {
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.muted = muted;

    video.play().catch(() => {
      /* Navegador bloqueou autoplay com som: tenta mudo. */
      if (!muted) {
        video.muted = true;
        video.play().catch(() => {});
        onAutoplayBlocked?.();
      }
    });
  }, [stream, muted]);

  return <video ref={ref} className={className} autoPlay playsInline />;
}

/* =========================================================
   INVITE
========================================================= */

function CopyInvite({ invite }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite);
    } catch {
      window.prompt("Copie o convite:", invite);
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={copy}>
      {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      {copied ? "Copiado" : "Copiar convite"}
    </button>
  );
}

/* =========================================================
   ROOM
========================================================= */

export function Room({ room }) {
  const [selectedId, setSelectedId] = useState(null);
  const [muted, setMuted] = useState(false);
  const stageRef = useRef(null);

  const tiles = room.tiles;
  const selected =
    tiles.find(tile => tile.id === selectedId) ||
    tiles.find(tile => !tile.isLocal) ||
    tiles[0] ||
    null;

  const freeSlots = Math.max(0, MAX_PRODUCERS - tiles.length);

  function fullscreen() {
    stageRef.current?.requestFullscreen?.().catch(() => {});
  }

  return (
    <div className="screen room">
      <header className="room-bar">
        <div className="room-meta">
          <span className="eyebrow">Sala</span>
          <span className="room-code">{room.room.code}</span>
          <span className="badge-secure">
            <LockIcon size={14} strokeWidth={2.2} />
            Ponta a ponta
          </span>
          <span className="meta-muted">
            <EyeIcon size={16} />
            {room.viewers} assistindo
          </span>
        </div>

        <div className="room-actions">
          {room.connection !== "online" && <StatusDot connection={room.connection} />}
          <CopyInvite invite={room.room.invite} />
          <button type="button" className="btn btn-danger-soft" onClick={room.leaveRoom}>
            Sair
          </button>
        </div>
      </header>

      <div className="room-body">
        <section className="stage">
          {selected ? (
            <div className="stage-frame" ref={stageRef}>
              {selected.stream ? (
                <Video
                  key={selected.id}
                  className="stage-video"
                  stream={selected.stream}
                  muted={selected.isLocal || muted}
                  onAutoplayBlocked={() => setMuted(true)}
                />
              ) : (
                <div className="stage-loading">
                  <span className="spinner" aria-hidden="true" />
                  Conectando à transmissão de {selected.name}…
                </div>
              )}

              <span className="live-pill"><span />AO VIVO</span>

              <div className="stage-owner">
                <span className="avatar sm">{initials(selected.name)}</span>
                {selected.name}
              </div>

              <div className="stage-controls">
                {!selected.isLocal && (
                  <button
                    type="button"
                    className="overlay-btn"
                    aria-label={muted ? "Ativar som" : "Silenciar"}
                    title={muted ? "Ativar som" : "Silenciar"}
                    onClick={() => setMuted(value => !value)}
                  >
                    {muted ? <MuteIcon /> : <VolumeIcon />}
                  </button>
                )}
                <button type="button" className="overlay-btn" aria-label="Tela cheia" title="Tela cheia" onClick={fullscreen}>
                  <ExpandIcon />
                </button>
              </div>
            </div>
          ) : (
            <div className="stage-empty">
              <span className="empty-icon"><MonitorIcon size={28} /></span>
              <h2>Ninguém transmitindo ainda</h2>
              <p>Compartilhe sua tela ou mande o convite para alguém.</p>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="sidebar-head">
            <strong>Transmissões</strong>
            <span className="mono muted">{tiles.length} / {MAX_PRODUCERS}</span>
          </div>

          <div className="tile-list">
            {tiles.map(tile => {
              const active = selected?.id === tile.id;

              return (
                <button
                  key={tile.id}
                  type="button"
                  className={`tile ${active ? "active" : ""}`}
                  aria-pressed={active}
                  onClick={() => setSelectedId(tile.id)}
                >
                  <div className="tile-preview">
                    {tile.stream && <Video stream={tile.stream} muted className="tile-video" />}
                    <span className="live-tag">AO VIVO</span>
                  </div>
                  <div className="tile-info">
                    <span className="tile-name">{tile.name}</span>
                    <span className={active ? "tile-state accent" : "tile-state"}>
                      {active ? "Assistindo" : tile.isLocal ? "Sua tela" : "Assistir"}
                    </span>
                  </div>
                </button>
              );
            })}

            {freeSlots > 0 && (
              <div className="slot-free">
                {freeSlots === 1 ? "1 vaga livre" : `${freeSlots} vagas livres`}
              </div>
            )}
          </div>

          <div className="sidebar-foot">
            {room.error && (
              <div className="alert" role="alert">
                {room.error}
                <button type="button" className="alert-close" aria-label="Fechar aviso" onClick={room.clearError}>×</button>
              </div>
            )}

            {room.sharing ? (
              <button type="button" className="btn btn-danger btn-lg" onClick={room.stopSharing}>
                <StopIcon /> Parar transmissão
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={!room.canShare || room.connection !== "online"}
                onClick={room.startSharing}
              >
                <MonitorIcon size={16} />
                {room.canShare ? "Compartilhar tela" : "Sala lotada"}
              </button>
            )}

            <p className="foot-note">Vídeo e áudio cifrados com DTLS-SRTP</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
