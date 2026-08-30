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
   * CORREÇÃO IMPORTANTE
   *
   * Antes:
   *
   * producerId -> HTMLVideoElement
   *
   * Isso fazia o vídeo principal ser
   * sobrescrito pela miniatura.
   *
   * Agora:
   *
   * producerId -> Set<HTMLVideoElement>
   *
   * Assim uma transmissão pode possuir
   * vários elementos <video> ao mesmo tempo.
   */
  const videoRefs =
    useRef(new Map());

  /*
   * local->viewerId
   *
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
   * Evita solicitar a mesma transmissão
   * várias vezes.
   */
  const requestedOffers =
    useRef(new Set());

  const roomId =
    useRef("");

  const myId =
    useRef("");

  /* =========================================================
     FUNÇÕES DE VÍDEO
  ========================================================= */

  /*
   * Anexa uma stream a TODOS os elementos
   * de vídeo daquele produtor.
   */
  function attachStreamToVideos(
    producerId,
    stream
  ) {

    if (!stream) {
      return;
    }

    const elements =
      videoRefs.current.get(
        producerId
      );

    if (!elements) {
      return;
    }

    for (
      const video
      of elements
    ) {

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

      video.playsInline =
        true;

      video.autoplay =
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

      video.volume =
        1;

      video.play()
        .catch(
          () => {}
        );
    }
  }

  /*
   * Registra um elemento de vídeo.
   *
   * Pode existir:
   *
   * - vídeo principal
   * - miniatura
   *
   * para o MESMO producerId.
   */
  function setVideoRef(
    producerId,
    element
  ) {

    /*
     * React chama o callback com null
     * quando o elemento deixa de existir.
     */
    if (!element) {
      return;
    }

    let elements =
      videoRefs.current.get(
        producerId
      );

    if (!elements) {

      elements =
        new Set();

      videoRefs.current.set(
        producerId,
        elements
      );
    }

    elements.add(
      element
    );

    /*
     * Se a stream já chegou antes
     * do React criar o vídeo,
     * conecta imediatamente.
     */
    const stream =
      streams.current.get(
        producerId
      );

    if (stream) {

      element.srcObject =
        stream;
    }

    element.playsInline =
      true;

    element.autoplay =
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

    element.volume =
      1;

    if (stream) {

      element.play()
        .catch(
          () => {}
        );
    }
  }

  /*
   * Remove um elemento específico
   * do conjunto de vídeos.
   */
  function removeVideoRef(
    producerId,
    element
  ) {

    if (!element) {
      return;
    }

    const elements =
      videoRefs.current.get(
        producerId
      );

    if (!elements) {
      return;
    }

    elements.delete(
      element
    );

    if (
      elements.size ===
      0
    ) {

      videoRefs.current.delete(
        producerId
      );
    }
  }

  /*
   * Cria um callback de ref estável
   * para cada elemento.
   *
   * IMPORTANTE:
   * cada <video> recebe seu próprio
   * callback, mas todos podem apontar
   * para o mesmo producerId.
   */
  function createVideoRef(
    producerId
  ) {

    return element => {

      if (element) {

        setVideoRef(
          producerId,
          element
        );

      }
    };
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

        setDiscordReady(
          true
        );

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

      if (
        ws.current
      ) {

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

            requestedOffers.current.clear();

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

            requestedOffers.current.clear();

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

            setProducers(
              limitedList
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
             * Solicita todas as transmissões
             * que ainda não foram solicitadas.
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

            requestOffer(
              producerId
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

  function send(
    message
  ) {

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

    requestedOffers.current.clear();

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

      /*
       * O navegador exibirá as opções
       * disponíveis de captura.
       *
       * IMPORTANTE:
       * o site NÃO consegue selecionar
       * programaticamente "todos os sons
       * menos Discord".
       *
       * Isso depende da fonte escolhida
       * no seletor do navegador/Windows.
       */
      const stream =
        await navigator.mediaDevices
          .getDisplayMedia(
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

      setAudioStates(
        current => ({
          ...current,
          local: false
        })
      );

      /*
       * Conecta a stream a TODOS
       * os vídeos locais.
       */
      attachStreamToVideos(
        "local",
        stream
      );

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

      /*
       * Caso o navegador disponibilize
       * uma faixa de áudio.
       */
      const audioTracks =
        stream.getAudioTracks();

      console.log(
        "Áudio capturado:",
        audioTracks.length
      );

      setSharing(
        true
      );

      setSelectedProducer(
        "local"
      );

      /*
       * REGISTRA NO SERVIDOR SOMENTE
       * UMA VEZ.
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
     * Fecha somente conexões onde
     * nós somos produtores.
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

    /*
     * Limpa todos os vídeos locais.
     */
    const localVideos =
      videoRefs.current.get(
        "local"
      );

    if (localVideos) {

      for (
        const video
        of localVideos
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

      console.log(
        "Offer já solicitada:",
        producerId
      );

      return;
    }

    requestedOffers.current.add(
      producerId
    );

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

    const existing =
      peerConnections.current.get(
        key
      );

    if (existing) {

      if (
        existing.connectionState ===
          "connected" ||
        existing.connectionState ===
          "connecting" ||
        existing.connectionState ===
          "new" ||
        existing.signalingState !==
          "closed"
      ) {

        console.log(
          "Peer já existe:",
          key
        );

        return;
      }
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
            "failed" ||
          pc.connectionState ===
            "closed"
        ) {

          peerConnections.current.delete(
            key
          );

          pendingCandidates.current.delete(
            key
          );
        }
      };

    try {

      const offer =
        await pc.createOffer();

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

      peerConnections.current.delete(
        key
      );

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

    const key =
      `${producerId}->local`;

    console.log(
      "OFFER recebida:",
      producerId
    );

    /*
     * Se já existe uma conexão válida,
     * não cria outra.
     */
    const old =
      peerConnections.current.get(
        key
      );

    if (old) {

      if (
        old.signalingState !==
          "closed" &&
        (
          old.connectionState ===
            "connected" ||
          old.connectionState ===
            "connecting" ||
          old.connectionState ===
            "new"
        )
      ) {

        console.log(
          "Conexão já existente:",
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

    /* =======================================================
       TRACK REMOTA
    ======================================================= */

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
         * Não adiciona a mesma track
         * duas vezes.
         */
        const alreadyExists =
          stream
            .getTracks()
            .some(
              track =>
                track.id ===
                event.track.id
            );

        if (!alreadyExists) {

          stream.addTrack(
            event.track
          );
        }

        /*
         * AQUI ESTÁ A CORREÇÃO PRINCIPAL.
         *
         * Em vez de procurar apenas UM
         * vídeo, conecta a stream a TODOS
         * os vídeos daquele produtor.
         */
        attachStreamToVideos(
          producerId,
          stream
        );

        /*
         * Garante que a transmissão
         * apareça na lista.
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
         * Depois que o React renderizar,
         * tenta anexar novamente.
         *
         * Isso resolve o caso em que
         * ontrack chega antes do <video>.
         */
        setTimeout(
          () => {

            const latestStream =
              streams.current.get(
                producerId
              );

            if (
              latestStream
            ) {

              attachStreamToVideos(
                producerId,
                latestStream
              );
            }

          },
          0
        );

        setTimeout(
          () => {

            const latestStream =
              streams.current.get(
                producerId
              );

            if (
              latestStream
            ) {

              attachStreamToVideos(
                producerId,
                latestStream
              );
            }

          },
          100
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
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "connected"
        ) {

          setStatus(
            "Transmissão conectada"
          );

          /*
           * Garante novamente que o
           * vídeo tenha recebido a stream.
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

          peerConnections.current.delete(
            key
          );

          pendingCandidates.current.delete(
            key
          );
        }

        if (
          pc.connectionState ===
          "closed"
        ) {

          peerConnections.current.delete(
            key
          );

          pendingCandidates.current.delete(
            key
          );
        }
      };

    try {

      /*
       * Só aceita offer se a conexão
       * ainda estiver aberta.
       */
      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      await pc.setRemoteDescription(
        msg.offer
      );

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

      /*
       * ICE recebido antes da offer.
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

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

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

      peerConnections.current.delete(
        key
      );

      pendingCandidates.current.delete(
        key
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
        "Peer não encontrado:",
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

      if (
        pc.signalingState !==
        "have-local-offer"
      ) {

        console.warn(
          "Estado inesperado para answer:",
          pc.signalingState
        );

        return;
      }

      await pc.setRemoteDescription(
        msg.answer
      );

      if (
        pc.signalingState ===
        "closed"
      ) {

        return;
      }

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
     * producerId -> local
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
     * Primeiro procura como viewer.
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
     * Depois procura como produtor.
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

      key =
        key ||
        viewerKey;

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
     * Nunca adiciona ICE em conexão fechada.
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
     * Ainda não existe RemoteDescription.
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

      /*
       * Verifica novamente imediatamente
       * antes de adicionar.
       */
      if (
        pc.signalingState ===
          "closed" ||
        pc.connectionState ===
          "closed"
      ) {

        return;
      }

      await pc.addIceCandidate(
        msg.candidate
      );

    } catch (error) {

      /*
       * Evita o erro:
       *
       * InvalidStateError:
       * RTCPeerConnection's signalingState
       * is 'closed'
       */
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
      pc.connectionState ===
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
      candidates.length ===
        0
    ) {

      return;
    }

    /*
     * Remove da fila antes de processar.
     */
    pendingCandidates.current.delete(
      key
    );

    for (
      const candidate
      of candidates
    ) {

      if (
        pc.signalingState ===
          "closed" ||
        pc.connectionState ===
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
     * Limpa TODOS os vídeos daquela
     * transmissão.
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

        try {
          video.srcObject =
            null;
        } catch {}
      }
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
     * escolhe outra transmissão.
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
        }

      },
      50
    );
  }

  /* =========================================================
     CLEANUP STREAMS
  ========================================================= */

  function cleanupStreams() {

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
     * Limpa TODOS os vídeos.
     */
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

  /* =========================================================
     DERIVADOS
  ========================================================= */

  /*
   * Lista visual:
   *
   * local + produtores remotos.
   */
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

  /*
   * Se local estiver selecionado,
   * mas não estiver transmitindo,
   * mostra a primeira transmissão remota.
   */
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
                          element => {

                            if (element) {

                              setVideoRef(
                                "local",
                                element
                              );

                            }
                          }
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
                        element => {

                          if (element) {

                            setVideoRef(
                              mainProducer,
                              element
                            );

                          }
                        }
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
                              element => {

                                if (element) {

                                  setVideoRef(
                                    producerId,
                                    element
                                  );

                                }
                              }
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