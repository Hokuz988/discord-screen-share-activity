import React, {
  useEffect,
  useRef,
  useState
} from "react";

import {
  createRoot
} from "react-dom/client";

import {
  DiscordSDK
} from "@discord/embedded-app-sdk";

import "./style.css";

const CLIENT_ID =
  import.meta.env.VITE_DISCORD_CLIENT_ID;

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "ws://localhost:8787";

const TURN_URL =
  "https://screen-share-activity.onrender.com";

let discordSdk = null;

/* ==========================================
   TURN
========================================== */

async function getIceServers() {
  try {
    const response =
      await fetch(
        `${TURN_URL}/turn-credentials`
      );

    if (!response.ok) {
      throw new Error(
        `TURN HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data.iceServers
    ) {
      throw new Error(
        "TURN não retornou iceServers"
      );
    }

    console.log(
      "TURN configurado:",
      data.iceServers
    );

    return data.iceServers;

  } catch (error) {
    console.error(
      "Erro ao obter TURN:",
      error
    );

    /*
     * Fallback para STUN.
     */

    return [
      {
        urls:
          "stun:stun.l.google.com:19302"
      }
    ];
  }
}

/* ==========================================
   APP
========================================== */

function App() {
  const [
    discordReady,
    setDiscordReady
  ] = useState(false);

  const [
    status,
    setStatus
  ] = useState(
    "Conectando..."
  );

  const [
    sharing,
    setSharing
  ] = useState(false);

  const [
    watching,
    setWatching
  ] = useState(false);

  const [
    viewerCount,
    setViewerCount
  ] = useState(0);

  const [
    error,
    setError
  ] = useState("");

  const [
    userName
  ] = useState(
    "Visitante"
  );

  const localVideo =
    useRef(null);

  const remoteVideo =
    useRef(null);

  const ws =
    useRef(null);

  const localStream =
    useRef(null);

  const peerConnections =
    useRef(new Map());

  const roomId =
    useRef(
      "discord-activity-room"
    );

  /* ========================================
     DISCORD
  ======================================== */

  useEffect(() => {
    let alive = true;

    async function setupDiscord() {
      if (!CLIENT_ID) {
        setStatus(
          "Modo navegador"
        );

        connectSignal();

        return;
      }

      try {
        discordSdk =
          new DiscordSDK(
            CLIENT_ID
          );

        await discordSdk.ready();

        if (!alive) {
          return;
        }

        setDiscordReady(true);

        setStatus(
          "Conectado ao Discord"
        );

      } catch (e) {
        console.warn(e);

        setStatus(
          "Modo navegador"
        );
      }

      connectSignal();
    }

    setupDiscord();

    return () => {
      alive = false;

      stopSharing();

      ws.current?.close();
    };

  }, []);

  /* ========================================
     WEBSOCKET
  ======================================== */

  function connectSignal() {
    try {
      const socket =
        new WebSocket(
          SIGNALING_URL
        );

      ws.current =
        socket;

      socket.onopen = () => {
        console.log(
          "WebSocket conectado"
        );

        setStatus(
          "Servidor conectado"
        );

        socket.send(
          JSON.stringify({
            type: "join",
            roomId:
              roomId.current,
            name:
              userName
          })
        );
      };

      socket.onmessage =
        async (event) => {
          const msg =
            JSON.parse(
              event.data
            );

          console.log(
            "Servidor:",
            msg
          );

          if (
            msg.type ===
            "viewer-count"
          ) {
            setViewerCount(
              msg.count
            );

            return;
          }

          if (
            msg.type ===
            "producer-left"
          ) {
            setWatching(
              false
            );

            if (
              remoteVideo.current
            ) {
              remoteVideo.current.srcObject =
                null;
            }

            return;
          }

          if (
            msg.type ===
            "producer"
          ) {
            if (!sharing) {
              setWatching(
                true
              );

              requestOffer(
                msg.producerId
              );
            }

            return;
          }

          if (
            msg.type ===
            "request-offer"
          ) {
            await createPeer(
              msg.viewerId
            );

            return;
          }

          if (
            msg.type ===
            "offer"
          ) {
            await handleOffer(
              msg
            );

            return;
          }

          if (
            msg.type ===
            "answer"
          ) {
            const pc =
              peerConnections.current.get(
                msg.from
              );

            if (pc) {
              await pc.setRemoteDescription(
                msg.answer
              );
            }

            return;
          }

          if (
            msg.type ===
            "ice"
          ) {
            const pc =
              peerConnections.current.get(
                msg.from
              );

            if (
              pc &&
              msg.candidate
            ) {
              try {
                await pc.addIceCandidate(
                  msg.candidate
                );
              } catch (
                error
              ) {
                console.warn(
                  "Erro ICE:",
                  error
                );
              }
            }
          }
        };

      socket.onerror =
        (event) => {
          console.error(
            "WebSocket error:",
            event
          );

          setError(
            "Erro no servidor."
          );
        };

      socket.onclose =
        () => {
          console.log(
            "WebSocket fechado"
          );

          setStatus(
            "Servidor desconectado"
          );
        };

    } catch (error) {
      console.error(
        error
      );

      setError(
        "WebSocket indisponível."
      );
    }
  }

  /* ========================================
     SEND
  ======================================== */

  function send(message) {
    if (
      ws.current?.readyState ===
      WebSocket.OPEN
    ) {
      const payload = {
        ...message,
        roomId:
          roomId.current
      };

      console.log(
        "Enviando:",
        payload
      );

      ws.current.send(
        JSON.stringify(
          payload
        )
      );
    }
  }

  /* ========================================
     SHARE SCREEN
  ======================================== */

  async function startSharing() {
    setError("");

    try {
      const stream =
        await navigator.mediaDevices.getDisplayMedia(
          {
            video: {
              frameRate: {
                ideal: 30,
                max: 60
              }
            },
            audio: true
          }
        );

      console.log(
        "MediaStream:",
        stream
      );

      localStream.current =
        stream;

      if (
        localVideo.current
      ) {
        localVideo.current.srcObject =
          stream;

        await localVideo.current.play()
          .catch(() => {});
      }

      const videoTracks =
        stream.getVideoTracks();

      console.log(
        "VIDEO TRACKS:",
        videoTracks
      );

      if (
        videoTracks.length
      ) {
        console.log(
          "VIDEO TRACK:",
          videoTracks[0]
        );

        console.log(
          "TRACK SETTINGS:",
          videoTracks[0].getSettings()
        );

        console.log(
          "TRACK STATE:",
          videoTracks[0].readyState
        );

        videoTracks[0].addEventListener(
          "ended",
          stopSharing
        );
      }

      setSharing(true);

      setWatching(false);

      send({
        type:
          "start-sharing"
      });

      setStatus(
        "Você está transmitindo"
      );

      console.log(
        "TRANSMISSÃO INICIADA"
      );

    } catch (e) {
      console.error(
        "Erro captura:",
        e
      );

      if (
        e?.name !==
        "NotAllowedError"
      ) {
        setError(
          "Não foi possível iniciar a captura."
        );
      }
    }
  }

  /* ========================================
     STOP
  ======================================== */

  function stopSharing() {
    localStream.current
      ?.getTracks()
      .forEach(
        track =>
          track.stop()
      );

    localStream.current =
      null;

    if (
      localVideo.current
    ) {
      localVideo.current.srcObject =
        null;
    }

    for (
      const pc of
      peerConnections.current.values()
    ) {
      pc.close();
    }

    peerConnections.current.clear();

    if (
      ws.current?.readyState ===
      WebSocket.OPEN
    ) {
      send({
        type:
          "stop-sharing"
      });
    }

    setSharing(false);

    setWatching(false);
  }

  /* ========================================
     REQUEST OFFER
  ======================================== */

  function requestOffer(
    producerId
  ) {
    send({
      type:
        "request-offer",
      producerId
    });
  }

  /* ========================================
     CREATE PEER
  ======================================== */

  async function createPeer(
    viewerId
  ) {
    console.log(
      "Criando Peer para:",
      viewerId
    );

    const iceServers =
      await getIceServers();

    const pc =
      new RTCPeerConnection({
        iceServers,
        iceTransportPolicy:
          "all"
      });

    peerConnections.current.set(
      viewerId,
      pc
    );

    pc.oniceconnectionstatechange =
      () => {
        console.log(
          "ICE:",
          pc.iceConnectionState
        );
      };

    pc.onconnectionstatechange =
      () => {
        console.log(
          "WebRTC:",
          pc.connectionState
        );
      };

    pc.onicegatheringstatechange =
      () => {
        console.log(
          "ICE gathering:",
          pc.iceGatheringState
        );
      };

    localStream.current
      ?.getTracks()
      .forEach(
        track => {
          pc.addTrack(
            track,
            localStream.current
          );
        }
      );

    pc.onicecandidate =
      ({
        candidate
      }) => {
        if (
          candidate
        ) {
          send({
            type: "ice",
            target:
              viewerId,
            candidate
          });
        }
      };

    const offer =
      await pc.createOffer();

    await pc.setLocalDescription(
      offer
    );

    send({
      type: "offer",
      target:
        viewerId,
      offer
    });

    console.log(
      "Offer enviada"
    );

    return pc;
  }

  /* ========================================
     HANDLE OFFER
  ======================================== */

  async function handleOffer(
    msg
  ) {
    console.log(
      "Recebendo offer:",
      msg
    );

    const iceServers =
      await getIceServers();

    const pc =
      new RTCPeerConnection({
        iceServers,
        iceTransportPolicy:
          "all"
      });

    peerConnections.current.set(
      msg.from,
      pc
    );

    pc.oniceconnectionstatechange =
      () => {
        console.log(
          "VIEWER ICE:",
          pc.iceConnectionState
        );
      };

    pc.onconnectionstatechange =
      () => {
        console.log(
          "VIEWER CONNECTION:",
          pc.connectionState
        );
      };

    pc.onicegatheringstatechange =
      () => {
        console.log(
          "VIEWER GATHERING:",
          pc.iceGatheringState
        );
      };

    pc.ontrack =
      ({
        streams
      }) => {
        console.log(
          "TRACK RECEBIDA:",
          streams
        );

        if (
          remoteVideo.current &&
          streams[0]
        ) {
          remoteVideo.current.srcObject =
            streams[0];

          remoteVideo.current
            .play()
            .catch(
              console.warn
            );

          setWatching(
            true
          );
        }
      };

    pc.onicecandidate =
      ({
        candidate
      }) => {
        if (
          candidate
        ) {
          send({
            type: "ice",
            target:
              msg.from,
            candidate
          });
        }
      };

    await pc.setRemoteDescription(
      msg.offer
    );

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(
      answer
    );

    send({
      type: "answer",
      target:
        msg.from,
      answer
    });

    console.log(
      "Answer enviada"
    );
  }

  /* ========================================
     UI
  ======================================== */

  return (
    <main className="app">

      <header className="topbar">

        <div>

          <span className="eyebrow">
            DISCORD ACTIVITY
          </span>

          <h1>
            ScreenCast
          </h1>

        </div>

        <div className="status">

          <span
            className={
              `dot ${
                discordReady
                  ? "on"
                  : ""
              }`
            }
          />

          {status}

        </div>

      </header>

      <section className="stage">

        <div className="video-card">

          {watching ? (

            <video
              ref={
                remoteVideo
              }
              autoPlay
              playsInline
              controls
            />

          ) : sharing ? (

            <video
              ref={
                localVideo
              }
              autoPlay
              muted
              playsInline
            />

          ) : (

            <div className="empty">

              <div className="screen-icon">
                ▣
              </div>

              <h2>
                Nenhuma transmissão
              </h2>

              <p>
                Inicie uma transmissão
                para que as pessoas
                possam assistir.
              </p>

            </div>

          )}

          <div className="live-badge">

            {sharing
              ? "● AO VIVO"
              : watching
                ? "● ASSISTINDO"
                : "○ OFFLINE"}

          </div>

        </div>

        <aside className="panel">

          <h2>
            ScreenCast
          </h2>

          <p className="muted">
            Compartilhe sua tela
            com as pessoas da sala.
          </p>

          {!sharing ? (

            <button
              className="primary"
              onClick={
                startSharing
              }
            >
              🖥️ Compartilhar tela
            </button>

          ) : (

            <button
              className="danger"
              onClick={
                stopSharing
              }
            >
              ■ Parar transmissão
            </button>

          )}

          <div className="stats">

            <div>

              <strong>
                {viewerCount}
              </strong>

              <span>
                pessoas na sala
              </span>

            </div>

            <div>

              <strong>
                {sharing
                  ? "Você"
                  : watching
                    ? "Ao vivo"
                    : "—"}
              </strong>

              <span>
                transmissão
              </span>

            </div>

          </div>

          {error && (

            <div className="error">
              {error}
            </div>

          )}

          <small>
            A captura começa depois
            que você escolher uma
            tela, janela ou aba.
          </small>

        </aside>

      </section>

    </main>
  );
}

createRoot(
  document.getElementById(
    "root"
  )
).render(
  <App />
);
