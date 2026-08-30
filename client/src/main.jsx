import React, {
  useEffect,
  useRef,
  useState,
} from "react";

import { createRoot } from "react-dom/client";

import { DiscordSDK } from
  "@discord/embedded-app-sdk";

import "./style.css";

const CLIENT_ID =
  import.meta.env.VITE_DISCORD_CLIENT_ID;

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "ws://localhost:8787";

let discordSdk = null;

function App() {
  const [discordReady, setDiscordReady] =
    useState(false);

  const [status, setStatus] =
    useState("Conectando...");

  const [roomId, setRoomId] =
    useState("");

  const [roomInput, setRoomInput] =
    useState("");

  const [inRoom, setInRoom] =
    useState(false);

  const [sharing, setSharing] =
    useState(false);

  const [watching, setWatching] =
    useState(false);

  const [viewerCount, setViewerCount] =
    useState(0);

  const [error, setError] =
    useState("");

  const [userName] =
    useState("Visitante");

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

  /*
   * ==========================================
   * STREAM -> VIDEO
   * ==========================================
   */

  useEffect(() => {
    if (
      !localVideo.current ||
      !localStream.current
    ) {
      return;
    }

    const video =
      localVideo.current;

    const stream =
      localStream.current;

    video.srcObject = stream;

    video
      .play()
      .then(() => {
        console.log(
          "Vídeo local iniciado"
        );
      })
      .catch((error) => {
        console.warn(
          "Play local:",
          error
        );
      });
  }, [sharing]);

  /*
   * ==========================================
   * DISCORD
   * ==========================================
   */

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
          "Discord conectado"
        );

        console.log(
          "Discord SDK pronto"
        );
      } catch (error) {
        console.error(
          "Discord SDK:",
          error
        );

        setStatus(
          "Discord SDK não conectado"
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

  /*
   * ==========================================
   * WEBSOCKET
   * ==========================================
   */

  function connectSignal() {
    if (
      ws.current &&
      ws.current.readyState ===
        WebSocket.OPEN
    ) {
      return;
    }

    try {
      const socket =
        new WebSocket(
          SIGNALING_URL
        );

      ws.current = socket;

      socket.onopen = () => {
        console.log(
          "WebSocket conectado"
        );

        setStatus(
          "Servidor conectado"
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

          /*
           * SALA CRIADA
           */

          if (
            msg.type ===
            "room-created"
          ) {
            setRoomId(
              msg.roomId
            );

            setInRoom(true);

            setError("");

            setStatus(
              `Sala ${msg.roomId}`
            );

            return;
          }

          /*
           * ENTROU NA SALA
           */

          if (
            msg.type ===
            "room-joined"
          ) {
            setRoomId(
              msg.roomId
            );

            setInRoom(true);

            setError("");

            setStatus(
              `Sala ${msg.roomId}`
            );

            return;
          }

          /*
           * ERRO
           */

          if (
            msg.type ===
            "error"
          ) {
            setError(
              msg.message
            );

            return;
          }

          /*
           * QUANTIDADE
           */

          if (
            msg.type ===
            "viewer-count"
          ) {
            setViewerCount(
              msg.count
            );

            return;
          }

          /*
           * PRODUTOR SAIU
           */

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

            setStatus(
              "Nenhuma transmissão"
            );

            return;
          }

          /*
           * ESPECTADOR PEDIU OFFER
           */

          if (
            msg.type ===
            "request-offer"
          ) {
            console.log(
              "Offer solicitada por:",
              msg.viewerId
            );

            if (
              localStream.current
            ) {
              await createPeer(
                msg.viewerId
              );
            }

            return;
          }

          /*
           * PRODUTOR ENCONTRADO
           */

          if (
            msg.type ===
            "producer"
          ) {
            console.log(
              "Produtor:",
              msg.producerId
            );

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

          /*
           * OFFER
           */

          if (
            msg.type ===
            "offer"
          ) {
            await handleOffer(
              msg
            );

            return;
          }

          /*
           * ANSWER
           */

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

          /*
           * ICE
           */

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
              await pc
                .addIceCandidate(
                  msg.candidate
                )
                .catch(
                  console.warn
                );
            }

            return;
          }
        };

      socket.onerror = () => {
        setError(
          "Erro no servidor."
        );
      };

      socket.onclose = () => {
        setStatus(
          "Servidor desconectado"
        );
      };
    } catch (error) {
      console.error(error);

      setError(
        "Não foi possível conectar ao servidor."
      );
    }
  }

  /*
   * ==========================================
   * SEND
   * ==========================================
   */

  function send(message) {
    if (
      ws.current?.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    ws.current.send(
      JSON.stringify(message)
    );
  }

  /*
   * ==========================================
   * CRIAR SALA
   * ==========================================
   */

  function createRoom() {
    setError("");

    send({
      type: "create-room",
      name: userName,
    });
  }

  /*
   * ==========================================
   * ENTRAR
   * ==========================================
   */

  function joinRoom() {
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

    setError("");

    send({
      type: "join-room",
      roomId: code,
      name: userName,
    });
  }

  /*
   * ==========================================
   * SAIR
   * ==========================================
   */

  function leaveRoom() {
    stopSharing();

    send({
      type: "leave-room",
    });

    setRoomId("");

    setInRoom(false);

    setWatching(false);

    setViewerCount(0);

    setStatus(
      "Fora da sala"
    );
  }

  /*
   * ==========================================
   * CAPTURA
   * ==========================================
   */

  async function startSharing() {
    setError("");

    if (!inRoom) {
      setError(
        "Entre ou crie uma sala primeiro."
      );

      return;
    }

    try {
      console.log(
        "Solicitando captura..."
      );

      const stream =
        await navigator.mediaDevices.getDisplayMedia(
          {
            video: {
              frameRate: {
                ideal: 30,
                max: 60,
              },
            },

            audio: true,
          }
        );

      console.log(
        "Stream:",
        stream
      );

      const videoTrack =
        stream.getVideoTracks()[0];

      if (!videoTrack) {
        throw new Error(
          "Nenhuma faixa de vídeo encontrada."
        );
      }

      console.log(
        "Track:",
        videoTrack
      );

      console.log(
        "Settings:",
        videoTrack.getSettings()
      );

      localStream.current =
        stream;

      videoTrack.addEventListener(
        "ended",
        () => {
          stopSharing();
        }
      );

      setSharing(true);

      setWatching(false);

      send({
        type: "start-sharing",
      });

      setStatus(
        "Você está transmitindo"
      );
    } catch (error) {
      console.error(
        "Captura:",
        error
      );

      if (
        error?.name !==
        "NotAllowedError"
      ) {
        setError(
          error?.message ||
            "Não foi possível capturar a tela."
        );
      }
    }
  }

  /*
   * ==========================================
   * PARAR
   * ==========================================
   */

  function stopSharing() {
    localStream.current
      ?.getTracks()
      .forEach(
        (track) => {
          track.stop();
        }
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
        type: "stop-sharing",
      });
    }

    setSharing(false);

    setWatching(false);

    setStatus(
      inRoom
        ? `Sala ${roomId}`
        : "Fora da sala"
    );
  }

  /*
   * ==========================================
   * REQUEST OFFER
   * ==========================================
   */

  function requestOffer(
    producerId
  ) {
    send({
      type: "request-offer",
      producerId,
    });
  }

  /*
   * ==========================================
   * PRODUTOR
   * ==========================================
   */

  async function createPeer(
    viewerId
  ) {
    const pc =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              "stun:stun.l.google.com:19302",
          },
        ],
      });

    peerConnections.current.set(
      viewerId,
      pc
    );

    localStream.current
      ?.getTracks()
      .forEach(
        (track) => {
          pc.addTrack(
            track,
            localStream.current
          );
        }
      );

    pc.onicecandidate =
      ({ candidate }) => {
        if (candidate) {
          send({
            type: "ice",
            target: viewerId,
            candidate,
          });
        }
      };

    pc.onconnectionstatechange =
      () => {
        console.log(
          "Producer connection:",
          pc.connectionState
        );
      };

    const offer =
      await pc.createOffer();

    await pc.setLocalDescription(
      offer
    );

    send({
      type: "offer",
      target: viewerId,
      offer,
    });
  }

  /*
   * ==========================================
   * ESPECTADOR
   * ==========================================
   */

  async function handleOffer(
    msg
  ) {
    const pc =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              "stun:stun.l.google.com:19302",
          },
        ],
      });

    peerConnections.current.set(
      msg.from,
      pc
    );

    pc.ontrack =
      ({ streams }) => {
        console.log(
          "Track recebida:",
          streams
        );

        if (
          remoteVideo.current &&
          streams[0]
        ) {
          remoteVideo.current.srcObject =
            streams[0];

          setWatching(true);

          remoteVideo.current
            .play()
            .catch(
              console.warn
            );
        }
      };

    pc.onicecandidate =
      ({ candidate }) => {
        if (candidate) {
          send({
            type: "ice",
            target: msg.from,
            candidate,
          });
        }
      };

    pc.onconnectionstatechange =
      () => {
        console.log(
          "Viewer connection:",
          pc.connectionState
        );
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
      target: msg.from,
      answer,
    });
  }

  /*
   * ==========================================
   * UI
   * ==========================================
   */

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
              discordReady
                ? "dot on"
                : "dot"
            }
          />

          {status}
        </div>
      </header>

      {!inRoom ? (
        <section className="room-screen">
          <div className="room-box">
            <span className="eyebrow">
              SCREENSCAST
            </span>

            <h2>
              Entre em uma sala
            </h2>

            <p>
              Crie uma sala nova ou
              entre em uma sala existente.
            </p>

            <button
              className="primary"
              onClick={
                createRoom
              }
            >
              Criar sala
            </button>

            <div className="separator">
              OU
            </div>

            <input
              value={roomInput}
              onChange={(event) =>
                setRoomInput(
                  event.target.value
                )
              }
              placeholder="Código da sala"
              maxLength={6}
              onKeyDown={(event) => {
                if (
                  event.key ===
                  "Enter"
                ) {
                  joinRoom();
                }
              }}
            />

            <button
              className="secondary"
              onClick={
                joinRoom
              }
            >
              Entrar na sala
            </button>

            {error && (
              <div className="error">
                {error}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="stage">
          <div className="video-card">
            {watching ? (
              <video
                ref={remoteVideo}
                autoPlay
                playsInline
                controls
              />
            ) : sharing ? (
              <video
                ref={localVideo}
                autoPlay
                muted
                playsInline
                style={{
                  width:
                    "100%",
                  height:
                    "100%",
                  objectFit:
                    "contain",
                  background:
                    "#000",
                }}
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
                  da sala possam assistir.
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

            <div className="room-code">
              <span>
                SALA
              </span>

              <strong>
                {roomId}
              </strong>
            </div>

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

            <button
              className="secondary"
              onClick={
                leaveRoom
              }
            >
              Sair da sala
            </button>
          </aside>
        </section>
      )}
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
