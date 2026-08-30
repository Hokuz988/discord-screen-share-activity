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
      !Array.isArray(
        data.iceServers
      )
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
  ] = useState(
    "Conectando..."
  );

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

  /*
   * Lista dos produtores.
   *
   * Exemplo:
   *
   * [
   *   "id1",
   *   "id2",
   *   "id3"
   * ]
   */

  const [
    producers,
    setProducers
  ] = useState([]);

  /*
   * Qual transmissão está
   * atualmente na tela grande.
   *
   * "local" = própria tela
   * "id123" = transmissão remota
   */

  const [
    selectedProducer,
    setSelectedProducer
  ] = useState("local");

  /*
   * Áudio individual de cada
   * transmissão.
   */

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
   * producerId -> video element
   */

  const videoRefs =
    useRef(new Map());

  /*
   * Chave:
   *
   * producerId:viewerId
   *
   * Cada transmissão para
   * cada espectador possui
   * sua própria PeerConnection.
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
             ID DO CLIENTE
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

            /*
             * Se a transmissão selecionada
             * não existe mais, volta para
             * a própria tela.
             */

            setSelectedProducer(
              current => {

                if (
                  current === "local"
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

                return list[0] ||
                  "local";
              }
            );

            /*
             * Solicita cada transmissão.
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

            /*
             * Não pede a própria
             * transmissão.
             */

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

            /*
             * Alguém quer assistir
             * nossa transmissão.
             */

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

    if (
      sharing
    ) {

      setError(
        "Você já está transmitindo."
      );

      return;
    }

    /*
     * O backend limita a 3.
     *
     * Se já existem 3 transmissões,
     * ainda podemos mostrar erro
     * amigável antes de pedir a tela.
     */

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

      /*
       * IMPORTANTE:
       *
       * audio: true
       *
       * pede ao navegador para
       * disponibilizar áudio da
       * tela/janela quando possível.
       *
       * O navegador pode mostrar
       * uma opção para compartilhar
       * áudio.
       */

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

      /*
       * Adiciona nossa própria
       * transmissão na lista.
       */

      setProducers(
        current => {

          if (
            myId.current &&
            !current.includes(
              myId.current
            )
          ) {

            return [
              ...current,
              myId.current
            ];
          }

          return current;
        }
      );

      /*
       * Salva stream local.
       */

      streams.current.set(
        "local",
        stream
      );

      /*
       * Áudio local começa mutado
       * para evitar eco.
       */

      setAudioStates(
        current => ({
          ...current,
          local: false
        })
      );

      /*
       * Quando o usuário clica
       * em parar compartilhamento
       * pelo navegador.
       */

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
       * Avisa o servidor.
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
     * Fecha apenas as conexões
     * nas quais nós somos produtor.
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

    /*
     * Remove nossa própria tela
     * da lista visual.
     */

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
      producers.find(
        id =>
          id !==
          myId.current
      ) ||
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

    if (
      !producerId
    ) {
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

    /*
     * Evita criar duas conexões
     * para o mesmo espectador.
     */

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
     * Adiciona vídeo E áudio.
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

    /*
     * Fecha conexão anterior
     * daquela transmissão.
     */

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
         * Evita adicionar
         * a mesma track duas vezes.
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
         * Atualiza o vídeo correspondente.
         */

        const video =
          videoRefs.current.get(
            producerId
          );

        if (
          video &&
          video.srcObject !==
          stream
        ) {

          video.srcObject =
            stream;

          video.muted =
            !(
              audioStates[
                producerId
              ] ?? false
            );

          video.volume =
            1;

          video.play()
            .catch(
              error => {
                console.warn(
                  "Autoplay bloqueado:",
                  error
                );
              }
            );
        }

        /*
         * Garante que apareça
         * na lista.
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

          setStatus(
            "Transmissão conectada"
          );
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

    /*
     * Quando somos produtor,
     * a conexão é:
     *
     * local->viewer
     */

    const key =
      `local->${msg.from}`;

    let pc =
      peerConnections.current.get(
        key
      );

    /*
     * Fallback caso o produtor
     * tenha sido enviado de
     * maneira diferente.
     */

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

    /*
     * Tenta identificar se
     * somos viewer ou produtor.
     */

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
     REMOVER TRANSMISSÃO REMOTA
  ========================================================= */

  function removeRemoteProducer(
    producerId
  ) {

    console.log(
      "Removendo transmissão:",
      producerId
    );

    /*
     * Fecha conexão.
     */

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

    /*
     * Remove candidatos.
     */

    pendingCandidates.current.delete(
      key
    );

    /*
     * Remove stream.
     */

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
     * Remove vídeo.
     */

    const video =
      videoRefs.current.get(
        producerId
      );

    if (video) {
      video.srcObject =
        null;
    }

    videoRefs.current.delete(
      producerId
    );

    /*
     * Remove da lista.
     */

    setProducers(
      current =>
        current.filter(
          id =>
            id !==
            producerId
        )
    );

    /*
     * Se estava na tela
     * principal, escolhe
     * outra transmissão.
     */

    setSelectedProducer(
      current => {

        if (
          current !==
          producerId
        ) {
          return current;
        }

        const remaining =
          producers.filter(
            id =>
              id !==
              producerId
          );

        return remaining[0] ||
          "local";
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

    const video =
      videoRefs.current.get(
        producerId
      );

    if (video) {

      video.muted =
        !next;

      video.volume =
        1;

      if (
        next
      ) {

        video.play()
          .catch(
            () => {}
          );
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

    /*
     * Tenta iniciar o vídeo
     * após uma interação do usuário.
     *
     * Isso ajuda bastante com
     * bloqueios de autoplay.
     */

    setTimeout(
      () => {

        const video =
          videoRefs.current.get(
            producerId
          );

        if (!video) {
          return;
        }

        video.muted =
          !(
            audioStates[
              producerId
            ] ?? false
          );

        video.play()
          .catch(
            () => {}
          );

      },
      50
    );
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
     VIDEO REF
  ========================================================= */

  function setVideoRef(
    producerId,
    element
  ) {

    if (element) {

      videoRefs.current.set(
        producerId,
        element
      );

      const stream =
        streams.current.get(
          producerId
        );

      if (
        stream &&
        element.srcObject !==
        stream
      ) {

        element.srcObject =
          stream;
      }

      element.muted =
        !(
          audioStates[
            producerId
          ] ?? false
        );
    }
  }

  /* =========================================================
     DERIVADOS
  ========================================================= */

  const allProducerIds =
    producers
      .filter(
        id =>
          id !==
          undefined &&
          id !==
          null
      )
      .slice(
        0,
        MAX_PRODUCERS
      );

  /*
   * Garante que a própria
   * transmissão apareça
   * quando estamos transmitindo.
   */

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

          {/* =================================================
              TOPBAR
          ================================================= */}

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

          {/* =================================================
              CONTENT
          ================================================= */}

          <div className="broadcast-layout">

            {/* =================================================
                MAIN VIDEO
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
                THUMBNAILS
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

                          {isLocal ? (

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

                            <video
                              ref={
                                element =>
                                  setVideoRef(
                                    producerId,
                                    element
                                  )
                              }
                              autoPlay
                              playsInline
                              muted={
                                !(
                                  audioStates[
                                    producerId
                                  ] ?? false
                                )
                              }
                            />

                          )}

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
                                  isLocal
                                    ? "local"
                                    : producerId
                                );
                              }
                            }
                          >
                            {
                              audioStates[
                                isLocal
                                  ? "local"
                                  : producerId
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