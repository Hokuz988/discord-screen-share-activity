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
  import.meta.env.VITE_DISCORD_CLIENT_ID || "";

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "wss://screen-share-activity.onrender.com";

const TURN_SERVER_URL =
  import.meta.env.VITE_TURN_SERVER_URL ||
  "https://screen-share-activity.onrender.com";

const MAX_PRODUCERS = 3;

let discordSdk = null;

/* =========================================================
   TURN / ICE
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
      !Array.isArray(data.iceServers) ||
      data.iceServers.length === 0
    ) {
      throw new Error(
        "Resposta TURN inválida."
      );
    }

    console.log(
      "[TURN] Servidores recebidos:",
      data.iceServers
    );

    return data.iceServers;

  } catch (error) {
    console.warn(
      "[TURN] indisponível, usando STUN:",
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
    streamVersion,
    setStreamVersion
  ] = useState(0);

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
   * producerId->local
   * local->viewer
   */
  const peerConnections =
    useRef(new Map());

  /*
   * peerKey -> ICE candidates
   */
  const pendingCandidates =
    useRef(new Map());

  /*
   * Producer IDs para os quais
   * já solicitamos offer.
   */
  const requestedOffers =
    useRef(new Set());

  /*
   * Impede duas negociações simultâneas
   * para o mesmo viewer.
   */
  const creatingProducerPeers =
    useRef(new Set());

  const roomId =
    useRef("");

  const myId =
    useRef("");

  /* =======================================================
     SAFE SEND
  ======================================================= */

  function send(message) {
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

    try {
      console.log(
        "[SEND]",
        payload
      );

      ws.current.send(
        JSON.stringify(payload)
      );

      return true;

    } catch (error) {
      console.error(
        "[SEND]",
        error
      );

      return false;
    }
  }

  /* =======================================================
     VIDEO REGISTER
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
      set = new Set();

      videoRefs.current.set(
        producerId,
        set
      );
    }

    set.add(element);

    element.autoplay =
      true;

    element.playsInline =
      true;

    /*
     * Vídeo local sempre sem áudio.
     *
     * Miniaturas também ficam sem áudio.
     * O vídeo principal remoto é controlado
     * pelo próprio controle nativo do navegador.
     */
    element.muted =
      producerId === "local";

    element.volume = 1;

    const stream =
      streams.current.get(
        producerId
      );

    if (!stream) {
      return;
    }

    element.srcObject =
      stream;

    const playVideo =
      () => {
        element.play()
          .then(() => {
            console.log(
              "[VIDEO] PLAY OK:",
              producerId
            );
          })
          .catch(error => {
            console.warn(
              "[VIDEO] play bloqueado:",
              producerId,
              error
            );
          });
      };

    if (
      element.readyState >= 2
    ) {
      playVideo();
    } else {
      element.onloadedmetadata =
        playVideo;
    }
  }

  /* =======================================================
     UNREGISTER VIDEO
  ======================================================= */

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

  /* =======================================================
     ATTACH STREAM
  ======================================================= */

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

    const attach =
      () => {
        const videos =
          videoRefs.current.get(
            producerId
          );

        if (
          !videos ||
          videos.size === 0
        ) {
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

          /*
           * Som:
           *
           * local = sempre mudo
           *
           * remoto = áudio normal
           *
           * O usuário controla volume/mute
           * pelos controles nativos do vídeo.
           */
          video.muted =
            producerId === "local";

          video.volume = 1;

          const playVideo =
            () => {
              video.play()
                .then(() => {
                  console.log(
                    "[VIDEO] PLAY OK:",
                    producerId
                  );
                })
                .catch(error => {
                  console.warn(
                    "[VIDEO] play:",
                    producerId,
                    error
                  );
                });
            };

          if (
            video.readyState >= 2
          ) {
            playVideo();
          } else {
            video.onloadedmetadata =
              playVideo;
          }
        }
      };

    attach();

    setTimeout(
      attach,
      50
    );

    setTimeout(
      attach,
      200
    );

    setTimeout(
      attach,
      500
    );
  }

  /* =======================================================
     CLEAR VIDEO
  ======================================================= */

  function clearVideo(
    producerId
  ) {
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
      try {
        video.pause();
        video.srcObject = null;
      } catch {}
    }
  }

  /* =======================================================
     CREATE PEER CONNECTION
  ======================================================= */

  async function createPeer(
    key
  ) {
    const iceServers =
      await getIceServers();

    console.log(
      "[WEBRTC] Criando RTCPeerConnection:",
      key
    );

    const pc =
      new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all",
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
      });

    peerConnections.current.set(
      key,
      pc
    );

    pendingCandidates.current.set(
      key,
      []
    );

    return pc;
  }

  /* =======================================================
     CLOSE PEER
  ======================================================= */

  function closePeer(
    key
  ) {
    const pc =
      peerConnections.current.get(
        key
      );

    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      } catch {}
    }

    peerConnections.current.delete(
      key
    );

    pendingCandidates.current.delete(
      key
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

    if (!roomId.current) {
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
      "[VIEWER] request-offer:",
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

    if (
      viewerId ===
      myId.current
    ) {
      return;
    }

    const key =
      `local->${viewerId}`;

    if (
      creatingProducerPeers.current.has(
        viewerId
      )
    ) {
      console.log(
        "[PRODUCER] negociação já em andamento:",
        viewerId
      );

      return;
    }

    const existing =
      peerConnections.current.get(
        key
      );

    if (existing) {
      if (
        existing.connectionState !==
          "failed" &&
        existing.connectionState !==
          "closed"
      ) {
        console.log(
          "[PRODUCER] peer já existe:",
          key,
          existing.connectionState
        );

        return;
      }

      closePeer(key);
    }

    creatingProducerPeers.current.add(
      viewerId
    );

    try {
      console.log(
        "[PRODUCER] criando peer:",
        key
      );

      const pc =
        await createPeer(key);

      const tracks =
        localStream.current.getTracks();

      for (
        const track
        of tracks
      ) {
        try {
          pc.addTrack(
            track,
            localStream.current
          );
        } catch (error) {
          console.error(
            "[PRODUCER] addTrack:",
            error
          );
        }
      }

      pc.onicecandidate =
        event => {
          if (!event.candidate) {
            return;
          }

          const candidate =
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate;

          console.log(
            "[PRODUCER] ICE ->",
            viewerId
          );

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

      pc.oniceconnectionstatechange =
        () => {
          console.log(
            "[PRODUCER] ICE connection:",
            viewerId,
            pc.iceConnectionState
          );

          if (
            pc.iceConnectionState ===
            "failed"
          ) {
            console.warn(
              "[PRODUCER] ICE falhou:",
              viewerId
            );

            closePeer(key);

            setTimeout(() => {
              if (
                localStream.current &&
                roomId.current
              ) {
                creatingProducerPeers.current.delete(
                  viewerId
                );

                send({
                  type:
                    "request-offer",

                  producerId:
                    myId.current
                });
              }
            }, 1000);
          }
        };

      pc.onconnectionstatechange =
        () => {
          console.log(
            "[PRODUCER]",
            viewerId,
            "connection:",
            pc.connectionState
          );

          if (
            pc.connectionState ===
            "connected"
          ) {
            console.log(
              "[PRODUCER] conexão estabelecida:",
              viewerId
            );
          }

          if (
            pc.connectionState ===
              "failed" ||
            pc.connectionState ===
              "closed"
          ) {
            console.warn(
              "[PRODUCER] conexão falhou:",
              viewerId
            );

            if (
              peerConnections.current.get(
                key
              ) === pc
            ) {
              closePeer(key);
            }
          }
        };

      const offer =
        await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false
        });

      await pc.setLocalDescription(
        offer
      );

      await waitForIceGatheringComplete(
        pc
      );

      if (
        !pc.localDescription
      ) {
        throw new Error(
          "localDescription não criada."
        );
      }

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
        "[PRODUCER] erro ao criar offer:",
        viewerId,
        error
      );

      closePeer(key);

    } finally {
      creatingProducerPeers.current.delete(
        viewerId
      );
    }
  }

  /* =======================================================
     WAIT ICE GATHERING
  ======================================================= */

  function waitForIceGatheringComplete(
    pc
  ) {
    return new Promise(
      resolve => {
        if (
          pc.iceGatheringState ===
          "complete"
        ) {
          resolve();
          return;
        }

        const timeout =
          setTimeout(
            () => {
              resolve();
            },
            5000
          );

        const check =
          () => {
            if (
              pc.iceGatheringState ===
              "complete"
            ) {
              clearTimeout(
                timeout
              );

              pc.removeEventListener(
                "icegatheringstatechange",
                check
              );

              resolve();
            }
          };

        pc.addEventListener(
          "icegatheringstatechange",
          check
        );
      }
    );
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
        msg.producerId ||
        ""
      );

    if (
      !producerId ||
      !producerFrom ||
      !msg.offer
    ) {
      console.warn(
        "[VIEWER] offer inválida:",
        msg
      );

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
      "[VIEWER] offer recebida:",
      producerId
    );

    const existing =
      peerConnections.current.get(
        key
      );

    if (existing) {
      if (
        existing.connectionState !==
          "failed" &&
        existing.connectionState !==
          "closed"
      ) {
        console.log(
          "[VIEWER] peer já existe:",
          key,
          existing.connectionState
        );

        return;
      }

      closePeer(key);
    }

    try {
      const pc =
        await createPeer(key);

      pc.ontrack =
        event => {
          console.log(
            "[VIEWER] TRACK:",
            producerId,
            event.track.kind,
            event.track.readyState
          );

          let stream =
            event.streams?.[0];

          if (!stream) {
            stream =
              streams.current.get(
                producerId
              );

            if (!stream) {
              stream =
                new MediaStream();
            }

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
          }

          streams.current.set(
            producerId,
            stream
          );

          console.log(
            "[VIEWER] STREAM:",
            producerId,
            stream
              .getTracks()
              .map(
                track =>
                  `${track.kind}:${track.readyState}`
              )
          );

          setStreamVersion(
            version =>
              version + 1
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
        };

      pc.onicecandidate =
        event => {
          if (!event.candidate) {
            return;
          }

          const candidate =
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate;

          console.log(
            "[VIEWER] ICE ->",
            producerFrom
          );

          send({
            type:
              "ice",

            target:
              producerFrom,

            producerId,

            candidate
          });
        };

      pc.oniceconnectionstatechange =
        () => {
          console.log(
            "[VIEWER] ICE:",
            producerId,
            pc.iceConnectionState
          );

          if (
            pc.iceConnectionState ===
              "connected" ||
            pc.iceConnectionState ===
              "completed"
          ) {
            setStatus(
              "Transmissão conectada"
            );
          }

          if (
            pc.iceConnectionState ===
            "failed"
          ) {
            console.warn(
              "[VIEWER] ICE falhou:",
              producerId
            );
          }
        };

      pc.onconnectionstatechange =
        () => {
          console.log(
            "[VIEWER]",
            producerId,
            "connection:",
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
            console.warn(
              "[VIEWER] conexão encerrada:",
              producerId
            );
          }
        };

      await pc.setRemoteDescription(
        msg.offer
      );

      console.log(
        "[VIEWER] remoteDescription OK:",
        producerId
      );

      await flushPendingCandidates(
        key
      );

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      await waitForIceGatheringComplete(
        pc
      );

      if (
        !pc.localDescription
      ) {
        throw new Error(
          "localDescription do viewer não criada."
        );
      }

      console.log(
        "[VIEWER] enviando answer:",
        producerId
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
        "[VIEWER] erro ao processar offer:",
        producerId,
        error
      );

      closePeer(key);
    }
  }

  /* =======================================================
     HANDLE ANSWER
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
        "[PRODUCER] peer não encontrado:",
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
          "[PRODUCER] estado inesperado:",
          pc.signalingState
        );

        return;
      }

      await pc.setRemoteDescription(
        msg.answer
      );

      console.log(
        "[PRODUCER] answer recebida:",
        viewerId
      );

      await flushPendingCandidates(
        key
      );

    } catch (error) {
      console.error(
        "[PRODUCER] erro answer:",
        viewerId,
        error
      );
    }
  }

  /* =======================================================
     HANDLE ICE
  ======================================================= */

  async function handleIce(
    msg
  ) {
    if (!msg.candidate) {
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
      console.warn(
        "[ICE] mensagem incompleta:",
        msg
      );

      return;
    }

    let key;

    if (
      producerId ===
      myId.current
    ) {
      key =
        `local->${from}`;
    } else {
      key =
        `${producerId}->local`;
    }

    let pc =
      peerConnections.current.get(
        key
      );

    if (!pc) {
      console.log(
        "[ICE] peer ainda não existe, enfileirando:",
        key
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

    if (
      !pc.remoteDescription
    ) {
      console.log(
        "[ICE] aguardando remoteDescription:",
        key
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

    try {
      await pc.addIceCandidate(
        msg.candidate
      );

      console.log(
        "[ICE] candidato adicionado:",
        key
      );

    } catch (error) {
      console.warn(
        "[ICE] erro ao adicionar:",
        key,
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

    const list =
      pendingCandidates.current.get(
        key
      );

    if (
      !list ||
      list.length === 0
    ) {
      return;
    }

    pendingCandidates.current.delete(
      key
    );

    console.log(
      `[ICE] processando ${list.length} candidatos:`,
      key
    );

    for (
      const candidate
      of list
    ) {
      try {
        await pc.addIceCandidate(
          candidate
        );

        console.log(
          "[ICE] candidato pendente OK:",
          key
        );

      } catch (error) {
        console.warn(
          "[ICE] candidato pendente falhou:",
          key,
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

    closePeer(key);

    clearVideo(
      producerId
    );

    streams.current.delete(
      producerId
    );

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

    setStreamVersion(
      version =>
        version + 1
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
        `A sala já possui ${MAX_PRODUCERS} transmissões ativas.`
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
        "[SCREEN] captura iniciada:",
        stream
      );

      localStream.current =
        stream;

      streams.current.set(
        "local",
        stream
      );

      setSharing(true);

      setSelectedProducer(
        "local"
      );

      const sent =
        send({
          type:
            "start-sharing"
        });

      if (!sent) {
        stream
          .getTracks()
          .forEach(
            track => {
              try {
                track.stop();
              } catch {}
            }
          );

        localStream.current =
          null;

        streams.current.delete(
          "local"
        );

        setSharing(false);

        setError(
          "Servidor de sinalização não está conectado."
        );

        return;
      }

      setStatus(
        "Você está transmitindo"
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

      attachStream(
        "local",
        stream
      );

      setStreamVersion(
        version =>
          version + 1
      );

    } catch (error) {
      console.error(
        "[SCREEN] erro:",
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

  /* =======================================================
     STOP SHARING
  ======================================================= */

  function stopSharing() {
    if (
      !localStream.current &&
      !sharing
    ) {
      return;
    }

    console.log(
      "[SCREEN] parando transmissão..."
    );

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

    for (
      const [
        key
      ]
      of peerConnections.current
    ) {
      if (
        key.startsWith(
          "local->"
        )
      ) {
        closePeer(key);
      }
    }

    creatingProducerPeers.current.clear();

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

    clearVideo(
      "local"
    );

    setSharing(false);

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

    setStreamVersion(
      version =>
        version + 1
    );
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
     JOIN ROOM
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
     LEAVE ROOM
  ======================================================= */

  function leaveRoom() {
    if (
      ws.current &&
      ws.current.readyState ===
      WebSocket.OPEN
    ) {
      send({
        type:
          "leave-room"
      });
    }

    cleanupStreams();

    roomId.current =
      "";

    setRoomCode("");
    setCurrentRoom("");
    setInRoom(false);
    setSharing(false);
    setProducers([]);
    setSelectedProducer(
      "local"
    );
    setViewerCount(0);

    setStatus(
      "Servidor conectado"
    );
  }

  /* =======================================================
     SELECT PRODUCER
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

        if (!stream) {
          return;
        }

        attachStream(
          producerId,
          stream
        );

        /*
         * Como esta função normalmente é chamada
         * por um clique do usuário, tentamos tocar
         * o vídeo principal com áudio.
         */
        const videos =
          videoRefs.current.get(
            producerId
          );

        if (
          producerId !== "local" &&
          videos
        ) {
          for (
            const video
            of videos
          ) {
            video.muted = false;
            video.volume = 1;

            video.play()
              .then(() => {
                console.log(
                  "[VIDEO] áudio habilitado:",
                  producerId
                );
              })
              .catch(error => {
                console.warn(
                  "[VIDEO] navegador bloqueou autoplay com áudio:",
                  error
                );
              });
          }
        }
      },
      0
    );
  }

  /* =======================================================
     CLEANUP STREAMS
  ======================================================= */

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
      const [
        key
      ]
      of peerConnections.current
    ) {
      closePeer(key);
    }

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

    pendingCandidates.current.clear();

    requestedOffers.current.clear();

    creatingProducerPeers.current.clear();

    for (
      const videos
      of videoRefs.current.values()
    ) {
      for (
        const video
        of videos
      ) {
        try {
          video.pause();
          video.srcObject = null;
        } catch {}
      }
    }

    videoRefs.current.clear();

    setStreamVersion(
      version =>
        version + 1
    );
  }

  /* =======================================================
     CLEANUP ALL
  ======================================================= */

  function cleanupAll() {
    cleanupStreams();

    roomId.current =
      "";

    setSharing(false);
    setProducers([]);
    setSelectedProducer(
      "local"
    );
    setViewerCount(0);
  }

  /* =======================================================
     DISCORD
  ======================================================= */

  useEffect(() => {
    let alive = true;

    async function setup() {
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
          "[DISCORD]",
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
    if (
      ws.current &&
      (
        ws.current.readyState ===
          WebSocket.OPEN ||
        ws.current.readyState ===
          WebSocket.CONNECTING
      )
    ) {
      return;
    }

    console.log(
      "[WS] conectando:",
      SIGNALING_URL
    );

    try {
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
              "[WS] JSON inválido"
            );

            return;
          }

          console.log(
            "[SERVER]",
            msg
          );

          /* ================================================
             CLIENT ID
          ================================================ */

          if (
            msg.type ===
            "client-id"
          ) {
            myId.current =
              String(
                msg.id || ""
              );

            console.log(
              "[CLIENT ID]",
              myId.current
            );

            return;
          }

          /* ================================================
             ROOM CREATED
          ================================================ */

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

            setRoomCode(code);
            setCurrentRoom(code);
            setInRoom(true);

            requestedOffers.current.clear();

            setProducers([]);

            setSelectedProducer(
              "local"
            );

            setError("");

            setStatus(
              "Sala criada"
            );

            return;
          }

          /* ================================================
             ROOM JOINED
          ================================================ */

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

            setRoomCode(code);
            setCurrentRoom(code);
            setInRoom(true);

            requestedOffers.current.clear();

            setProducers([]);

            setSelectedProducer(
              "local"
            );

            setError("");

            setStatus(
              "Você entrou na sala"
            );

            return;
          }

          /* ================================================
             PRODUCER LIST
          ================================================ */

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
                  current ===
                  "local"
                ) {
                  return current;
                }

                if (
                  remote.includes(
                    current
                  )
                ) {
                  return current;
                }

                return (
                  remote[0] ||
                  "local"
                );
              }
            );

            for (
              const producerId
              of remote
            ) {
              requestOffer(
                producerId
              );
            }

            return;
          }

          /* ================================================
             NEW PRODUCER
          ================================================ */

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

          /* ================================================
             PRODUCER LEFT
          ================================================ */

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

          /* ================================================
             VIEWER COUNT
          ================================================ */

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

          /* ================================================
             SERVER ERROR
          ================================================ */

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

          /* ================================================
             REQUEST OFFER
          ================================================ */

          if (
            msg.type ===
            "request-offer"
          ) {
            const viewerId =
              String(
                msg.viewerId ||
                ""
              );

            if (
              localStream.current &&
              viewerId
            ) {
              await createProducerPeer(
                viewerId
              );
            }

            return;
          }

          /* ================================================
             OFFER
          ================================================ */

          if (
            msg.type ===
            "offer"
          ) {
            await handleOffer(
              msg
            );

            return;
          }

          /* ================================================
             ANSWER
          ================================================ */

          if (
            msg.type ===
            "answer"
          ) {
            await handleAnswer(
              msg
            );

            return;
          }

          /* ================================================
             ICE
          ================================================ */

          if (
            msg.type ===
            "ice"
          ) {
            await handleIce(
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
        () => {
          console.warn(
            "[WS] fechado"
          );

          setStatus(
            "Servidor desconectado"
          );
        };

    } catch (error) {
      console.error(
        "[WS]",
        error
      );

      setError(
        "WebSocket indisponível."
      );
    }
  }

  /* =======================================================
     DERIVED
  ======================================================= */

  const displayProducers =
    [
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

            <section
              className="main-stage"
              key={`${mainProducer}-${streamVersion}`}
            >

              {hasStreams ? (

                <div className="main-video-wrapper">

                  {mainProducer ===
                  "local" ? (

                    sharing ? (

                      <video
                        ref={
                          element => {
                            if (element) {
                              registerVideo(
                                "local",
                                element
                              );
                            }
                          }
                        }
                        autoPlay
                        muted
                        playsInline
                        controls
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

                    /*
                     * VÍDEO PRINCIPAL REMOTO
                     *
                     * Aqui o áudio é totalmente
                     * controlado pelos controles
                     * nativos do <video>.
                     */
                    <video
                      ref={
                        element => {
                          if (element) {
                            registerVideo(
                              mainProducer,
                              element
                            );

                            /*
                             * O vídeo principal remoto
                             * começa com áudio habilitado.
                             */
                            element.muted =
                              false;

                            element.volume =
                              1;
                          }
                        }
                      }
                      autoPlay
                      playsInline
                      controls
                      muted={false}
                    />

                  )}

                  <div className="main-overlay">

                    <div className="stream-title">

                      {mainProducer ===
                      "local"
                        ? "Sua transmissão"
                        : "Transmissão ao vivo"}

                    </div>

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
                              element => {
                                if (element) {
                                  registerVideo(
                                    producerId,
                                    element
                                  );
                                }
                              }
                            }
                            autoPlay
                            muted
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