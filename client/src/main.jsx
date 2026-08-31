import React, {
  useEffect,
  useRef,
  useState
} from "react";

import {
  createRoot
} from "react-dom/client";

import "./style.css";

/* =========================================================
   CONFIG
========================================================= */

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  "wss://screen-share-activity.onrender.com";

const TURN_SERVER_URL =
  "https://screen-share-activity.onrender.com";

const MAX_PRODUCERS = 3;

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
        "Resposta TURN inválida."
      );
    }

    return data.iceServers;

  } catch (error) {
    console.warn(
      "[TURN] Indisponível:",
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

  const streams =
    useRef(new Map());

  const videoRefs =
    useRef(new Map());

  const peerConnections =
    useRef(new Map());

  const pendingCandidates =
    useRef(new Map());

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
      set = new Set();

      videoRefs.current.set(
        producerId,
        set
      );
    }

    set.add(element);

    element.autoplay = true;
    element.playsInline = true;

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

    const stream =
      streams.current.get(
        producerId
      );

    if (!stream) {
      return;
    }

    if (
      element.srcObject !==
      stream
    ) {
      element.srcObject =
        stream;
    }

    const tryPlay = () => {
      if (
        element.srcObject !==
        stream
      ) {
        return;
      }

      element.play()
        .catch(error => {
          if (
            error?.name !==
              "AbortError" &&
            error?.name !==
              "NotAllowedError"
          ) {
            console.warn(
              "[VIDEO] play:",
              error
            );
          }
        });
    };

    if (
      element.readyState >= 2
    ) {
      tryPlay();
    } else {
      element.onloadedmetadata =
        tryPlay;
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

      video.autoplay = true;
      video.playsInline = true;

      video.muted =
        producerId === "local"
          ? true
          : !(
              audioStates[
                producerId
              ] ?? false
            );

      video.volume = 1;

      video.play()
        .catch(() => {});
    }
  }

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
        video.srcObject =
          null;
      } catch {}
    }
  }

  /* =======================================================
     WEBSOCKET
  ======================================================= */

  useEffect(() => {
    connectSignal();

    return () => {
      cleanupAll();

      if (ws.current) {
        try {
          ws.current.close();
        } catch {}
      }
    };
  }, []);

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

    try {
      const socket =
        new WebSocket(
          SIGNALING_URL
        );

      ws.current =
        socket;

      socket.onopen = () => {
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
            return;
          }

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

            setProducers(
              remote
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

          /* =================================================
             NEW PRODUCER
          ================================================= */

          if (
            msg.type ===
            "producer"
          ) {
            const producerId =
              String(
                msg.producerId || ""
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
                msg.producerId || ""
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
                String(
                  msg.viewerId || ""
                )
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
            await handleIce(
              msg
            );

            return;
          }
        };

      socket.onerror =
        () => {
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

    } catch {
      setError(
        "WebSocket indisponível."
      );
    }
  }

  /* =======================================================
     SEND
  ======================================================= */

  function send(message) {
    if (
      !ws.current ||
      ws.current.readyState !==
        WebSocket.OPEN
    ) {
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

    ws.current.send(
      JSON.stringify(
        payload
      )
    );

    return true;
  }

  /* =======================================================
     ROOM
  ======================================================= */

  function createRoom() {
    setError("");

    send({
      type:
        "create-room"
    });
  }

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

  function leaveRoom() {
    send({
      type:
        "leave-room"
    });

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
            track =>
              track.stop()
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
            stopSharing();
          };
      }

      attachStream(
        "local",
        stream
      );

    } catch (error) {
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
  }

  /* =======================================================
     REQUEST OFFER
  ======================================================= */

  function requestOffer(
    producerId
  ) {
    if (
      !producerId ||
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

    send({
      type:
        "request-offer",

      producerId
    });
  }

  /* =======================================================
     PRODUCER PEER
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

    const old =
      peerConnections.current.get(
        key
      );

    if (old) {
      if (
        old.signalingState !==
        "closed"
      ) {
        return;
      }

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

    pendingCandidates.current.set(
      key,
      []
    );

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
        if (!event.candidate) {
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
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate
        });
      };

    pc.onconnectionstatechange =
      () => {
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

    } catch {
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
      return;
    }

    const key =
      `${producerId}->local`;

    const old =
      peerConnections.current.get(
        key
      );

    if (old) {
      if (
        old.signalingState !==
        "closed"
      ) {
        return;
      }

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

    pendingCandidates.current.set(
      key,
      []
    );

    pc.ontrack =
      event => {
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

            streams.current.set(
              producerId,
              stream
            );
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

        } else {
          streams.current.set(
            producerId,
            stream
          );
        }

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

            return [
              ...current,
              producerId
            ].slice(
              0,
              MAX_PRODUCERS
            );
          }
        );
      };

    pc.onicecandidate =
      event => {
        if (!event.candidate) {
          return;
        }

        send({
          type:
            "ice",

          target:
            producerFrom,

          producerId,

          candidate:
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate
        });
      };

    pc.onconnectionstatechange =
      () => {
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
          producerFrom,

        producerId,

        answer:
          pc.localDescription
      });

    } catch (error) {
      console.error(
        "[VIEWER] erro:",
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
      return;
    }

    try {
      if (
        pc.signalingState !==
        "have-local-offer"
      ) {
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
        "[PRODUCER] erro:",
        error
      );
    }
  }

  /* =======================================================
     ICE
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

    const pc =
      peerConnections.current.get(
        key
      );

    if (!pc) {
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

    if (
      !pc ||
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

    for (
      const candidate
      of list
    ) {
      try {
        await pc.addIceCandidate(
          candidate
        );
      } catch (error) {
        console.warn(
          "[ICE] erro:",
          error
        );
      }
    }
  }

  /* =======================================================
     REMOVE REMOTE
  ======================================================= */

  function removeRemoteProducer(
    producerId
  ) {
    if (!producerId) {
      return;
    }

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
      current =>
        current === producerId
          ? "local"
          : current
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
          .catch(() => {});
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
      0
    );
  }

  /* =======================================================
     CLEANUP
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
          video.pause();
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

    setSharing(false);
    setProducers([]);
    setSelectedProducer(
      "local"
    );
    setViewerCount(0);
  }

  /* =======================================================
     DERIVADOS
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
              SCREENCAST
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
                  ws.current?.readyState ===
                  WebSocket.OPEN
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
                            registerVideo(
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
                      {
                        audioStates[
                          mainProducer
                        ]
                          ? "🔊"
                          : "🔇"
                      }
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

