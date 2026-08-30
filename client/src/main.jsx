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

/* =========================================================
   CONFIG
========================================================= */

const CLIENT_ID =
  import.meta.env.VITE_DISCORD_CLIENT_ID;

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "wss://screen-share-activity.onrender.com";

const TURN_SERVER_URL =
  "https://screen-share-activity.onrender.com";

let discordSdk = null;

/* =========================================================
   TURN
========================================================= */

async function getIceServers() {

  try {

    console.log(
      "Buscando credenciais TURN..."
    );

    const response =
      await fetch(
        `${TURN_SERVER_URL}/turn-credentials`,
        {
          method: "GET",
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `TURN HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(
        data.iceServers
      )
    ) {
      throw new Error(
        "TURN inválido."
      );
    }

    console.log(
      "TURN configurado."
    );

    return data.iceServers;

  } catch (error) {

    console.error(
      "Erro TURN:",
      error
    );

    console.warn(
      "Usando STUN como fallback."
    );

    return [
      {
        urls: [
          "stun:stun.cloudflare.com:3478",
          "stun:stun.l.google.com:19302"
        ]
      }
    ];
  }
}

/* =========================================================
   APP
========================================================= */

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
    roomCode,
    setRoomCode
  ] = useState("");

  const [
    currentRoom,
    setCurrentRoom
  ] = useState("");

  const [
    roomInput,
    setRoomInput
  ] = useState("");

  const [
    inRoom,
    setInRoom
  ] = useState(false);

  /* =======================================================
     REFS
  ======================================================= */

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

  const pendingCandidates =
    useRef(new Map());

  const roomId =
    useRef("");

  /* =======================================================
     DISCORD
  ======================================================= */

  useEffect(() => {

    let alive = true;

    async function setupDiscord() {

      if (!CLIENT_ID) {

        console.log(
          "Discord Client ID não configurado."
        );

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

      } catch (error) {

        console.warn(
          "Discord SDK:",
          error
        );

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

      if (ws.current) {
        ws.current.close();
      }
    };

  }, []);

  /* =========================================================
     WEBSOCKET
  ========================================================= */

  function connectSignal() {

    console.log(
      "Conectando:",
      SIGNALING_URL
    );

    try {

      const socket =
        new WebSocket(
          SIGNALING_URL
        );

      ws.current =
        socket;

      socket.onopen = () => {

        console.log(
          "WebSocket conectado."
        );

        setStatus(
          "Servidor conectado"
        );
      };

      socket.onmessage =
        async (event) => {

          let msg;

          try {

            msg =
              JSON.parse(
                event.data
              );

          } catch {

            return;
          }

          console.log(
            "Servidor:",
            msg
          );

          /* =================================================
             SALA CRIADA
          ================================================= */

          if (
            msg.type ===
            "room-created"
          ) {

            const code =
              msg.roomId;

            roomId.current =
              code;

            setRoomCode(
              code
            );

            setCurrentRoom(
              code
            );

            setInRoom(
              true
            );

            setStatus(
              "Sala criada"
            );

            return;
          }

          /* =================================================
             SALA ENTRADA
          ================================================= */

          if (
            msg.type ===
            "room-joined"
          ) {

            roomId.current =
              msg.roomId;

            setRoomCode(
              msg.roomId
            );

            setCurrentRoom(
              msg.roomId
            );

            setInRoom(
              true
            );

            setStatus(
              "Você entrou na sala"
            );

            return;
          }

          /* =================================================
             SAIU
          ================================================= */

          if (
            msg.type ===
            "left-room"
          ) {

            roomId.current =
              "";

            setRoomCode(
              ""
            );

            setCurrentRoom(
              ""
            );

            setInRoom(
              false
            );

            setSharing(
              false
            );

            setWatching(
              false
            );

            closeAllPeers();

            return;
          }

          /* =================================================
             VIEWER COUNT
          ================================================= */

          if (
            msg.type ===
            "viewer-count"
          ) {

            setViewerCount(
              msg.count || 0
            );

            return;
          }

          /* =================================================
             ERRO
          ================================================= */

          if (
            msg.type ===
            "error"
          ) {

            setError(
              msg.message ||
              "Erro no servidor."
            );

            return;
          }

          /* =================================================
             PRODUTOR
          ================================================= */

          if (
            msg.type ===
            "producer"
          ) {

            if (
              sharing
            ) {
              return;
            }

            console.log(
              "Produtor:",
              msg.producerId
            );

            setWatching(
              true
            );

            requestOffer(
              msg.producerId
            );

            return;
          }

          /* =================================================
             PRODUTOR SAIU
          ================================================= */

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

              remoteVideo.current
                .srcObject =
                null;
            }

            closeAllPeers();

            return;
          }

          /* =================================================
             REQUEST OFFER
          ================================================= */

          if (
            msg.type ===
            "request-offer"
          ) {

            if (
              localStream.current
            ) {

              await createPeer(
                msg.viewerId
              );
            }

            return;
          }

          /* =================================================
             OFFER
          ================================================= */

          if (
            msg.type ===
            "offer"
          ) {

            await handleOffer(
              msg
            );

            return;
          }

          /* =================================================
             ANSWER
          ================================================= */

          if (
            msg.type ===
            "answer"
          ) {

            const pc =
              peerConnections.current.get(
                msg.from
              );

            if (!pc) {
              return;
            }

            try {

              await pc.setRemoteDescription(
                msg.answer
              );

              await flushPendingCandidates(
                msg.from
              );

            } catch (
              error
            ) {

              console.error(
                "Erro answer:",
                error
              );
            }

            return;
          }

          /* =================================================
             ICE
          ================================================= */

          if (
            msg.type ===
            "ice"
          ) {

            await handleIceCandidate(
              msg
            );

            return;
          }
        };

      socket.onerror =
        (error) => {

          console.error(
            "WebSocket:",
            error
          );

          setError(
            "Erro de conexão com o servidor."
          );
        };

      socket.onclose =
        () => {

          setStatus(
            "Servidor desconectado"
          );
        };

    } catch (
      error
    ) {

      console.error(
        error
      );

      setError(
        "WebSocket indisponível."
      );
    }
  }

  /* =========================================================
     SEND
  ========================================================= */

  function send(message) {

    if (
      ws.current &&
      ws.current.readyState ===
      WebSocket.OPEN
    ) {

      ws.current.send(
        JSON.stringify({
          ...message,

          roomId:
            roomId.current
        })
      );

    }
  }

  /* =========================================================
     CRIAR SALA
  ========================================================= */

  function createRoom() {

    setError("");

    if (
      !ws.current ||
      ws.current.readyState !==
      WebSocket.OPEN
    ) {

      setError(
        "Servidor ainda não conectado."
      );

      return;
    }

    send({
      type:
        "create-room"
    });
  }

  /* =========================================================
     ENTRAR
  ========================================================= */

  function joinRoom() {

    setError("");

    const code =
      roomInput
        .trim()
        .toUpperCase();

    if (!code) {

      setError(
        "Digite o código da sala."
      );

      return;
    }

    send({
      type:
        "join-room",

      roomId:
        code
    });
  }

  /* =========================================================
     SAIR
  ========================================================= */

  function leaveRoom() {

    stopSharing();

    send({
      type:
        "leave-room"
    });

    closeAllPeers();

    setInRoom(
      false
    );

    setCurrentRoom(
      ""
    );

    setRoomCode(
      ""
    );

    roomId.current =
      "";
  }

  /* =========================================================
     CAPTURA
  ========================================================= */

  async function startSharing() {

    setError("");

    if (
      !inRoom
    ) {

      setError(
        "Entre em uma sala primeiro."
      );

      return;
    }

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
        "Stream:",
        stream
      );

      localStream.current =
        stream;

      if (
        localVideo.current
      ) {

        localVideo.current.srcObject =
          stream;

        await localVideo.current
          .play()
          .catch(
            () => {}
          );
      }

      const videoTrack =
        stream.getVideoTracks()[0];

      if (videoTrack) {

        videoTrack.addEventListener(
          "ended",
          () => {
            stopSharing();
          }
        );
      }

      setSharing(
        true
      );

      setWatching(
        false
      );

      send({
        type:
          "start-sharing"
      });

      setStatus(
        "Você está transmitindo"
      );

    } catch (
      error
    ) {

      console.error(
        error
      );

      if (
        error?.name ===
        "NotAllowedError"
      ) {
        return;
      }

      setError(
        "Não foi possível iniciar a captura."
      );
    }
  }

  /* =========================================================
     PARAR
  ========================================================= */

  function stopSharing() {

    if (
      localStream.current
    ) {

      localStream.current
        .getTracks()
        .forEach(
          track =>
            track.stop()
        );
    }

    localStream.current =
      null;

    if (
      localVideo.current
    ) {

      localVideo.current
        .srcObject =
        null;
    }

    closeAllPeers();

    if (
      ws.current &&
      ws.current.readyState ===
      WebSocket.OPEN &&
      roomId.current
    ) {

      send({
        type:
          "stop-sharing"
      });
    }

    setSharing(
      false
    );

    setWatching(
      false
    );
  }

  /* =========================================================
     PEERS
  ========================================================= */

  function closeAllPeers() {

    for (
      const pc of
      peerConnections.current.values()
    ) {

      try {
        pc.close();
      } catch {}
    }

    peerConnections.current.clear();

    pendingCandidates.current.clear();
  }

  /* =========================================================
     REQUEST OFFER
  ========================================================= */

  function requestOffer(
    producerId
  ) {

    send({
      type:
        "request-offer",

      producerId
    });
  }

  /* =========================================================
     CREATE PEER — PRODUTOR
  ========================================================= */

  async function createPeer(
    viewerId
  ) {

    const old =
      peerConnections.current.get(
        viewerId
      );

    if (old) {
      old.close();
    }

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

    /* TRACKS */

    if (
      localStream.current
    ) {

      for (
        const track of
        localStream.current.getTracks()
      ) {

        pc.addTrack(
          track,
          localStream.current
        );
      }
    }

    /* ICE */

    pc.onicecandidate =
      ({ candidate }) => {

        if (candidate) {

          send({
            type:
              "ice",

            target:
              viewerId,

            candidate
          });
        }
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "PRODUTOR:",
          pc.connectionState
        );
      };

    /* OFFER */

    const offer =
      await pc.createOffer();

    await pc.setLocalDescription(
      offer
    );

    send({
      type:
        "offer",

      target:
        viewerId,

      offer:
        pc.localDescription
    });
  }

  /* =========================================================
     HANDLE OFFER — VIEWER
  ========================================================= */

  async function handleOffer(
    msg
  ) {

    const old =
      peerConnections.current.get(
        msg.from
      );

    if (old) {
      old.close();
    }

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

    /* TRACK */

    pc.ontrack =
      ({ streams }) => {

        const stream =
          streams?.[0];

        if (
          !stream
        ) {
          return;
        }

        if (
          remoteVideo.current
        ) {

          remoteVideo.current.srcObject =
            stream;

          remoteVideo.current
            .play()
            .catch(
              () => {}
            );
        }

        setWatching(
          true
        );
      };

    /* ICE */

    pc.onicecandidate =
      ({ candidate }) => {

        if (candidate) {

          send({
            type:
              "ice",

            target:
              msg.from,

            candidate
          });
        }
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "VIEWER:",
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "connected"
        ) {

          setWatching(
            true
          );
        }

        if (
          pc.connectionState ===
          "failed"
        ) {

          setError(
            "A conexão WebRTC falhou."
          );
        }
      };

    /* REMOTE */

    await pc.setRemoteDescription(
      msg.offer
    );

    await flushPendingCandidates(
      msg.from
    );

    /* ANSWER */

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(
      answer
    );

    send({
      type:
        "answer",

      target:
        msg.from,

      answer:
        pc.localDescription
    });
  }

  /* =========================================================
     ICE
  ========================================================= */

  async function handleIceCandidate(
    msg
  ) {

    const pc =
      peerConnections.current.get(
        msg.from
      );

    if (
      !pc ||
      !pc.remoteDescription
    ) {

      if (
        !pendingCandidates.current.has(
          msg.from
        )
      ) {

        pendingCandidates.current.set(
          msg.from,
          []
        );
      }

      pendingCandidates.current
        .get(msg.from)
        .push(
          msg.candidate
        );

      return;
    }

    try {

      await pc.addIceCandidate(
        msg.candidate
      );

    } catch (
      error
    ) {

      console.warn(
        "ICE:",
        error
      );
    }
  }

  /* =========================================================
     FLUSH ICE
  ========================================================= */

  async function flushPendingCandidates(
    peerId
  ) {

    const pc =
      peerConnections.current.get(
        peerId
      );

    if (
      !pc ||
      !pc.remoteDescription
    ) {
      return;
    }

    const candidates =
      pendingCandidates.current.get(
        peerId
      );

    if (
      !candidates
    ) {
      return;
    }

    for (
      const candidate of
      candidates
    ) {

      try {

        await pc.addIceCandidate(
          candidate
        );

      } catch {}
    }

    pendingCandidates.current.delete(
      peerId
    );
  }

  /* =========================================================
     UI
  ========================================================= */

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

      {!inRoom ? (

        <section className="room-menu">

          <h2>
            Salas
          </h2>

          <p className="muted">
            Crie uma sala ou entre
            usando um código.
          </p>

          <button
            className="primary"
            onClick={
              createRoom
            }
          >
            ➕ Criar sala
          </button>

          <div className="join-box">

            <input
              value={
                roomInput
              }
              onChange={
                event =>
                  setRoomInput(
                    event.target.value
                  )
              }
              onKeyDown={
                event => {

                  if (
                    event.key ===
                    "Enter"
                  ) {

                    joinRoom();
                  }
                }
              }
              placeholder="Código da sala"
              maxLength={6}
            />

            <button
              onClick={
                joinRoom
              }
            >
              Entrar
            </button>

          </div>

          {error && (

            <div className="error">
              {error}
            </div>

          )}

        </section>

      ) : (

        <>

          <section className="room-bar">

            <div>

              <span>
                SALA
              </span>

              <strong>
                {currentRoom}
              </strong>

            </div>

            <button
              onClick={
                leaveRoom
              }
            >
              Sair da sala
            </button>

          </section>

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
                    Alguém desta sala
                    precisa iniciar
                    uma transmissão.
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
                com as pessoas desta
                sala.
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
                    espectadores
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
                Código da sala:
                {" "}
                <b>
                  {currentRoom}
                </b>
              </small>

            </aside>

          </section>

        </>

      )}

    </main>
  );
}

/* =========================================================
   START
========================================================= */

const root =
  document.getElementById(
    "root"
  );

if (!root) {

  throw new Error(
    "Elemento #root não encontrado."
  );
}

createRoot(root).render(
  <App />
);