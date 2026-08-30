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

const RETRY_DELAY = 1500;
const MAX_NEGOTIATION_RETRIES = 5;

let discordSdk = null;

/* =========================================================
   TURN
========================================================= */

async function getIceServers() {

  try {

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
   * producerId -> HTMLVideoElement
   */
  const videoRefs =
    useRef(new Map());

  /*
   * local->viewerId
   * producerId->local
   */
  const peerConnections =
    useRef(new Map());

  /*
   * PeerConnection -> ICE pendente
   */
  const pendingCandidates =
    useRef(new Map());

  /*
   * producerId que estamos tentando
   * assistir.
   */
  const requestedOffers =
    useRef(new Set());

  /*
   * Quantidade de tentativas por produtor.
   */
  const negotiationRetries =
    useRef(new Map());

  /*
   * Timers de retry.
   */
  const retryTimers =
    useRef(new Map());

  /*
   * Evita que duas negociações do
   * mesmo produtor aconteçam simultaneamente.
   */
  const negotiatingProducers =
    useRef(new Set());

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

        try {
          ws.current.close();
        } catch {}
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

        setError("");

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
              String(
                msg.id || ""
              );

            console.log(
              "Meu ID:",
              myId.current
            );

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
                msg.roomId || ""
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

            resetNegotiationState();

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
                msg.roomId || ""
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

            resetNegotiationState();

            setProducers(
              []
            );

            setSelectedProducer(
              "local"
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

            const remoteList =
              list.filter(
                producerId =>
                  producerId &&
                  producerId !==
                    myId.current
              );

            const limitedList =
              remoteList.slice(
                0,
                MAX_PRODUCERS
              );

            console.log(
              "PRODUTORES REMOTOS:",
              limitedList
            );

            /*
             * Mantém a lista.
             */
            setProducers(
              limitedList
            );

            /*
             * Se a transmissão selecionada
             * não existe mais, troca.
             */
            setSelectedProducer(
              current => {

                if (
                  current ===
                  "local"
                ) {

                  return current;
                }

                if (
                  limitedList.includes(
                    current
                  )
                ) {

                  return current;
                }

                return (
                  limitedList[0] ||
                  "local"
                );
              }
            );

            /*
             * IMPORTANTE:
             *
             * Tenta assistir todas as
             * transmissões remotas.
             *
             * Se já existe conexão,
             * requestOffer não recria.
             */
            for (
              const producerId
              of limitedList
            ) {

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
              String(
                msg.producerId ||
                ""
              );

            if (!producerId) {
              return;
            }

            if (
              producerId ===
              myId.current
            ) {

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
             * Nova tentativa.
             */
            requestOffer(
              producerId,
              true
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

            const producerId =
              String(
                msg.producerId ||
                ""
              );

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
        socketError => {

          console.error(
            "WebSocket:",
            socketError
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
     RESET NEGOTIATION
  ========================================================= */

  function resetNegotiationState() {

    requestedOffers.current.clear();

    negotiationRetries.current.clear();

    for (
      const timer
      of retryTimers.current.values()
    ) {

      clearTimeout(
        timer
      );
    }

    retryTimers.current.clear();

    negotiatingProducers.current.clear();
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

      return false;
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

    return true;
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

    resetNegotiationState();

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

            /*
             * O navegador mostra a opção
             * de compartilhar áudio quando
             * a fonte selecionada suporta isso.
             */
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

      setAudioStates(
        current => ({
          ...current,
          local: false
        })
      );

      const localVideo =
        videoRefs.current.get(
          "local"
        );

      if (localVideo) {

        localVideo.srcObject =
          stream;

        localVideo.muted =
          true;

        localVideo.play()
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

            if (
              localStream.current
            ) {

              stopSharing();
            }
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
       * Registra no servidor somente
       * depois que a captura deu certo.
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
     * Fecha todas as conexões
     * nas quais somos produtores.
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

        pendingCandidates.current.delete(
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

    const localVideo =
      videoRefs.current.get(
        "local"
      );

    if (localVideo) {

      localVideo.srcObject =
        null;
    }

    setSharing(
      false
    );

    setAudioStates(
      current => {

        const next = {
          ...current
        };

        delete next.local;

        return next;
      }
    );

    setSelectedProducer(
      current => {

        if (
          current ===
          "local"
        ) {

          return (
            producers[0] ||
            "local"
          );
        }

        return current;
      }
    );

    setStatus(
      "Servidor conectado"
    );
  }

  /* =========================================================
     REQUEST OFFER
  ========================================================= */

  function requestOffer(
    producerId,
    force = false
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

    const key =
      `${producerId}->local`;

    const existing =
      peerConnections.current.get(
        key
      );

    /*
     * Se já existe uma conexão funcional,
     * não precisamos pedir novamente.
     */
    if (
      existing &&
      (
        existing.connectionState ===
          "connected" ||
        existing.connectionState ===
          "connecting"
      ) &&
      existing.signalingState !==
        "closed"
    ) {

      return;
    }

    /*
     * Se está em negociação e não foi
     * pedido explicitamente um retry,
     * não duplica.
     */
    if (
      negotiatingProducers.current.has(
        producerId
      ) &&
      !force
    ) {

      return;
    }

    /*
     * Se já pedimos e ainda não houve
     * falha, não duplica.
     */
    if (
      requestedOffers.current.has(
        producerId
      ) &&
      !force
    ) {

      return;
    }

    /*
     * Se for retry, permite novamente.
     */
    requestedOffers.current.add(
      producerId
    );

    negotiatingProducers.current.add(
      producerId
    );

    console.log(
      "Pedindo transmissão:",
      producerId,
      force
        ? "(retry)"
        : ""
    );

    const sent =
      send({
        type:
          "request-offer",

        producerId
      });

    if (!sent) {

      negotiatingProducers.current.delete(
        producerId
      );
    }
  }

  /* =========================================================
     RETRY VIEWER
  ========================================================= */

  function scheduleViewerRetry(
    producerId
  ) {

    if (!producerId) {
      return;
    }

    /*
     * Se já existe uma conexão boa,
     * não faz retry.
     */
    const key =
      `${producerId}->local`;

    const pc =
      peerConnections.current.get(
        key
      );

    if (
      pc &&
      (
        pc.connectionState ===
          "connected" ||
        pc.connectionState ===
          "connecting"
      ) &&
      pc.signalingState !==
        "closed"
    ) {

      return;
    }

    const attempts =
      negotiationRetries.current.get(
        producerId
      ) || 0;

    if (
      attempts >=
      MAX_NEGOTIATION_RETRIES
    ) {

      console.warn(
        "Máximo de retries atingido:",
        producerId
      );

      negotiatingProducers.current.delete(
        producerId
      );

      return;
    }

    /*
     * Incrementa tentativas.
     */
    negotiationRetries.current.set(
      producerId,
      attempts + 1
    );

    /*
     * Remove conexão antiga.
     */
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

    requestedOffers.current.delete(
      producerId
    );

    negotiatingProducers.current.delete(
      producerId
    );

    /*
     * Evita múltiplos timers.
     */
    if (
      retryTimers.current.has(
        producerId
      )
    ) {

      return;
    }

    console.log(
      `Agendando retry ${attempts + 1}/${MAX_NEGOTIATION_RETRIES}:`,
      producerId
    );

    const timer =
      setTimeout(
        () => {

          retryTimers.current.delete(
            producerId
          );

          requestOffer(
            producerId,
            true
          );

        },
        RETRY_DELAY
      );

    retryTimers.current.set(
      producerId,
      timer
    );
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

    const existing =
      peerConnections.current.get(
        key
      );

    /*
     * Só reutiliza conexão realmente
     * funcional/em andamento.
     */
    if (existing) {

      if (
        (
          existing.connectionState ===
            "connected" ||
          existing.connectionState ===
            "connecting"
        ) &&
        existing.signalingState !==
          "closed"
      ) {

        console.log(
          "Peer produtor já existe:",
          key
        );

        return;
      }

      try {
        existing.close();
      } catch {}

      peerConnections.current.delete(
        key
      );

      pendingCandidates.current.delete(
        key
      );
    }

    const iceServers =
      await getIceServers();

    /*
     * O usuário pode ter parado
     * de transmitir enquanto aguardava TURN.
     */
    if (
      !localStream.current
    ) {

      return;
    }

    const pc =
      new RTCPeerConnection({
        iceServers
      });

    peerConnections.current.set(
      key,
      pc
    );

    /*
     * Adiciona todos os tracks atuais.
     */
    for (
      const track
      of localStream.current.getTracks()
    ) {

      try {

        pc.addTrack(
          track,
          localStream.current
        );

      } catch (error) {

        console.warn(
          "Erro adicionando track:",
          error
        );
      }
    }

    pc.onicecandidate =
      ({ candidate }) => {

        if (!candidate) {
          return;
        }

        /*
         * Não manda ICE de uma
         * conexão que já morreu.
         */
        if (
          pc.signalingState ===
          "closed"
        ) {

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
          pc.connectionState,
          pc.signalingState
        );

        if (
          pc.connectionState ===
            "connected"
        ) {

          /*
           * Conexão funcionando.
           */
          return;
        }

        if (
          pc.connectionState ===
            "failed" ||
          pc.connectionState ===
            "closed"
        ) {

          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }

          pendingCandidates.current.delete(
            key
          );
        }

        /*
         * disconnected pode se recuperar,
         * então não fecha imediatamente.
         */
      };

    pc.oniceconnectionstatechange =
      () => {

        console.log(
          "PRODUTOR ICE",
          viewerId,
          pc.iceConnectionState
        );

        if (
          pc.iceConnectionState ===
            "failed"
        ) {

          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }

          pendingCandidates.current.delete(
            key
          );
        }
      };

    try {

      const offer =
        await pc.createOffer();

      /*
       * A conexão pode ter sido
       * fechada enquanto criava offer.
       */
      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      await pc.setLocalDescription(
        offer
      );

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

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

      try {
        pc.close();
      } catch {}

      if (
        peerConnections.current.get(
          key
        ) === pc
      ) {

        peerConnections.current.delete(
          key
        );
      }

      pendingCandidates.current.delete(
        key
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
      String(
        msg.producerId ||
        msg.from ||
        ""
      );

    const producerFrom =
      String(
        msg.from ||
        ""
      );

    if (
      !producerId ||
      !producerFrom
    ) {

      return;
    }

    if (
      producerId ===
      myId.current
    ) {

      return;
    }

    const key =
      `${producerId}->local`;

    console.log(
      "OFFER recebida:",
      producerId
    );

    /*
     * A partir daqui a negociação
     * realmente começou.
     */
    negotiatingProducers.current.add(
      producerId
    );

    /*
     * Se existe uma conexão antiga,
     * fecha e substitui.
     *
     * Isso é importante quando houve
     * uma negociação quebrada.
     */
    const old =
      peerConnections.current.get(
        key
      );

    if (old) {

      /*
       * Se ela já está conectada,
       * não substitui.
       */
      if (
        old.connectionState ===
          "connected" &&
        old.signalingState !==
          "closed"
      ) {

        negotiatingProducers.current.delete(
          producerId
        );

        return;
      }

      try {
        old.close();
      } catch {}

      if (
        peerConnections.current.get(
          key
        ) === old
      ) {

        peerConnections.current.delete(
          key
        );
      }
    }

    pendingCandidates.current.delete(
      key
    );

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
         * Não duplica tracks.
         */
        const exists =
          stream
            .getTracks()
            .some(
              track =>
                track.id ===
                event.track.id
            );

        if (!exists) {

          stream.addTrack(
            event.track
          );
        }

        /*
         * Atualiza a lista imediatamente.
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

        /*
         * Espera o React montar o vídeo.
         */
        const attachVideo =
          (
            attempts = 0
          ) => {

            const video =
              videoRefs.current.get(
                producerId
              );

            if (!video) {

              if (
                attempts >=
                100
              ) {

                console.warn(
                  "Vídeo remoto não encontrado:",
                  producerId
                );

                return;
              }

              setTimeout(
                () =>
                  attachVideo(
                    attempts + 1
                  ),
                50
              );

              return;
            }

            if (
              video.srcObject !==
              stream
            ) {

              video.srcObject =
                stream;
            }

            video.playsInline =
              true;

            video.autoplay =
              true;

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
                    "Autoplay:",
                    error
                  );
                }
              );
          };

        attachVideo();
      };

    pc.onicecandidate =
      ({ candidate }) => {

        if (!candidate) {
          return;
        }

        if (
          pc.signalingState ===
          "closed"
        ) {

          return;
        }

        send({
          type:
            "ice",

          target:
            producerFrom,

          producerId,

          candidate
        });
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "VIEWER",
          producerId,
          pc.connectionState,
          pc.signalingState
        );

        if (
          pc.connectionState ===
            "connected"
        ) {

          /*
           * SUCESSO!
           *
           * Zera os retries.
           */
          negotiationRetries.current.delete(
            producerId
          );

          requestedOffers.current.add(
            producerId
          );

          negotiatingProducers.current.delete(
            producerId
          );

          const timer =
            retryTimers.current.get(
              producerId
            );

          if (timer) {

            clearTimeout(
              timer
            );

            retryTimers.current.delete(
              producerId
            );
          }

          setStatus(
            "Transmissão conectada"
          );

          return;
        }

        if (
          pc.connectionState ===
            "failed"
        ) {

          console.warn(
            "WebRTC falhou:",
            producerId
          );

          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }

          pendingCandidates.current.delete(
            key
          );

          negotiatingProducers.current.delete(
            producerId
          );

          /*
           * IMPORTANTE:
           *
           * Permite uma nova request-offer.
           */
          requestedOffers.current.delete(
            producerId
          );

          scheduleViewerRetry(
            producerId
          );
        }

        if (
          pc.connectionState ===
            "closed"
        ) {

          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }

          pendingCandidates.current.delete(
            key
          );

          negotiatingProducers.current.delete(
            producerId
          );
        }
      };

    pc.oniceconnectionstatechange =
      () => {

        console.log(
          "VIEWER ICE",
          producerId,
          pc.iceConnectionState
        );

        if (
          pc.iceConnectionState ===
            "failed"
        ) {

          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }

          pendingCandidates.current.delete(
            key
          );

          requestedOffers.current.delete(
            producerId
          );

          negotiatingProducers.current.delete(
            producerId
          );

          scheduleViewerRetry(
            producerId
          );
        }
      };

    try {

      await pc.setRemoteDescription(
        msg.offer
      );

      /*
       * Agora podemos adicionar os
       * ICE que chegaram antes.
       */
      await flushPendingCandidates(
        key
      );

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      send({
        type:
          "answer",

        target:
          producerFrom,

        producerId,

        answer:
          pc.localDescription
      });

    } catch (error) {

      console.error(
        "Erro processando offer:",
        error
      );

      try {
        pc.close();
      } catch {}

      if (
        peerConnections.current.get(
          key
        ) === pc
      ) {

        peerConnections.current.delete(
          key
        );
      }

      pendingCandidates.current.delete(
        key
      );

      requestedOffers.current.delete(
        producerId
      );

      negotiatingProducers.current.delete(
        producerId
      );

      /*
       * Tenta novamente.
       */
      scheduleViewerRetry(
        producerId
      );
    }
  }

  /* =========================================================
     HANDLE ANSWER
  ========================================================= */

  async function handleAnswer(
    msg
  ) {

    const viewerId =
      String(
        msg.from ||
        ""
      );

    if (!viewerId) {
      return;
    }

    const key =
      `local->${viewerId}`;

    const pc =
      peerConnections.current.get(
        key
      );

    if (!pc) {

      console.warn(
        "Peer produtor não encontrado:",
        key
      );

      return;
    }

    if (
      pc.signalingState ===
      "closed"
    ) {

      return;
    }

    try {

      /*
       * Answer somente é válida
       * depois de have-local-offer.
       */
      if (
        pc.signalingState !==
        "have-local-offer"
      ) {

        console.warn(
          "Estado inesperado para answer:",
          key,
          pc.signalingState
        );

        return;
      }

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

      try {
        pc.close();
      } catch {}

      if (
        peerConnections.current.get(
          key
        ) === pc
      ) {

        peerConnections.current.delete(
          key
        );
      }

      pendingCandidates.current.delete(
        key
      );
    }
  }

  /* =========================================================
     ICE
  ========================================================= */

  async function handleIceCandidate(
    msg
  ) {

    if (
      !msg.candidate
    ) {

      return;
    }

    const producerId =
      String(
        msg.producerId ||
        ""
      );

    const from =
      String(
        msg.from ||
        ""
      );

    if (
      !producerId ||
      !from
    ) {

      return;
    }

    /*
     * Nós somos viewer:
     *
     * producer -> local
     */
    const viewerKey =
      `${producerId}->local`;

    /*
     * Nós somos produtor:
     *
     * local -> viewer
     */
    const producerKey =
      `local->${from}`;

    let key =
      null;

    let pc =
      null;

    /*
     * Primeiro tenta encontrar
     * nossa conexão de viewer.
     */
    if (
      peerConnections.current.has(
        viewerKey
      )
    ) {

      key =
        viewerKey;

      pc =
        peerConnections.current.get(
          viewerKey
        );
    }

    /*
     * Depois tenta conexão de produtor.
     */
    else if (
      peerConnections.current.has(
        producerKey
      )
    ) {

      key =
        producerKey;

      pc =
        peerConnections.current.get(
          producerKey
        );
    }

    /*
     * Ainda não existe PeerConnection.
     *
     * Guarda ICE.
     */
    if (!pc) {

      /*
       * Determina o lado correto.
       *
       * Se a origem é um produtor remoto,
       * nós somos viewer.
       *
       * Caso contrário, somos produtor.
       */
      key =
        key ||
        (
          producerId !==
          myId.current
            ? viewerKey
            : producerKey
        );

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

    /*
     * Conexão fechada.
     */
    if (
      pc.signalingState ===
        "closed" ||
      pc.connectionState ===
        "closed"
    ) {

      console.warn(
        "ICE ignorado: conexão fechada.",
        key
      );

      return;
    }

    /*
     * Ainda não temos descrição remota.
     */
    if (
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

      if (
        error?.name ===
        "InvalidStateError"
      ) {

        console.warn(
          "ICE ignorado: PeerConnection fechada.",
          key
        );

        return;
      }

      console.warn(
        "Erro ICE:",
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

    if (!pc) {
      return;
    }

    if (
      pc.signalingState ===
      "closed"
    ) {

      return;
    }

    if (
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

    pendingCandidates.current.delete(
      key
    );

    for (
      const candidate
      of candidates
    ) {

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      try {

        await pc.addIceCandidate(
          candidate
        );

      } catch (error) {

        if (
          error?.name ===
          "InvalidStateError"
        ) {

          continue;
        }

        console.warn(
          "Erro ICE pendente:",
          error
        );
      }
    }
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

    requestedOffers.current.delete(
      producerId
    );

    negotiatingProducers.current.delete(
      producerId
    );

    negotiationRetries.current.delete(
      producerId
    );

    const timer =
      retryTimers.current.get(
        producerId
      );

    if (timer) {

      clearTimeout(
        timer
      );

      retryTimers.current.delete(
        producerId
      );
    }

    /*
     * Fecha PeerConnection.
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
     * Se estava selecionado,
     * seleciona outro.
     */
    setSelectedProducer(
      current => {

        if (
          current !==
          producerId
        ) {

          return current;
        }

        return (
          producers.find(
            id =>
              id !==
              producerId
          ) ||
          "local"
        );
      }
    );

    /*
     * Remove áudio.
     */
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

    if (!video) {
      return;
    }

    video.muted =
      !next;

    video.volume =
      1;

    if (next) {

      video.play()
        .catch(
          () => {}
        );
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

        const video =
          videoRefs.current.get(
            producerId
          );

        if (!video) {
          return;
        }

        if (
          producerId ===
          "local"
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

        video.volume =
          1;

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

    /*
     * Cancela retries.
     */
    for (
      const timer
      of retryTimers.current.values()
    ) {

      clearTimeout(
        timer
      );
    }

    retryTimers.current.clear();

    negotiationRetries.current.clear();

    negotiatingProducers.current.clear();

    /*
     * Stream local.
     */
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

    /*
     * Streams remotos.
     */
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

    /*
     * PeerConnections.
     */
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

    requestedOffers.current.clear();

    /*
     * Limpa vídeos.
     */
    for (
      const video
      of videoRefs.current.values()
    ) {

      try {

        video.srcObject =
          null;

      } catch {}
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
     VIDEO REF
  ========================================================= */

  function setVideoRef(
    producerId,
    element
  ) {

    if (!element) {
      return;
    }

    videoRefs.current.set(
      producerId,
      element
    );

    /*
     * Stream existente.
     */
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

    /*
     * Local sempre mutado.
     */
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

    element.volume =
      1;
  }

  /* =========================================================
     DERIVADOS
  ========================================================= */

  const displayProducers = [
    ...(sharing
      ? ["local"]
      : []),
    ...producers
  ].slice(
    0,
    MAX_PRODUCERS
  );

  const hasStreams =
    displayProducers.length >
    0;

  const mainProducer =
    selectedProducer ===
      "local" &&
    !sharing
      ? (
          producers[0] ||
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
                      "local";

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
                            producerId
                          )
                        }
                      >

                        <div className="thumb-video">

                          <video
                            ref={
                              element =>
                                setVideoRef(
                                  producerId,
                                  element
                                )
                            }
                            autoPlay
                            muted={
                              isLocal
                                ? true
                                : !(
                                    audioStates[
                                      producerId
                                    ] ?? false
                                  )
                            }
                            playsInline
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
                                  producerId
                                );
                              }
                            }
                          >
                            {
                              audioStates[
                                producerId
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