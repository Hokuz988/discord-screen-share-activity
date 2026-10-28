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

import { ShareDialog } from "./ShareDialog.jsx";
import { StatusDot, initials } from "./TopBar.jsx";

/* =========================================================
   VIDEO
========================================================= */

function Video({ stream, muted, volume = 1, className, onAutoplayBlocked, onStats }) {
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

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume;
    }
  }, [volume]);

  /* Resolução e fps reais do que está chegando. */
  useEffect(() => {
    if (!onStats) {
      return;
    }

    let lastFrames = 0;
    let lastTime = performance.now();

    const timer = setInterval(() => {
      const video = ref.current;

      if (!video || !video.videoWidth) {
        return;
      }

      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      const now = performance.now();
      const fps = Math.round(((frames - lastFrames) * 1000) / (now - lastTime));

      lastFrames = frames;
      lastTime = now;

      onStats({
        width: video.videoWidth,
        height: video.videoHeight,
        fps: fps > 0 && fps < 240 ? fps : null
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [stream]);

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
   TOASTS
========================================================= */

function Toasts({ notices, error, onDismissError }) {
  return (
    <div className="toasts" aria-live="polite">
      {notices.map(notice => (
        <div key={notice.id} className="toast">{notice.text}</div>
      ))}

      {error && (
        <div className="toast danger" role="alert">
          <span>{error}</span>
          <button type="button" className="alert-close" aria-label="Fechar aviso" onClick={onDismissError}>×</button>
        </div>
      )}
    </div>
  );
}

/* =========================================================
   ROOM
========================================================= */

export function Room({ room }) {
  const [selectedId, setSelectedId] = useState(null);
  const [volume, setVolume] = useState(1);
  const [lastVolume, setLastVolume] = useState(1);
  const [stats, setStats] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const stageRef = useRef(null);

  const tiles = room.tiles;
  const selected =
    tiles.find(tile => tile.id === selectedId) ||
    tiles.find(tile => !tile.isLocal) ||
    tiles[0] ||
    null;

  const freeSlots = Math.max(0, MAX_PRODUCERS - tiles.length);
  const shareDisabled = !room.canShare || room.connection !== "online";

  useEffect(() => {
    setStats(null);
  }, [selected?.id]);

  function fullscreen() {
    stageRef.current?.requestFullscreen?.().catch(() => {});
  }

  function toggleMute() {
    if (volume > 0) {
      setLastVolume(volume);
      setVolume(0);
    } else {
      setVolume(lastVolume || 1);
    }
  }

  function share(prefs) {
    setDialogOpen(false);
    room.startSharing(prefs);
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
                  muted={selected.isLocal}
                  volume={volume}
                  onAutoplayBlocked={() => setVolume(0)}
                  onStats={setStats}
                />
              ) : (
                <div className="stage-loading">
                  <span className="spinner" aria-hidden="true" />
                  Conectando à transmissão de {selected.name}…
                </div>
              )}

              <div className="stage-top">
                <span className="live-pill"><span />AO VIVO</span>
                {stats && (
                  <span className="stats-pill mono">
                    {stats.height}p{stats.fps ? ` · ${stats.fps} fps` : ""}
                  </span>
                )}
              </div>

              <div className="stage-owner">
                <span className="avatar sm">{initials(selected.name)}</span>
                {selected.name}
              </div>

              <div className="stage-controls">
                {!selected.isLocal && (
                  <div className="volume">
                    <button
                      type="button"
                      className="overlay-btn"
                      aria-label={volume === 0 ? "Ativar som" : "Silenciar"}
                      title={volume === 0 ? "Ativar som" : "Silenciar"}
                      onClick={toggleMute}
                    >
                      {volume === 0 ? <MuteIcon /> : <VolumeIcon />}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      aria-label="Volume"
                      onChange={event => setVolume(Number(event.target.value))}
                    />
                  </div>
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
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={shareDisabled}
                onClick={() => setDialogOpen(true)}
              >
                <MonitorIcon size={16} />
                Compartilhar tela
              </button>
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
                    {tile.stream ? (
                      <Video stream={tile.stream} muted className="tile-video" />
                    ) : (
                      <span className="tile-wait"><span className="spinner sm" aria-hidden="true" /></span>
                    )}
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
            {room.sharing ? (
              <div className="share-actions">
                {room.hasAudio && (
                  <button
                    type="button"
                    className={`btn btn-ghost btn-lg ${room.audioMuted ? "is-muted" : ""}`}
                    aria-pressed={room.audioMuted}
                    onClick={room.toggleAudio}
                  >
                    {room.audioMuted ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}
                    {room.audioMuted ? "Áudio mudo" : "Áudio ligado"}
                  </button>
                )}
                <button type="button" className="btn btn-danger btn-lg" onClick={room.stopSharing}>
                  <StopIcon /> Parar
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={shareDisabled}
                onClick={() => setDialogOpen(true)}
              >
                <MonitorIcon size={16} />
                {room.canShare ? "Compartilhar tela" : "Sala lotada"}
              </button>
            )}

            <p className="foot-note">Vídeo e áudio cifrados com DTLS-SRTP</p>
          </div>
        </aside>
      </div>

      {dialogOpen && (
        <ShareDialog onConfirm={share} onClose={() => setDialogOpen(false)} />
      )}

      <Toasts notices={room.notices} error={room.error} onDismissError={room.clearError} />
    </div>
  );
}
