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

const MAX_PRODUCERS = 3;

let discordSdk = null;

/* =========================================================
   TURN
========================================================= */

async function getIceServers() {
  try {
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

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(data.iceServers)
    ) {
      throw new Error(
        "TURN inválido."
      );
    }

    return data.iceServers;

  } catch (error) {
    console.warn(
      "TURN indisponível:",
      error
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
  ] = useState("Conectando...");

  const [
    sharing,
    setSharing
  ] = useState(false);

  const [
    roomCode,
    setRoomCode
  ] = useState("");

  const [
    roomInput,
    setRoomInput
  ] = useState("");

  const [
    currentRoom,
    setCurrentRoom
  ] = useState("");

  const [
    inRoom,
    setInRoom
  ] = useState(false);

  const [
    error,
    setError
  ] = useState("");

  const [
    viewerCount,
    setViewerCount
  ] = useState(0);

  const [
    producers,
    setProducers
  ] = useState([]);

  const [
    selectedProducer,
    setSelectedProducer
  ] = useState("local");

  const [
    audioStates,
    setAudioStates
  ] = useState({});

  /* =======================================================
     REFS
  ======================================================= */

  const ws =
    useRef(null);

  const localStream =
    useRef(null);

  /*
   * producerId -> MediaStream
   */
  const streams =
    useRef(new Map());

  /*
   * IMPORTANTE:
   *
   * producerId -> Set<HTMLVideoElement>
   *
   * Uma transmissão pode aparecer
   * no vídeo principal E na miniatura.
   */
  const videoRefs =
    useRef(new Map());

  /*
   * producerId -> várias PeerConnections
   */
  const peerConnections =
    useRef(new Map());

  const pendingCandidates =
    useRef(new Map());

  const roomId =
    useRef("");

  const myId =
    useRef("");

  /* =========================================================
     FUNÇÃO PARA CONECTAR STREAM A TODOS OS VIDEOS
  ========================================================= */

  function attachStreamToVideos(
    producerId,
    stream
  ) {

    const videos =
      videoRefs.current.get(
        producerId
      );

    if (!videos) {
      return;
    }

    for (const video of videos) {

      if (!video) {
        continue;
      }

      if (
        video.srcObject !==
        stream
      ) {

        video.srcObject =
          stream;
      }

      /*
       * Vídeo local nunca
       * precisa reproduzir áudio.
       */

      if (
        producerId === "local"
      ) {

        video.muted =
          true;

      } else {

        video.muted =
          !(
            audioStates[
              producerId
            ] ?? false
          );
      }

      video.playsInline =
        true;

      video.play()
        .catch(() => {});
    }
  }

  /* =========================================================
     DISCORD
  ========================================================= */

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

      cleanupAll();

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
        async event => {

          let msg;

          try {

            msg =
              JSON.parse(
                event.data
              );

          } catch {

            console.error(
              "Mensagem inválida:",
              event.data
            );

            return;
          }

          console.log(
            "Servidor:",
            msg
          );

          /* =================================================
             CLIENT ID
          ================================================= */

          if (
            msg.type ===
            "client-id"
          ) {

            myId.current =
              msg.id;

            return;
          }

          /* =================================================
             SALA CRIADA
          ================================================= */

          if (
            msg.type ===
            "room-created"
          ) {

            const code =
              String(
                msg.roomId
              )
                .trim()
                .toUpperCase();

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

            setProducers(
              []
            );

            setSelectedProducer(
              "local"
            );

            setError("");

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

            const code =
              String(
                msg.roomId
              )
                .trim()
                .toUpperCase();

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

            setError("");

            setStatus(
              "Você entrou na sala"
            );

            return;
          }

          /* =================================================
             LISTA DE PRODUTORES
          ================================================= */

          if (
            msg.type ===
            "producer-list"
          ) {

            const list =
              Array.isArray(
                msg.producers
              )
                ? msg.producers
                : [];

            console.log(
              "PRODUTORES:",
              list
            );

            setProducers(
              list
            );

            setSelectedProducer(
              current => {

                if (
                  current ===
                  "local"
                ) {
                  return current;
                }

                if (
                  list.includes(
                    current
                  )
                ) {
                  return current;
                }

                return (
                  list[0] ||
                  "local"
                );
              }
            );

            /*
             * Solicita todas as transmissões
             * que já estavam ativas.
             */

            for (
              const producerId
              of list
            ) {

              if (
                producerId ===
                myId.current
              ) {
                continue;
              }

              requestOffer(
                producerId
              );
            }

            return;
          }

          /* =================================================
             NOVO PRODUTOR
          ================================================= */

          if (
            msg.type ===
            "producer"
          ) {

            const producerId =
              msg.producerId;

            if (!producerId) {
              return;
            }

            setProducers(
              current => {

                if (
                  current.includes(
                    producerId
                  )
                ) {
                  return current;
                }

                if (
                  current.length >=
                  MAX_PRODUCERS
                ) {
                  return current;
                }

                return [
                  ...current,
                  producerId
                ];
              }
            );

            if (
              producerId !==
              myId.current
            ) {

              requestOffer(
                producerId
              );
            }

            return;
          }

          /* =================================================
             PRODUTOR SAIU
          ================================================= */

          if (
            msg.type ===
            "producer-left"
          ) {

            const producerId =
              msg.producerId;

            if (!producerId) {
              return;
            }

            removeRemoteProducer(
              producerId
            );

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
              Number(
                msg.count || 0
              )
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

            console.error(
              "Servidor:",
              msg.message
            );

            setError(
              msg.message ||
              "Erro no servidor."
            );

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

              await createProducerPeer(
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

            await handleAnswer(
              msg
            );

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
        error => {

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

          console.warn(
            "WebSocket fechado."
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

  /* =========================================================
     SEND
  ========================================================= */

  function send(message) {

    if (
      !ws.current ||
      ws.current.readyState !==
      WebSocket.OPEN
    ) {

      console.warn(
        "WebSocket não conectado."
      );

      return;
    }

    const payload = {
      ...message
    };

    if (
      !payload.roomId &&
      roomId.current
    ) {

      payload.roomId =
        roomId.current;
    }

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
     ENTRAR NA SALA
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
        "join-room",

      roomId:
        code
    });
  }

  /* =========================================================
     SAIR
  ========================================================= */

  function leaveRoom() {

    if (
      ws.current &&
      ws.current.readyState ===
      WebSocket.OPEN &&
      roomId.current
    ) {

      send({
        type:
          "leave-room"
      });
    }

    cleanupStreams();

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

    setProducers(
      []
    );

    setSelectedProducer(
      "local"
    );

    setViewerCount(
      0
    );

    setStatus(
      "Servidor conectado"
    );
  }

  /* =========================================================
     CAPTURA DE TELA
  ========================================================= */

  async function startSharing() {

    setError("");

    if (!inRoom) {

      setError(
        "Entre em uma sala primeiro."
      );

      return;
    }

    if (sharing) {

      setError(
        "Você já está transmitindo."
      );

      return;
    }

    if (
      producers.length >=
      MAX_PRODUCERS
    ) {

      setError(
        "A sala já possui 3 transmissões ativas."
      );

      return;
    }

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
              },

              width: {
                ideal: 1920
              },

              height: {
                ideal: 1080
              }
            },

            audio: true
          }
        );

      console.log(
        "Stream local:",
        stream
      );

      localStream.current =
        stream;

      streams.current.set(
        "local",
        stream
      );

      /*
       * Atualiza imediatamente
       * qualquer vídeo local existente.
       */

      attachStreamToVideos(
        "local",
        stream
      );

      setAudioStates(
        current => ({
          ...current,
          local: false
        })
      );

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

      setSelectedProducer(
        "local"
      );

      /*
       * IMPORTANTE:
       * avisa o servidor somente
       * depois que o stream existe.
       */

      send({
        type:
          "start-sharing"
      });

      setStatus(
        "Você está transmitindo"
      );

    } catch (error) {

      console.error(
        "Erro captura:",
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
     PARAR TRANSMISSÃO
  ========================================================= */

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
          track => {

            try {
              track.stop();
            } catch {}
          }
        );
    }

    localStream.current =
      null;

    streams.current.delete(
      "local"
    );

    /*
     * Fecha conexões onde
     * somos produtor.
     */

    for (
      const [
        key,
        pc
      ]
      of peerConnections.current
    ) {

      if (
        key.startsWith(
          "local->"
        )
      ) {

        try {
          pc.close();
        } catch {}

        peerConnections.current.delete(
          key
        );
      }
    }

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

    if (
      myId.current
    ) {

      setProducers(
        current =>
          current.filter(
            id =>
              id !==
              myId.current
          )
      );
    }

    setSharing(
      false
    );

    setSelectedProducer(
      "local"
    );

    setStatus(
      "Servidor conectado"
    );
  }

  /* =========================================================
     REQUEST OFFER
  ========================================================= */

  function requestOffer(
    producerId
  ) {

    if (!producerId) {
      return;
    }

    if (
      producerId ===
      myId.current
    ) {
      return;
    }

    console.log(
      "Pedindo transmissão:",
      producerId
    );

    send({
      type:
        "request-offer",

      producerId
    });
  }

  /* =========================================================
     CREATE PEER — PRODUTOR
  ========================================================= */

  async function createProducerPeer(
    viewerId
  ) {

    if (
      !viewerId ||
      !localStream.current
    ) {
      return;
    }

    const key =
      `local->${viewerId}`;

    const old =
      peerConnections.current.get(
        key
      );

    if (old) {

      try {
        old.close();
      } catch {}

      peerConnections.current.delete(
        key
      );
    }

    const iceServers =
      await getIceServers();

    const pc =
      new RTCPeerConnection({
        iceServers
      });

    peerConnections.current.set(
      key,
      pc
    );

    /*
     * Adiciona vídeo + áudio.
     */

    for (
      const track
      of localStream.current.getTracks()
    ) {

      pc.addTrack(
        track,
        localStream.current
      );
    }

    pc.onicecandidate =
      ({ candidate }) => {

        if (!candidate) {
          return;
        }

        send({
          type:
            "ice",

          target:
            viewerId,

          producerId:
            myId.current,

          candidate
        });
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "PRODUTOR",
          viewerId,
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "failed"
        ) {

          try {
            pc.close();
          } catch {}

          peerConnections.current.delete(
            key
          );
        }
      };

    try {

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

        producerId:
          myId.current,

        offer:
          pc.localDescription
      });

    } catch (error) {

      console.error(
        "Erro criando offer:",
        error
      );
    }
  }

  /* =========================================================
     HANDLE OFFER — VIEWER
  ========================================================= */

  async function handleOffer(
    msg
  ) {

    const producerId =
      msg.producerId ||
      msg.from;

    const key =
      `${producerId}->local`;

    console.log(
      "OFFER recebida:",
      producerId
    );

    const old =
      peerConnections.current.get(
        key
      );

    if (old) {

      try {
        old.close();
      } catch {}
    }

    const iceServers =
      await getIceServers();

    const pc =
      new RTCPeerConnection({
        iceServers
      });

    peerConnections.current.set(
      key,
      pc
    );

    /*
     * TRACK REMOTA
     */

    pc.ontrack =
      event => {

        console.log(
          "TRACK recebida:",
          producerId,
          event.track.kind
        );

        let stream =
          streams.current.get(
            producerId
          );

        if (!stream) {

          stream =
            new MediaStream();

          streams.current.set(
            producerId,
            stream
          );
        }

        /*
         * Adiciona a track somente
         * se ainda não existir.
         */

        if (
          !stream
            .getTracks()
            .some(
              track =>
                track.id ===
                event.track.id
            )
        ) {

          stream.addTrack(
            event.track
          );
        }

        /*
         * AQUI ESTÁ A CORREÇÃO PRINCIPAL.
         *
         * Em vez de procurar apenas
         * um vídeo, conectamos o stream
         * a TODOS os vídeos daquela
         * transmissão.
         */

        attachStreamToVideos(
          producerId,
          stream
        );

        /*
         * Garante que a transmissão
         * apareça na interface.
         */

        setProducers(
          current => {

            if (
              current.includes(
                producerId
              )
            ) {
              return current;
            }

            if (
              current.length >=
              MAX_PRODUCERS
            ) {
              return current;
            }

            return [
              ...current,
              producerId
            ];
          }
        );
      };

    pc.onicecandidate =
      ({ candidate }) => {

        if (!candidate) {
          return;
        }

        send({
          type:
            "ice",

          target:
            msg.from,

          producerId,

          candidate
        });
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "VIEWER",
          producerId,
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "connected"
        ) {

          console.log(
            "WebRTC conectado:",
            producerId
          );

          setStatus(
            "Transmissão conectada"
          );

          /*
           * Tenta anexar novamente
           * caso o elemento já exista.
           */

          const stream =
            streams.current.get(
              producerId
            );

          if (stream) {

            attachStreamToVideos(
              producerId,
              stream
            );
          }
        }

        if (
          pc.connectionState ===
          "failed"
        ) {

          console.warn(
            "WebRTC falhou:",
            producerId
          );
        }

        if (
          pc.connectionState ===
          "disconnected"
        ) {

          console.warn(
            "WebRTC desconectado:",
            producerId
          );
        }
      };

    try {

      await pc.setRemoteDescription(
        msg.offer
      );

      await flushPendingCandidates(
        key
      );

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

        producerId,

        answer:
          pc.localDescription
      });

    } catch (error) {

      console.error(
        "Erro processando offer:",
        error
      );
    }
  }

  /* =========================================================
     HANDLE ANSWER
  ========================================================= */

  async function handleAnswer(
    msg
  ) {

    const key =
      `local->${msg.from}`;

    let pc =
      peerConnections.current.get(
        key
      );

    if (!pc) {

      for (
        const [
          connectionKey,
          connection
        ]
        of peerConnections.current
      ) {

        if (
          connectionKey.endsWith(
            `->${msg.from}`
          )
        ) {

          pc =
            connection;

          break;
        }
      }
    }

    if (!pc) {

      console.warn(
        "Peer não encontrado:",
        msg.from
      );

      return;
    }

    try {

      await pc.setRemoteDescription(
        msg.answer
      );

      await flushPendingCandidates(
        key
      );

    } catch (error) {

      console.error(
        "Erro answer:",
        error
      );
    }
  }

  /* =========================================================
     ICE
  ========================================================= */

  async function handleIceCandidate(
    msg
  ) {

    const producerId =
      msg.producerId ||
      msg.from;

    const viewerKey =
      `${producerId}->local`;

    const producerKey =
      `local->${msg.from}`;

    let key =
      viewerKey;

    let pc =
      peerConnections.current.get(
        viewerKey
      );

    if (!pc) {

      key =
        producerKey;

      pc =
        peerConnections.current.get(
          producerKey
        );
    }

    if (
      !pc ||
      !pc.remoteDescription
    ) {

      if (
        !pendingCandidates.current.has(
          key
        )
      ) {

        pendingCandidates.current.set(
          key,
          []
        );
      }

      pendingCandidates.current
        .get(key)
        .push(
          msg.candidate
        );

      return;
    }

    try {

      await pc.addIceCandidate(
        msg.candidate
      );

    } catch (error) {

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
    key
  ) {

    const pc =
      peerConnections.current.get(
        key
      );

    if (
      !pc ||
      !pc.remoteDescription
    ) {
      return;
    }

    const candidates =
      pendingCandidates.current.get(
        key
      );

    if (
      !candidates ||
      candidates.length === 0
    ) {
      return;
    }

    for (
      const candidate
      of candidates
    ) {

      try {

        await pc.addIceCandidate(
          candidate
        );

      } catch (error) {

        console.warn(
          "Erro ICE:",
          error
        );
      }
    }

    pendingCandidates.current.delete(
      key
    );
  }

  /* =========================================================
     REMOVER TRANSMISSÃO
  ========================================================= */

  function removeRemoteProducer(
    producerId
  ) {

    console.log(
      "Removendo transmissão:",
      producerId
    );

    const key =
      `${producerId}->local`;

    const pc =
      peerConnections.current.get(
        key
      );

    if (pc) {

      try {
        pc.close();
      } catch {}

      peerConnections.current.delete(
        key
      );
    }

    pendingCandidates.current.delete(
      key
    );

    const stream =
      streams.current.get(
        producerId
      );

    if (stream) {

      stream
        .getTracks()
        .forEach(
          track => {

            try {
              track.stop();
            } catch {}
          }
        );
    }

    streams.current.delete(
      producerId
    );

    /*
     * Limpa TODOS os vídeos
     * dessa transmissão.
     */

    const videos =
      videoRefs.current.get(
        producerId
      );

    if (videos) {

      for (
        const video
        of videos
      ) {

        if (video) {
          video.srcObject =
            null;
        }
      }
    }

    videoRefs.current.delete(
      producerId
    );

    setProducers(
      current =>
        current.filter(
          id =>
            id !==
            producerId
        )
    );

    setSelectedProducer(
      current => {

        if (
          current !==
          producerId
        ) {
          return current;
        }

        return "local";
      }
    );

    setAudioStates(
      current => {

        const next = {
          ...current
        };

        delete next[
          producerId
        ];

        return next;
      }
    );
  }

  /* =========================================================
     ÁUDIO
  ========================================================= */

  function toggleAudio(
    producerId
  ) {

    const next =
      !(
        audioStates[
          producerId
        ] ?? false
      );

    setAudioStates(
      current => ({
        ...current,
        [producerId]:
          next
      })
    );

    const videos =
      videoRefs.current.get(
        producerId
      );

    if (!videos) {
      return;
    }

    for (
      const video
      of videos
    ) {

      if (!video) {
        continue;
      }

      video.muted =
        !next;

      video.volume =
        1;

      if (next) {

        video.play()
          .catch(() => {});
      }
    }
  }

  /* =========================================================
     SELECIONAR TRANSMISSÃO
  ========================================================= */

  function selectProducer(
    producerId
  ) {

    setSelectedProducer(
      producerId
    );

    setTimeout(
      () => {

        const stream =
          streams.current.get(
            producerId
          );

        if (!stream) {
          return;
        }

        attachStreamToVideos(
          producerId,
          stream
        );

      },
      50
    );
  }

  /* =========================================================
     VIDEO REF
  ========================================================= */

  function setVideoRef(
    producerId,
    element
  ) {

    /*
     * Cria um Set para a transmissão.
     */

    if (
      !videoRefs.current.has(
        producerId
      )
    ) {

      videoRefs.current.set(
        producerId,
        new Set()
      );
    }

    const videos =
      videoRefs.current.get(
        producerId
      );

    /*
     * React chama callback
     * com null quando desmonta.
     *
     * Não fazemos nada nesse caso
     * porque o cleanup completo
     * cuida das referências.
     */

    if (!element) {
      return;
    }

    videos.add(
      element
    );

    /*
     * Se o stream já chegou
     * antes do elemento existir,
     * conecta agora.
     */

    const stream =
      streams.current.get(
        producerId
      );

    if (stream) {

      element.srcObject =
        stream;

      element.playsInline =
        true;

      if (
        producerId ===
        "local"
      ) {

        element.muted =
          true;

      } else {

        element.muted =
          !(
            audioStates[
              producerId
            ] ?? false
          );
      }

      element.play()
        .catch(() => {});
    }
  }

  /* =========================================================
     CLEANUP
  ========================================================= */

  function cleanupStreams() {

    if (
      localStream.current
    ) {

      localStream.current
        .getTracks()
        .forEach(
          track => {

            try {
              track.stop();
            } catch {}
          }
        );
    }

    localStream.current =
      null;

    for (
      const stream
      of streams.current.values()
    ) {

      stream
        .getTracks()
        .forEach(
          track => {

            try {
              track.stop();
            } catch {}
          }
        );
    }

    streams.current.clear();

    for (
      const pc
      of peerConnections.current.values()
    ) {

      try {
        pc.close();
      } catch {}
    }

    peerConnections.current.clear();

    pendingCandidates.current.clear();

    /*
     * Limpa srcObject dos vídeos.
     */

    for (
      const videos
      of videoRefs.current.values()
    ) {

      for (
        const video
        of videos
      ) {

        if (video) {
          video.srcObject =
            null;
        }
      }
    }

    videoRefs.current.clear();
  }

  function cleanupAll() {

    cleanupStreams();

    roomId.current =
      "";

    setSharing(
      false
    );

    setProducers(
      []
    );
  }

  /* =========================================================
     DERIVADOS
  ========================================================= */

  const allProducerIds =
    producers
      .filter(
        id =>
          id !== undefined &&
          id !== null
      )
      .slice(
        0,
        MAX_PRODUCERS
      );

  const displayProducers =
    sharing &&
    myId.current &&
    !allProducerIds.includes(
      myId.current
    )
      ? [
          ...allProducerIds,
          myId.current
        ].slice(
          0,
          MAX_PRODUCERS
        )
      : allProducerIds;

  const hasStreams =
    displayProducers.length >
    0;

  const mainProducer =
    selectedProducer ===
      "local" &&
    !sharing
      ? (
          displayProducers[0] ||
          "local"
        )
      : selectedProducer;

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <main className="app">

      {!inRoom ? (

        <section className="room-menu">

          <div className="brand">

            <span className="eyebrow">
              DISCORD ACTIVITY
            </span>

            <h1>
              ScreenCast
            </h1>

            <p className="muted">
              Compartilhe sua tela
              com até 3 pessoas
              transmitindo ao mesmo
              tempo.
            </p>

          </div>

          <button
            className="primary"
            onClick={
              createRoom
            }
          >
            ➕ Criar sala
          </button>

          <div className="divider">
            <span>
              ou
            </span>
          </div>

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
              autoComplete="off"
            />

            <button
              className="secondary"
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

          <div className="connection">

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

        </section>

      ) : (

        <section className="room-layout">

          <header className="room-bar">

            <div className="room-info">

              <span>
                SALA
              </span>

              <strong>
                {currentRoom}
              </strong>

              <span className="live-users">
                👥 {viewerCount}
              </span>

            </div>

            <div className="room-actions">

              <span className="server-status">

                <i
                  className={
                    `dot ${
                      ws.current?.readyState ===
                      WebSocket.OPEN
                        ? "on"
                        : ""
                    }`
                  }
                />

                {status}

              </span>

              <button
                className="leave-button"
                onClick={
                  leaveRoom
                }
              >
                Sair
              </button>

            </div>

          </header>

          <div className="broadcast-layout">

            {/* =================================================
                VÍDEO PRINCIPAL
            ================================================= */}

            <section className="main-stage">

              {hasStreams ? (

                <div className="main-video-wrapper">

                  {mainProducer ===
                    "local" ? (

                    sharing ? (

                      <video
                        ref={
                          element =>
                            setVideoRef(
                              "local",
                              element
                            )
                        }
                        autoPlay
                        muted
                        playsInline
                      />

                    ) : (

                      <div className="empty">

                        <div className="empty-icon">
                          🖥️
                        </div>

                        <h2>
                          Nenhuma transmissão
                        </h2>

                      </div>

                    )

                  ) : (

                    <video
                      ref={
                        element =>
                          setVideoRef(
                            mainProducer,
                            element
                          )
                      }
                      autoPlay
                      playsInline
                      controls
                      muted={
                        !(
                          audioStates[
                            mainProducer
                          ] ?? false
                        )
                      }
                    />

                  )}

                  <div className="main-overlay">

                    <div className="stream-title">

                      {mainProducer ===
                      "local"
                        ? "Sua transmissão"
                        : "Transmissão ao vivo"}

                    </div>

                    <button
                      className="audio-button"
                      onClick={
                        () =>
                          toggleAudio(
                            mainProducer
                          )
                      }
                    >
                      {audioStates[
                        mainProducer
                      ]
                        ? "🔊"
                        : "🔇"}
                    </button>

                  </div>

                </div>

              ) : (

                <div className="empty">

                  <div className="empty-icon">
                    🖥️
                  </div>

                  <h2>
                    Nenhuma transmissão
                  </h2>

                  <p>
                    Inicie uma transmissão
                    para aparecer aqui.
                  </p>

                </div>

              )}

            </section>

            {/* =================================================
                SIDEBAR
            ================================================= */}

            <aside className="streams-sidebar">

              <div className="sidebar-header">

                <div>

                  <strong>
                    Transmissões
                  </strong>

                  <span>
                    {displayProducers.length}
                    /{MAX_PRODUCERS}
                  </span>

                </div>

              </div>

              <div className="stream-list">

                {displayProducers.map(
                  producerId => {

                    const isLocal =
                      producerId ===
                      myId.current;

                    const isSelected =
                      mainProducer ===
                      producerId;

                    const audioKey =
                      isLocal
                        ? "local"
                        : producerId;

                    return (

                      <button
                        key={
                          producerId
                        }
                        className={
                          `stream-thumb ${
                            isSelected
                              ? "selected"
                              : ""
                          }`
                        }
                        onClick={() =>
                          selectProducer(
                            isLocal
                              ? "local"
                              : producerId
                          )
                        }
                      >

                        <div className="thumb-video">

                          <video
                            ref={
                              element =>
                                setVideoRef(
                                  isLocal
                                    ? "local"
                                    : producerId,
                                  element
                                )
                            }
                            autoPlay
                            playsInline
                            muted={
                              isLocal
                                ? true
                                : !(
                                    audioStates[
                                      audioKey
                                    ] ?? false
                                  )
                            }
                          />

                          <span className="thumb-live">
                            ● AO VIVO
                          </span>

                        </div>

                        <div className="thumb-info">

                          <span>
                            {isLocal
                              ? "Você"
                              : "Transmissão"}
                          </span>

                          <span
                            className="thumb-audio"
                            onClick={
                              event => {

                                event.stopPropagation();

                                toggleAudio(
                                  audioKey
                                );
                              }
                            }
                          >
                            {
                              audioStates[
                                audioKey
                              ]
                                ? "🔊"
                                : "🔇"
                            }
                          </span>

                        </div>

                      </button>
                    );
                  }
                )}

                {displayProducers.length ===
                  0 && (

                  <div className="no-streams">

                    <span>
                      🖥️
                    </span>

                    <p>
                      Nenhuma transmissão
                    </p>

                  </div>

                )}

              </div>

              {/* =================================================
                  CONTROLES
              ================================================= */}

              <div className="controls">

                {!sharing ? (

                  <button
                    className="share-button"
                    onClick={
                      startSharing
                    }
                  >
                    🖥️ Compartilhar tela
                  </button>

                ) : (

                  <button
                    className="stop-button"
                    onClick={
                      stopSharing
                    }
                  >
                    ■ Parar transmissão
                  </button>

                )}

                <div className="limit-info">

                  <span>
                    Transmissões ativas
                  </span>

                  <strong>
                    {displayProducers.length}
                    /{MAX_PRODUCERS}
                  </strong>

                </div>

              </div>

              {error && (
                <div className="error">
                  {error}
                </div>
              )}

            </aside>

          </div>

        </section>

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
