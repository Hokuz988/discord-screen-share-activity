import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

/* ==========================================
   CONFIGURAÇÃO
========================================== */

const CLIENT_ID =
  import.meta.env.VITE_DISCORD_CLIENT_ID;

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "wss://screen-share-activity.onrender.com";

const TURN_SERVER_URL =
  "https://screen-share-activity.onrender.com";

let discordSdk = null;

/* ==========================================
   TURN / ICE SERVERS
========================================== */

async function getIceServers() {
  try {
    console.log("Buscando credenciais TURN...");

    const response = await fetch(
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

    const data = await response.json();

    if (
      !data ||
      !Array.isArray(data.iceServers)
    ) {
      throw new Error(
        "Servidor não retornou iceServers válidos."
      );
    }

    /*
     * Remove endpoints na porta 53.
     * Mantemos UDP, TCP e TURN/TLS.
     */

    const iceServers =
      data.iceServers
        .map((server) => {
          if (!Array.isArray(server.urls)) {
            return server;
          }

          return {
            ...server,
            urls: server.urls.filter(
              (url) => !url.includes(":53")
            )
          };
        })
        .filter((server) => {
          if (
            Array.isArray(server.urls)
          ) {
            return server.urls.length > 0;
          }

          return true;
        });

    console.log(
      "TURN/ICE configurado:",
      iceServers.map((server) => ({
        urls: server.urls,
        hasUsername:
          Boolean(server.username),
        hasCredential:
          Boolean(server.credential)
      }))
    );

    return iceServers;

  } catch (error) {
    console.error(
      "Falha ao obter TURN:",
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
  ] = useState("Conectando...");

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
  ] = useState("Visitante");

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
    useRef("discord-activity-room");

  /* ==========================================
     DISCORD SDK
  ========================================== */

  useEffect(() => {
    let alive = true;

    async function setupDiscord() {
      /*
       * Se não houver Client ID,
       * funcionamos normalmente no navegador.
       */

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

        console.log(
          "Discord SDK conectado."
        );

      } catch (error) {
        console.warn(
          "Discord SDK falhou:",
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

  /* ==========================================
     WEBSOCKET
  ========================================== */

  function connectSignal() {
    try {
      console.log(
        "Conectando ao WebSocket:",
        SIGNALING_URL
      );

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

        /*
         * Mantemos o protocolo antigo
         * compatível com o seu servidor.
         */

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
          let msg;

          try {
            msg =
              JSON.parse(
                event.data
              );
          } catch (error) {
            console.error(
              "Mensagem WebSocket inválida:",
              event.data
            );

            return;
          }

          console.log(
            "Servidor:",
            msg
          );

          /* -------------------------------
             VIEWER COUNT
          -------------------------------- */

          if (
            msg.type ===
            "viewer-count"
          ) {
            setViewerCount(
              msg.count || 0
            );

            return;
          }

          /* -------------------------------
             PRODUCER
          -------------------------------- */

          if (
            msg.type ===
            "producer"
          ) {
            /*
             * Se nós mesmos estamos
             * transmitindo, não precisamos
             * assistir nossa própria transmissão.
             */

            if (
              sharing ||
              msg.producerId ===
                getOwnId()
            ) {
              return;
            }

            console.log(
              "Produtor encontrado:",
              msg.producerId
            );

            setWatching(true);

            requestOffer(
              msg.producerId
            );

            return;
          }

          /* -------------------------------
             PRODUCER LEFT
          -------------------------------- */

          if (
            msg.type ===
            "producer-left"
          ) {
            console.log(
              "Produtor saiu."
            );

            setWatching(false);

            if (
              remoteVideo.current
            ) {
              remoteVideo.current.srcObject =
                null;
            }

            closeAllPeers();

            return;
          }

          /* -------------------------------
             REQUEST OFFER
          -------------------------------- */

          if (
            msg.type ===
            "request-offer"
          ) {
            console.log(
              "Pedido de offer recebido:",
              msg.viewerId
            );

            if (
              localStream.current
            ) {
              await createPeer(
                msg.viewerId
              );
            } else {
              console.warn(
                "Pedido de offer recebido, mas não existe stream local."
              );
            }

            return;
          }

          /* -------------------------------
             OFFER
          -------------------------------- */

          if (
            msg.type ===
            "offer"
          ) {
            await handleOffer(
              msg
            );

            return;
          }

          /* -------------------------------
             ANSWER
          -------------------------------- */

          if (
            msg.type ===
            "answer"
          ) {
            const pc =
              peerConnections.current.get(
                msg.from
              );

            if (!pc) {
              console.warn(
                "PeerConnection não encontrada para answer:",
                msg.from
              );

              return;
            }

            try {
              await pc.setRemoteDescription(
                msg.answer
              );

              console.log(
                "RemoteDescription da answer configurada."
              );

              await flushPendingCandidates(
                msg.from
              );

            } catch (error) {
              console.error(
                "Erro ao configurar answer:",
                error
              );
            }

            return;
          }

          /* -------------------------------
             ICE
          -------------------------------- */

          if (
            msg.type ===
            "ice"
          ) {
            await handleIceCandidate(
              msg
            );

            return;
          }

          /* -------------------------------
             ERROR
          -------------------------------- */

          if (
            msg.type ===
            "error"
          ) {
            console.error(
              "Erro do servidor:",
              msg.message
            );

            setError(
              msg.message ||
              "Erro no servidor."
            );
          }
        };

      socket.onerror =
        (event) => {
          console.error(
            "WebSocket error:",
            event
          );

          setError(
            "Erro de conexão com o servidor."
          );
        };

      socket.onclose =
        (event) => {
          console.warn(
            "WebSocket fechado:",
            event.code,
            event.reason
          );

          setStatus(
            "Servidor desconectado"
          );
        };

    } catch (error) {
      console.error(
        "Erro WebSocket:",
        error
      );

      setError(
        "WebSocket indisponível."
      );
    }
  }

  /* ==========================================
     ID DO USUÁRIO
  ========================================== */

  function getOwnId() {
    /*
     * O ID real fica no WebSocket.
     * Não precisamos dele no frontend
     * para o funcionamento normal.
     */

    return null;
  }

  /* ==========================================
     SEND
  ========================================== */

  function send(message) {
    if (
      ws.current &&
      ws.current.readyState ===
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

    } else {
      console.warn(
        "WebSocket não está conectado."
      );
    }
  }

  /* ==========================================
     CAPTURA DA TELA
  ========================================== */

  async function startSharing() {
    setError("");

    try {
      console.log(
        "Solicitando captura da tela..."
      );

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

      /* -------------------------------
         VIDEO LOCAL
      -------------------------------- */

      if (
        localVideo.current
      ) {
        localVideo.current.srcObject =
          stream;

        try {
          await localVideo.current.play();
        } catch (error) {
          console.warn(
            "Autoplay local bloqueado:",
            error
          );
        }
      }

      /* -------------------------------
         VIDEO TRACK
      -------------------------------- */

      const videoTracks =
        stream.getVideoTracks();

      console.log(
        "VIDEO TRACKS:",
        videoTracks
      );

      if (
        videoTracks.length > 0
      ) {
        const videoTrack =
          videoTracks[0];

        console.log(
          "VIDEO TRACK:",
          videoTrack
        );

        console.log(
          "TRACK SETTINGS:",
          videoTrack.getSettings()
        );

        console.log(
          "TRACK STATE:",
          videoTrack.readyState
        );

        videoTrack.addEventListener(
          "ended",
          () => {
            console.log(
              "Usuário encerrou a captura."
            );

            stopSharing();
          }
        );
      }

      /* -------------------------------
         AUDIO TRACK
      -------------------------------- */

      console.log(
        "AUDIO TRACKS:",
        stream.getAudioTracks()
      );

      /* -------------------------------
         ESTADO
      -------------------------------- */

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

    } catch (error) {
      console.error(
        "Erro ao iniciar captura:",
        error
      );

      if (
        error?.name ===
        "NotAllowedError"
      ) {
        return;
      }

      setError(
        "Não foi possível iniciar a captura da tela."
      );
    }
  }

  /* ==========================================
     PARAR TRANSMISSÃO
  ========================================== */

  function stopSharing() {
    console.log(
      "Parando transmissão..."
    );

    if (
      localStream.current
    ) {
      localStream.current
        .getTracks()
        .forEach(
          (track) => {
            track.stop();
          }
        );
    }

    localStream.current =
      null;

    if (
      localVideo.current
    ) {
      localVideo.current.srcObject =
        null;
    }

    closeAllPeers();

    if (
      ws.current &&
      ws.current.readyState ===
        WebSocket.OPEN
    ) {
      send({
        type:
          "stop-sharing"
      });
    }

    setSharing(false);

    setWatching(false);

    setStatus(
      "Servidor conectado"
    );
  }

  /* ==========================================
     FECHAR PEERS
  ========================================== */

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

  /* ==========================================
     PEDIR OFFER
  ========================================== */

  function requestOffer(
    producerId
  ) {
    console.log(
      "Pedindo offer ao produtor:",
      producerId
    );

    send({
      type:
        "request-offer",
      producerId
    });
  }

  /* ==========================================
     CRIAR PEER DO PRODUTOR
  ========================================== */

  async function createPeer(
    viewerId
  ) {
    console.log(
      "Criando PeerConnection para viewer:",
      viewerId
    );

    /*
     * Se já existe conexão,
     * fechamos antes de criar outra.
     */

    const oldPc =
      peerConnections.current.get(
        viewerId
      );

    if (oldPc) {
      try {
        oldPc.close();
      } catch {}
    }

    const iceServers =
      await getIceServers();

    console.log(
      "ICE Servers do produtor:",
      iceServers
    );

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

    /* -------------------------------
       DEBUG ICE
    -------------------------------- */

    pc.oniceconnectionstatechange =
      () => {
        console.log(
          "PRODUTOR ICE:",
          pc.iceConnectionState
        );
      };

    pc.onconnectionstatechange =
      () => {
        console.log(
          "PRODUTOR CONNECTION:",
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "failed"
        ) {
          console.error(
            "Conexão do produtor falhou."
          );
        }
      };

    pc.onicegatheringstatechange =
      () => {
        console.log(
          "PRODUTOR GATHERING:",
          pc.iceGatheringState
        );
      };

    pc.onsignalingstatechange =
      () => {
        console.log(
          "PRODUTOR SIGNALING:",
          pc.signalingState
        );
      };

    /* -------------------------------
       ADICIONAR STREAM
    -------------------------------- */

    if (
      localStream.current
    ) {
      const tracks =
        localStream.current.getTracks();

      console.log(
        "Adicionando tracks:",
        tracks
      );

      tracks.forEach(
        (track) => {
          pc.addTrack(
            track,
            localStream.current
          );
        }
      );
    }

    /* -------------------------------
       ICE CANDIDATE
    -------------------------------- */

    pc.onicecandidate =
      ({ candidate }) => {
        if (candidate) {
          console.log(
            "PRODUTOR ICE candidate:",
            candidate.candidate
          );

          send({
            type: "ice",
            target:
              viewerId,
            candidate
          });
        }
      };

    /* -------------------------------
       ICE CANDIDATE ERROR
    -------------------------------- */

    pc.onicecandidateerror =
      (event) => {
        console.warn(
          "PRODUTOR ICE candidate error:",
          event
        );
      };

    /* -------------------------------
       OFFER
    -------------------------------- */

    const offer =
      await pc.createOffer();

    console.log(
      "Offer criada:",
      offer
    );

    await pc.setLocalDescription(
      offer
    );

    console.log(
      "LocalDescription configurada."
    );

    send({
      type: "offer",
      target:
        viewerId,
      offer:
        pc.localDescription
    });

    console.log(
      "Offer enviada para:",
      viewerId
    );

    return pc;
  }

  /* ==========================================
     HANDLE OFFER — VIEWER
  ========================================== */

  async function handleOffer(
    msg
  ) {
    console.log(
      "Offer recebida:",
      msg
    );

    const oldPc =
      peerConnections.current.get(
        msg.from
      );

    if (oldPc) {
      try {
        oldPc.close();
      } catch {}
    }

    const iceServers =
      await getIceServers();

    console.log(
      "ICE Servers do viewer:",
      iceServers
    );

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

    /* -------------------------------
       DEBUG ICE
    -------------------------------- */

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

        if (
          pc.connectionState ===
          "connected"
        ) {
          console.log(
            "================================"
          );

          console.log(
            "WEBRTC CONECTADO!"
          );

          console.log(
            "================================"
          );

          setWatching(
            true
          );
        }

        if (
          pc.connectionState ===
          "failed"
        ) {
          console.error(
            "Viewer connection: failed"
          );

          setError(
            "A conexão WebRTC falhou."
          );
        }
      };

    pc.onicegatheringstatechange =
      () => {
        console.log(
          "VIEWER GATHERING:",
          pc.iceGatheringState
        );
      };

    pc.onsignalingstatechange =
      () => {
        console.log(
          "VIEWER SIGNALING:",
          pc.signalingState
        );
      };

    /* -------------------------------
       TRACK
    -------------------------------- */

    pc.ontrack =
      ({
        streams
      }) => {
        console.log(
          "TRACK RECEBIDA:",
          streams
        );

        const stream =
          streams?.[0];

        if (
          !stream
        ) {
          console.warn(
            "Track recebida sem MediaStream."
          );

          return;
        }

        if (
          remoteVideo.current
        ) {
          remoteVideo.current.srcObject =
            stream;

          remoteVideo.current
            .play()
            .then(() => {
              console.log(
                "Vídeo remoto reproduzindo."
              );
            })
            .catch(
              (error) => {
                console.warn(
                  "Autoplay remoto bloqueado:",
                  error
                );
              }
            );
        }

        setWatching(
          true
        );
      };

    /* -------------------------------
       ICE
    -------------------------------- */

    pc.onicecandidate =
      ({ candidate }) => {
        if (candidate) {
          console.log(
            "VIEWER ICE candidate:",
            candidate.candidate
          );

          send({
            type: "ice",
            target:
              msg.from,
            candidate
          });
        }
      };

    pc.onicecandidateerror =
      (event) => {
        console.warn(
          "VIEWER ICE candidate error:",
          event
        );
      };

    /* -------------------------------
       REMOTE DESCRIPTION
    -------------------------------- */

    try {
      await pc.setRemoteDescription(
        msg.offer
      );

      console.log(
        "RemoteDescription configurada."
      );

      await flushPendingCandidates(
        msg.from
      );

    } catch (error) {
      console.error(
        "Erro setRemoteDescription:",
        error
      );

      return;
    }

    /* -------------------------------
       ANSWER
    -------------------------------- */

    try {
      const answer =
        await pc.createAnswer();

      console.log(
        "Answer criada:",
        answer
      );

      await pc.setLocalDescription(
        answer
      );

      console.log(
        "LocalDescription da answer configurada."
      );

      send({
        type: "answer",
        target:
          msg.from,
        answer:
          pc.localDescription
      });

      console.log(
        "Answer enviada."
      );

    } catch (error) {
      console.error(
        "Erro criando answer:",
        error
      );
    }
  }

  /* ==========================================
     ICE CANDIDATE
  ========================================== */

  async function handleIceCandidate(
    msg
  ) {
    const pc =
      peerConnections.current.get(
        msg.from
      );

    if (
      !pc
    ) {
      console.warn(
        "Peer ainda não existe para ICE:",
        msg.from
      );

      /*
       * Guarda o candidate até a
       * PeerConnection existir.
       */

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

    /*
     * Não adiciona ICE antes de
     * setRemoteDescription.
     */

    if (
      !pc.remoteDescription
    ) {
      console.log(
        "Guardando ICE até remoteDescription."
      );

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

      console.log(
        "ICE candidate adicionado."
      );

    } catch (error) {
      console.warn(
        "Erro addIceCandidate:",
        error
      );
    }
  }

  /* ==========================================
     PROCESSAR ICE PENDENTE
  ========================================== */

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
      !candidates ||
      candidates.length === 0
    ) {
      return;
    }

    console.log(
      `Processando ${candidates.length} ICE candidates pendentes.`
    );

    for (
      const candidate of candidates
    ) {
      try {
        await pc.addIceCandidate(
          candidate
        );
      } catch (error) {
        console.warn(
          "Erro ICE pendente:",
          error
        );
      }
    }

    pendingCandidates.current.delete(
      peerId
    );
  }

  /* ==========================================
     UI
  ========================================== */

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
              style={{
                width:
                  "100%",
                height:
                  "100%",
                objectFit:
                  "contain"
              }}
            />

          ) : sharing ? (

            <video
              ref={
                localVideo
              }
              autoPlay
              muted
              playsInline
              style={{
                width:
                  "100%",
                height:
                  "100%",
                objectFit:
                  "contain"
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
                da Activity possam
                assistir.
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
            A captura começa
            somente depois que
            você escolher uma tela,
            janela ou aba.
          </small>

        </aside>

      </section>

    </main>
  );
}

/* ==========================================
   START REACT
========================================== */

const rootElement =
  document.getElementById(
    "root"
  );

if (!rootElement) {
  throw new Error(
    "Elemento #root não encontrado."
  );
}

createRoot(
  rootElement
).render(
  <App />
);

