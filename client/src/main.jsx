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

    const response =
      await fetch(
        `${TURN_SERVER_URL}/turn-credentials`,
        {
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

    console.log(
      "[TURN] resposta:",
      data
    );

    if (
      !data ||
      !Array.isArray(data.iceServers)
    ) {

      throw new Error(
        "Resposta TURN inválida."
      );
    }

    return data.iceServers;

  } catch (error) {

    console.warn(
      "[TURN] indisponível:",
      error
    );

    /*
     * STUN como fallback.
     */
    return [
      {
        urls: "stun:stun.cloudflare.com:3478"
      },
      {
        urls: "stun:stun.l.google.com:19302"
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
   * producerId -> Set<HTMLVideoElement>
   */
  const videoRefs =
    useRef(new Map());

  /*
   * local->viewer
   * producer->local
   */
  const peerConnections =
    useRef(new Map());

  /*
   * peerKey -> ICE candidates
   */
  const pendingCandidates =
    useRef(new Map());

  /*
   * Evita request-offer duplicado.
   */
  const requestedOffers =
    useRef(new Set());

  const roomId =
    useRef("");

  const myId =
    useRef("");

  /* =======================================================
     VIDEO
  ======================================================= */

  function registerVideo(
    producerId,
    element
  ) {

    if (!element) {
      return;
    }

    let set =
      videoRefs.current.get(
        producerId
      );

    if (!set) {

      set =
        new Set();

      videoRefs.current.set(
        producerId,
        set
      );
    }

    set.add(element);

    element.autoplay = true;
    element.playsInline = true;

    const stream =
      streams.current.get(
        producerId
      );

    if (stream) {

      element.srcObject =
        stream;

      if (
        producerId === "local"
      ) {

        element.muted = true;

      } else {

        element.muted =
          !(
            audioStates[
              producerId
            ] ?? false
          );
      }

      element.volume = 1;

      element.play()
        .catch(
          error => {

            console.warn(
              "[VIDEO] autoplay bloqueado:",
              error
            );
          }
        );
    }
  }

  function unregisterVideo(
    producerId,
    element
  ) {

    if (!element) {
      return;
    }

    const set =
      videoRefs.current.get(
        producerId
      );

    if (!set) {
      return;
    }

    set.delete(element);

    if (set.size === 0) {

      videoRefs.current.delete(
        producerId
      );
    }
  }

  function attachStream(
    producerId,
    stream
  ) {

    if (!stream) {
      return;
    }

    streams.current.set(
      producerId,
      stream
    );

    const videos =
      videoRefs.current.get(
        producerId
      );

    if (!videos) {

      console.log(
        "[VIDEO] ainda não existe elemento para:",
        producerId
      );

      return;
    }

    for (
      const video
      of videos
    ) {

      if (!video) {
        continue;
      }

      video.srcObject =
        stream;

      video.autoplay =
        true;

      video.playsInline =
        true;

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

      video.volume = 1;

      video.play()
        .then(
          () => {

            console.log(
              "[VIDEO] reproduzindo:",
              producerId
            );
          }
        )
        .catch(
          error => {

            console.warn(
              "[VIDEO] play falhou:",
              error
            );
          }
        );
    }
  }

  function createVideoRef(
    producerId
  ) {

    return element => {

      if (element) {

        registerVideo(
          producerId,
          element
        );

      }
    };
  }

  /* =======================================================
     DISCORD
  ======================================================= */

  useEffect(() => {

    let alive = true;

    async function setup() {

      if (!CLIENT_ID) {

        console.warn(
          "[DISCORD] CLIENT_ID não definido."
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

        setDiscordReady(
          true
        );

        setStatus(
          "Conectado ao Discord"
        );

        console.log(
          "[DISCORD] SDK pronto"
        );

      } catch (error) {

        console.warn(
          "[DISCORD] SDK:",
          error
        );

        setStatus(
          "Modo navegador"
        );
      }

      connectSignal();
    }

    setup();

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

  /* =======================================================
     WEBSOCKET
  ======================================================= */

  function connectSignal() {

    console.log(
      "[WS] conectando:",
      SIGNALING_URL
    );

    const socket =
      new WebSocket(
        SIGNALING_URL
      );

    ws.current =
      socket;

    socket.onopen =
      () => {

        console.log(
          "[WS] conectado"
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
            "[WS] JSON inválido:",
            event.data
          );

          return;
        }

        console.log(
          "[SERVER]",
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
            "[ID] meu ID:",
            myId.current
          );

          return;
        }

        /* =================================================
           ROOM CREATED
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

          setProducers(
            []
          );

          setSelectedProducer(
            "local"
          );

          requestedOffers.current.clear();

          setError("");

          setStatus(
            "Sala criada"
          );

          return;
        }

        /* =================================================
           ROOM JOINED
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

          setProducers(
            []
          );

          setSelectedProducer(
            "local"
          );

          requestedOffers.current.clear();

          setError("");

          setStatus(
            "Você entrou na sala"
          );

          return;
        }

        /* =================================================
           PRODUCER LIST
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

          const remote =
            list
              .map(
                id =>
                  String(id)
              )
              .filter(
                id =>
                  id &&
                  id !==
                    myId.current
              )
              .slice(
                0,
                MAX_PRODUCERS
              );

          console.log(
            "[PRODUCERS]",
            remote
          );

          setProducers(
            remote
          );

          setSelectedProducer(
            current => {

              if (
                current !==
                "local" &&
                remote.includes(
                  current
                )
              ) {

                return current;
              }

              return (
                current === "local"
                  ? current
                  : (
                      remote[0] ||
                      "local"
                    )
              );
            }
          );

          /*
           * Pequeno atraso para evitar
           * corrida de renderização.
           */
          setTimeout(
            () => {

              for (
                const producerId
                of remote
              ) {

                requestOffer(
                  producerId
                );
              }

            },
            50
          );

          return;
        }

        /* =================================================
           NEW PRODUCER
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

          if (
            !producerId ||
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

          requestOffer(
            producerId
          );

          return;
        }

        /* =================================================
           PRODUCER LEFT
        ================================================= */

        if (
          msg.type ===
          "producer-left"
        ) {

          removeRemoteProducer(
            String(
              msg.producerId ||
              ""
            )
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
           ERROR
        ================================================= */

        if (
          msg.type ===
          "error"
        ) {

          console.error(
            "[SERVER ERROR]",
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

          console.log(
            "[SIGNAL] request-offer de:",
            msg.viewerId
          );

          if (
            localStream.current
          ) {

            await createProducerPeer(
              String(
                msg.viewerId ||
                ""
              )
            );

          } else {

            console.warn(
              "[SIGNAL] request-offer chegou sem stream local."
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
          "[WS ERROR]",
          error
        );

        setError(
          "Erro de conexão com o servidor."
        );
      };

    socket.onclose =
      event => {

        console.warn(
          "[WS CLOSED]",
          event.code,
          event.reason
        );

        setStatus(
          "Servidor desconectado"
        );
      };
  }

  /* =======================================================
     SEND
  ======================================================= */

  function send(
    message
  ) {

    if (
      !ws.current ||
      ws.current.readyState !==
        WebSocket.OPEN
    ) {

      console.warn(
        "[SEND] WebSocket não conectado:",
        message
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
      "[SEND]",
      payload
    );

    ws.current.send(
      JSON.stringify(
        payload
      )
    );

    return true;
  }

  /* =======================================================
     CREATE ROOM
  ======================================================= */

  function createRoom() {

    setError("");

    send({
      type:
        "create-room"
    });
  }

  /* =======================================================
     JOIN
  ======================================================= */

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

  /* =======================================================
     LEAVE
  ======================================================= */

  function leaveRoom() {

    send({
      type:
        "leave-room"
    });

    cleanupStreams();

    roomId.current =
      "";

    requestedOffers.current.clear();

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

  /* =======================================================
     START SHARING
  ======================================================= */

  async function startSharing() {

    setError("");

    if (!inRoom) {

      setError(
        "Entre em uma sala primeiro."
      );

      return;
    }

    if (sharing) {
      return;
    }

    if (
      producers.length >=
      MAX_PRODUCERS
    ) {

      setError(
        "A sala já possui 3 transmissões."
      );

      return;
    }

    try {

      console.log(
        "[SCREEN] solicitando captura..."
      );

      const stream =
        await navigator.mediaDevices
          .getDisplayMedia({
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
          });

      console.log(
        "[SCREEN] stream:",
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

      attachStream(
        "local",
        stream
      );

      const videoTrack =
        stream.getVideoTracks()[0];

      if (videoTrack) {

        videoTrack.onended =
          () => {

            console.log(
              "[SCREEN] captura encerrada."
            );

            stopSharing();
          };
      }

      console.log(
        "[SCREEN] vídeo:",
        stream.getVideoTracks().length
      );

      console.log(
        "[SCREEN] áudio:",
        stream.getAudioTracks().length
      );

      setSharing(
        true
      );

      setSelectedProducer(
        "local"
      );

      /*
       * PRIMEIRO registra o produtor
       * no servidor.
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
        "[SCREEN ERROR]",
        error
      );

      if (
        error?.name ===
        "NotAllowedError"
      ) {

        return;
      }

      setError(
        error?.message ||
        "Não foi possível capturar a tela."
      );
    }
  }

  /* =======================================================
     STOP SHARING
  ======================================================= */

  function stopSharing() {

    console.log(
      "[SCREEN] parando..."
    );

    if (
      localStream.current
    ) {

      for (
        const track
        of localStream.current.getTracks()
      ) {

        try {
          track.stop();
        } catch {}
      }
    }

    localStream.current =
      null;

    streams.current.delete(
      "local"
    );

    /*
     * Fecha conexões de produtor.
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

    send({
      type:
        "stop-sharing"
    });

    const videos =
      videoRefs.current.get(
        "local"
      );

    if (videos) {

      for (
        const video
        of videos
      ) {

        try {
          video.srcObject =
            null;
        } catch {}
      }
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
      producers[0] ||
      "local"
    );

    setStatus(
      "Servidor conectado"
    );
  }

  /* =======================================================
     REQUEST OFFER
  ======================================================= */

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

    if (
      requestedOffers.current.has(
        producerId
      )
    ) {

      return;
    }

    requestedOffers.current.add(
      producerId
    );

    console.log(
      "[SIGNAL] pedindo offer:",
      producerId
    );

    send({
      type:
        "request-offer",

      producerId
    });
  }

  /* =======================================================
     CREATE PRODUCER PEER
  ======================================================= */

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
     * Se existe uma conexão realmente ativa,
     * não cria outra.
     */
    const old =
      peerConnections.current.get(
        key
      );

    if (old) {

      const state =
        old.connectionState;

      if (
        state === "connected" ||
        state === "connecting"
      ) {

        console.log(
          "[PRODUCER] conexão já ativa:",
          key
        );

        return;
      }

      try {
        old.close();
      } catch {}

      peerConnections.current.delete(
        key
      );
    }

    console.log(
      "[PRODUCER] criando peer:",
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
     * Adiciona todas as tracks.
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
      event => {

        if (
          !event.candidate
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

          candidate:
            event.candidate
        });
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "[PRODUCER STATE]",
          key,
          pc.connectionState
        );

        if (
          pc.connectionState ===
            "failed" ||
          pc.connectionState ===
            "closed" ||
          pc.connectionState ===
            "disconnected"
        ) {

          /*
           * Só remove se ainda for
           * a mesma conexão.
           */
          if (
            peerConnections.current.get(
              key
            ) === pc
          ) {

            peerConnections.current.delete(
              key
            );
          }
        }
      };

    try {

      const offer =
        await pc.createOffer();

      await pc.setLocalDescription(
        offer
      );

      console.log(
        "[PRODUCER] enviando offer:",
        viewerId
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
        "[PRODUCER] erro offer:",
        error
      );

      try {
        pc.close();
      } catch {}

      peerConnections.current.delete(
        key
      );
    }
  }

  /* =======================================================
     HANDLE OFFER
  ======================================================= */

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

      console.error(
        "[VIEWER] offer inválida:",
        msg
      );

      return;
    }

    const key =
      `${producerId}->local`;

    console.log(
      "[VIEWER] recebendo offer:",
      key
    );

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

    pc.ontrack =
      event => {

        console.log(
          "[VIEWER] TRACK:",
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
         * Adiciona track.
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

        console.log(
          "[VIEWER] stream tracks:",
          stream.getTracks().map(
            track =>
              track.kind
          )
        );

        attachStream(
          producerId,
          stream
        );

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
         * React pode ainda não ter
         * criado o vídeo.
         */
        setTimeout(
          () => {

            const stream =
              streams.current.get(
                producerId
              );

            if (stream) {

              attachStream(
                producerId,
                stream
              );
            }

          },
          100
        );
      };

    pc.onicecandidate =
      event => {

        if (
          !event.candidate
        ) {
          return;
        }

        send({
          type:
            "ice",

          target:
            producerFrom,

          producerId,

          candidate:
            event.candidate
        });
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "[VIEWER STATE]",
          key,
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "connected"
        ) {

          setStatus(
            "Transmissão conectada"
          );

          const stream =
            streams.current.get(
              producerId
            );

          if (stream) {

            attachStream(
              producerId,
              stream
            );
          }
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
        }
      };

    try {

      await pc.setRemoteDescription(
        msg.offer
      );

      /*
       * ICE que chegou antes da offer.
       */
      await flushPendingCandidates(
        key
      );

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      console.log(
        "[VIEWER] enviando answer:",
        producerFrom
      );

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
        "[VIEWER] erro offer:",
        error
      );

      try {
        pc.close();
      } catch {}

      peerConnections.current.delete(
        key
      );
    }
  }

  /* =======================================================
     ANSWER
  ======================================================= */

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
        "[ANSWER] peer não encontrado:",
        key
      );

      return;
    }

    try {

      if (
        pc.signalingState !==
        "have-local-offer"
      ) {

        console.warn(
          "[ANSWER] estado inválido:",
          pc.signalingState
        );

        return;
      }

      await pc.setRemoteDescription(
        msg.answer
      );

      console.log(
        "[ANSWER] aplicada:",
        key
      );

      await flushPendingCandidates(
        key
      );

    } catch (error) {

      console.error(
        "[ANSWER] erro:",
        error
      );
    }
  }

  /* =======================================================
     ICE
  ======================================================= */

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
     * Viewer recebendo ICE do produtor.
     */
    const viewerKey =
      `${producerId}->local`;

    /*
     * Produtor recebendo ICE do viewer.
     */
    const producerKey =
      `local->${from}`;

    let key = null;
    let pc = null;

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

    } else if (
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
     * Peer ainda não criado.
     */
    if (!pc) {

      /*
       * Como não sabemos ainda se somos
       * viewer ou produtor, guardamos
       * inicialmente pelo viewerKey.
       *
       * Quando o peer for criado,
       * flushPendingCandidates será chamado.
       */
      if (
        !pendingCandidates.current.has(
          viewerKey
        )
      ) {

        pendingCandidates.current.set(
          viewerKey,
          []
        );
      }

      pendingCandidates.current
        .get(viewerKey)
        .push(
          msg.candidate
        );

      /*
       * Também guarda pelo producerKey
       * para cobrir corrida do produtor.
       */
      if (
        !pendingCandidates.current.has(
          producerKey
        )
      ) {

        pendingCandidates.current.set(
          producerKey,
          []
        );
      }

      pendingCandidates.current
        .get(producerKey)
        .push(
          msg.candidate
        );

      return;
    }

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

      console.warn(
        "[ICE] erro:",
        error
      );
    }
  }

  /* =======================================================
     FLUSH ICE
  ======================================================= */

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

      try {

        await pc.addIceCandidate(
          candidate
        );

      } catch (error) {

        console.warn(
          "[ICE PENDENTE] erro:",
          error
        );
      }
    }
  }

  /* =======================================================
     REMOVE REMOTE PRODUCER
  ======================================================= */

  function removeRemoteProducer(
    producerId
  ) {

    if (!producerId) {
      return;
    }

    console.log(
      "[REMOVE PRODUCER]",
      producerId
    );

    requestedOffers.current.delete(
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

      for (
        const track
        of stream.getTracks()
      ) {

        try {
          track.stop();
        } catch {}
      }
    }

    streams.current.delete(
      producerId
    );

    const videos =
      videoRefs.current.get(
        producerId
      );

    if (videos) {

      for (
        const video
        of videos
      ) {

        try {
          video.srcObject =
            null;
        } catch {}
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
  }

  /* =======================================================
     AUDIO
  ======================================================= */

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
  }

  /* =======================================================
     SELECT
  ======================================================= */

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

        if (stream) {

          attachStream(
            producerId,
            stream
          );
        }

      },
      50
    );
  }

  /* =======================================================
     CLEANUP
  ======================================================= */

  function cleanupStreams() {

    if (
      localStream.current
    ) {

      for (
        const track
        of localStream.current.getTracks()
      ) {

        try {
          track.stop();
        } catch {}
      }
    }

    localStream.current =
      null;

    for (
      const stream
      of streams.current.values()
    ) {

      for (
        const track
        of stream.getTracks()
      ) {

        try {
          track.stop();
        } catch {}
      }
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

    requestedOffers.current.clear();

    for (
      const videos
      of videoRefs.current.values()
    ) {

      for (
        const video
        of videos
      ) {

        try {
          video.srcObject =
            null;
        } catch {}
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

    setSelectedProducer(
      "local"
    );

    setViewerCount(
      0
    );
  }

  /* =======================================================
     DERIVED
  ======================================================= */

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

  /* =======================================================
     RENDER
  ======================================================= */

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
                          createVideoRef(
                            "local"
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
                        createVideoRef(
                          mainProducer
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
                              createVideoRef(
                                producerId
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

