import React, { useEffect, useRef, useState } from "react";

import { MAX_PRODUCERS } from "../hooks/useRoom.js";
import { ExpandIcon, MuteIcon, VolumeIcon } from "./Icons.jsx";
import { ShareDialog } from "./ShareDialog.jsx";
import { StatusDot, Wordmark } from "./TopBar.jsx";

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
    <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
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
        <div className="toast toast-error" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={onDismissError}>Fechar</button>
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
    <div className="shell room">
      <header className="nav">
        <div className="nav-left">
          <Wordmark />
          <div className="room-id">
            <span className="fine">Sala</span>
            <span className="mono">{room.room.code}</span>
          </div>
          <span className="fine">
            {room.viewers === 1 ? "Só você na sala" : `${room.viewers} pessoas na sala`}
          </span>
        </div>

        <div className="nav-right">
          {room.connection !== "online" && <StatusDot connection={room.connection} />}
          <CopyInvite invite={room.room.invite} />
          <button type="button" className="btn btn-quiet btn-sm" onClick={room.leaveRoom}>
            Sair da sala
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
                <div className="stage-message">
                  <span className="spinner" aria-hidden="true" />
                  Conectando à tela de {selected.name}
                </div>
              )}

              <div className="overlay overlay-top">
                <span className="stage-name">
                  <span className="live">Ao vivo</span>
                  {selected.name}
                </span>
                {stats && (
                  <span className="stage-stats mono">
                    {stats.height}p{stats.fps ? ` ${stats.fps}fps` : ""}
                  </span>
                )}
              </div>

              <div className="overlay overlay-bottom">
                {!selected.isLocal && (
                  <div className="volume">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={volume === 0 ? "Ativar som" : "Silenciar"}
                      title={volume === 0 ? "Ativar som" : "Silenciar"}
                      onClick={toggleMute}
                    >
                      {volume === 0 ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}
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
                <button type="button" className="icon-btn" aria-label="Tela cheia" title="Tela cheia" onClick={fullscreen}>
                  <ExpandIcon size={16} />
                </button>
              </div>
            </div>
          ) : (
            <div className="stage-message">
              <p className="stage-empty-title">Ninguém está transmitindo</p>
              <p className="muted">Compartilhe sua tela ou mande o convite para alguém.</p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={shareDisabled}
                onClick={() => setDialogOpen(true)}
              >
                Compartilhar tela
              </button>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Transmissões</span>
            <span className="mono fine">{tiles.length}/{MAX_PRODUCERS}</span>
          </div>

          <div className="tiles">
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
                  <span className="tile-preview">
                    {tile.stream ? (
                      <Video stream={tile.stream} muted className="tile-video" />
                    ) : (
                      <span className="spinner sm" aria-hidden="true" />
                    )}
                  </span>
                  <span className="tile-info">
                    <span className="tile-name">{tile.name}</span>
                    <span className="fine">
                      {tile.isLocal ? "Sua tela" : active ? "Assistindo" : "Assistir"}
                    </span>
                  </span>
                </button>
              );
            })}

            {Array.from({ length: freeSlots }, (_, index) => (
              <div key={index} className="tile-empty fine">Vaga livre</div>
            ))}
          </div>

          <div className="sidebar-foot">
            {room.sharing ? (
              <div className="button-row">
                {room.hasAudio && (
                  <button
                    type="button"
                    className={`btn btn-secondary ${room.audioMuted ? "is-off" : ""}`}
                    aria-pressed={room.audioMuted}
                    onClick={room.toggleAudio}
                  >
                    {room.audioMuted ? "Som desligado" : "Som ligado"}
                  </button>
                )}
                <button type="button" className="btn btn-danger" onClick={room.stopSharing}>
                  Parar
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={shareDisabled}
                onClick={() => setDialogOpen(true)}
              >
                {room.canShare ? "Compartilhar tela" : "Sala cheia"}
              </button>
            )}

            <p className="fine center">Vídeo e som cifrados de ponta a ponta</p>
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
