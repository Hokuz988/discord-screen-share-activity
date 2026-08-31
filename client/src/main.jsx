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
      ) ||
      data.iceServers.length === 0
    ) {
      throw new Error(
        "Resposta TURN inválida."
      );
    }

    return data.iceServers;

  } catch (error) {

    console.warn(
      "[TURN] usando STUN:",
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
    userName,
    setUserName
  ] = useState("");

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
    producerNames,
    setProducerNames
  ] = useState({});

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
   * Trava física contra múltiplos cliques.
   */
  const startingSharing =
    useRef(false);

  /*
   * ID da transmissão local.
   */
  const localProducerActive =
    useRef(false);

  const streams =
    useRef(new Map());

  const names =
    useRef(new Map());

  const mainVideoRef =
    useRef(null);

  const peerConnections =
    useRef(new Map());

  const pendingCandidates =
    useRef(new Map());

  const requestedOffers =
    useRef(new Set());

  const creatingProducerPeers =
    useRef(new Set());

  const roomId =
    useRef("");

  const myId =
    useRef("");

  const userNameRef =
    useRef("");

  /* =======================================================
     NAME SYNC
  ======================================================= */

  useEffect(() => {
    userNameRef.current =
      userName;
  }, [userName]);

  /* =======================================================
     SEND
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
     ATTACH VIDEO
  ======================================================= */

  function attachMainVideo(
    producerId,
    stream
  ) {

    if (!stream) {
      return;
    }

    const video =
      mainVideoRef.current;

    if (!video) {
      return;
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

      video.volume =
        0;

    } else {

      video.muted =
        false;

      video.volume =
        1;
    }

    video.play()
      .catch(() => {});
  }

  /* =======================================================
     CLEAR VIDEO
  ======================================================= */

  function clearMainVideo() {

    const video =
      mainVideoRef.current;

    if (!video) {
      return;
    }

    try {

      video.pause();

      video.srcObject =
        null;

      video.onloadedmetadata =
        null;

      video.muted =
        true;

      video.volume =
        0;

    } catch {}
  }

  /* =======================================================
     CREATE PEER
  ======================================================= */

  async function createPeer(
    key
  ) {

    const iceServers =
      await getIceServers();

    const pc =
      new RTCPeerConnection({
        iceServers,
        iceTransportPolicy:
          "all",
        bundlePolicy:
          "max-bundle",
        rtcpMuxPolicy:
          "require"
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

        pc.onicecandidate =
          null;

        pc.ontrack =
          null;

        pc.onconnectionstatechange =
          null;

        pc.oniceconnectionstatechange =
          null;

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
        return;
      }

      closePeer(key);
    }

    creatingProducerPeers.current.add(
      viewerId
    );

    try {

      const pc =
        await createPeer(key);

      const tracks =
        localStream.current.getTracks();

      for (
        const track
        of tracks
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

          const candidate =
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate;

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

          if (
            pc.connectionState ===
            "failed"
          ) {

            closePeer(key);
          }
        };

      const offer =
        await pc.createOffer();

      await pc.setLocalDescription(
        offer
      );

      await waitForIceGatheringComplete(
        pc
      );

      if (
        !pc.localDescription
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

        producerName:
          userNameRef.current.trim() ||
          "Usuário",

        offer:
          pc.localDescription
      });

    } catch (error) {

      console.error(
        "[PRODUCER] offer:",
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
     WAIT ICE
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
            resolve,
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
      return;
    }

    if (
      producerId ===
      myId.current
    ) {
      return;
    }

    const incomingName =
      String(
        msg.producerName ||
        msg.displayName ||
        msg.name ||
        ""
      ).trim();

    if (incomingName) {

      names.current.set(
        producerId,
        incomingName
      );

      setProducerNames(
        current => ({
          ...current,
          [producerId]:
            incomingName
        })
      );
    }

    const key =
      `${producerId}->local`;

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
        return;
      }

      closePeer(key);
    }

    try {

      const pc =
        await createPeer(key);

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
            }

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
          }

          streams.current.set(
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

              const maxRemote =
                sharing
                  ? MAX_PRODUCERS - 1
                  : MAX_PRODUCERS;

              if (
                current.length >=
                maxRemote
              ) {
                return current;
              }

              return [
                ...current,
                producerId
              ];
            }
          );

          setStreamVersion(
            version =>
              version + 1
          );

          if (
            selectedProducer ===
            producerId
          ) {

            setTimeout(() => {

              attachMainVideo(
                producerId,
                stream
              );

            }, 0);
          }
        };

      pc.onicecandidate =
        event => {

          if (
            !event.candidate
          ) {
            return;
          }

          const candidate =
            event.candidate.toJSON
              ? event.candidate.toJSON()
              : event.candidate;

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

            if (
              stream &&
              selectedProducer ===
                producerId
            ) {

              attachMainVideo(
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

            closePeer(key);
          }
        };

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

      await waitForIceGatheringComplete(
        pc
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
        "[VIEWER] offer:",
        error
      );

      closePeer(key);
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
        "[PRODUCER] answer:",
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

    const key =
      producerId ===
      myId.current
        ? `local->${from}`
        : `${producerId}->local`;

    const pc =
      peerConnections.current.get(
        key
      );

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
        "[ICE]",
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

      } catch {}
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

    closePeer(
      `${producerId}->local`
    );

    streams.current.delete(
      producerId
    );

    names.current.delete(
      producerId
    );

    setProducerNames(
      current => {

        const copy = {
          ...current
        };

        delete copy[
          producerId
        ];

        return copy;
      }
    );

    setProducers(
      current =>
        current.filter(
          id =>
            id !==
            producerId
        )
    );

    if (
      selectedProducer ===
      producerId
    ) {

      clearMainVideo();

      setSelectedProducer(
        "local"
      );
    }

    setStreamVersion(
      version =>
        version + 1
    );
  }

  /* =======================================================
     START SHARING
  ======================================================= */

  async function startSharing() {

    /*
     * PRIMEIRA trava.
     */

    if (
      startingSharing.current
    ) {

      console.warn(
        "[SCREEN] startSharing bloqueado: já executando."
      );

      return;
    }

    /*
     * SEGUNDA trava.
     */

    if (
      localProducerActive.current ||
      localStream.current
    ) {

      console.warn(
        "[SCREEN] transmissão já existe."
      );

      return;
    }

    if (!inRoom) {

      setError(
        "Entre em uma sala primeiro."
      );

      return;
    }

    /*
     * A sala suporta 3 transmissões TOTAL.
     */

    const activeRemoteCount =
      producers.length;

    if (
      activeRemoteCount >=
      MAX_PRODUCERS
    ) {

      setError(
        `A sala já possui ${MAX_PRODUCERS} transmissões ativas.`
      );

      return;
    }

    startingSharing.current =
      true;

    setError("");

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

      /*
       * Se por algum motivo uma segunda
       * chamada conseguiu passar,
       * mata a segunda stream.
       */

      if (
        localStream.current ||
        localProducerActive.current
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

        return;
      }

      localStream.current =
        stream;

      localProducerActive.current =
        true;

      streams.current.set(
        "local",
        stream
      );

      const finalName =
        userNameRef.current.trim() ||
        "Você";

      names.current.set(
        "local",
        finalName
      );

      setSharing(true);

      setSelectedProducer(
        "local"
      );

      const sent =
        send({

          type:
            "start-sharing",

          displayName:
            finalName,

          producerName:
            finalName,

          userName:
            finalName
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

        localProducerActive.current =
          false;

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

      setStreamVersion(
        version =>
          version + 1
      );

      setTimeout(() => {

        attachMainVideo(
          "local",
          stream
        );

      }, 0);

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

    } catch (error) {

      console.error(
        "[SCREEN]",
        error
      );

      localStream.current =
        null;

      localProducerActive.current =
        false;

      if (
        error?.name !==
        "NotAllowedError"
      ) {

        setError(
          "Não foi possível iniciar a captura."
        );
      }

    } finally {

      startingSharing.current =
        false;
    }
  }

  /* =======================================================
     STOP SHARING
  ======================================================= */

  function stopSharing() {

    if (
      !localStream.current &&
      !localProducerActive.current
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
      const key
      of peerConnections.current.keys()
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

    localProducerActive.current =
      false;

    streams.current.delete(
      "local"
    );

    names.current.delete(
      "local"
    );

    clearMainVideo();

    setSharing(false);

    setSelectedProducer(
      producers[0] ||
      "local"
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

    const name =
      userName.trim();

    if (!name) {

      setError(
        "Digite seu nome primeiro."
      );

      return;
    }

    send({

      type:
        "create-room",

      userName:
        name,

      displayName:
        name
    });
  }

  /* =======================================================
     JOIN ROOM
  ======================================================= */

  function joinRoom() {

    setError("");

    const name =
      userName.trim();

    if (!name) {

      setError(
        "Digite seu nome primeiro."
      );

      return;
    }

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
        code,

      userName:
        name,

      displayName:
        name
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
    setProducerNames({});
    setSelectedProducer(
      "local"
    );
    setViewerCount(0);

    setStatus(
      "Servidor conectado"
    );
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

    clearMainVideo();

    const stream =
      streams.current.get(
        producerId
      );

    if (stream) {

      setTimeout(() => {

        attachMainVideo(
          producerId,
          stream
        );

      }, 0);
    }
  }

  /* =======================================================
     CLEANUP STREAMS
  ======================================================= */

  function cleanupStreams() {

    startingSharing.current =
      false;

    localProducerActive.current =
      false;

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
      const key
      of peerConnections.current.keys()
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

    names.current.clear();

    clearMainVideo();

    setProducerNames({});

    setStreamVersion(
      version =>
        version + 1
    );
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
                msg.id ||
                ""
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
                msg.roomId ||
                ""
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
                msg.roomId ||
                ""
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

            const unique =
              new Map();

            for (
              const item
              of list
            ) {

              const id =
                String(
                  typeof item ===
                    "string"
                    ? item
                    : (
                        item?.id ||
                        item?.producerId ||
                        ""
                      )
                ).trim();

              if (!id) {
                continue;
              }

              if (
                id ===
                myId.current
              ) {
                continue;
              }

              unique.set(
                id,
                item
              );
            }

            const remote =
              Array.from(
                unique.keys()
              )
                .slice(
                  0,
                  MAX_PRODUCERS -
                    (
                      sharing
                        ? 1
                        : 0
                    )
                );

            for (
              const [
                id,
                item
              ]
              of unique
            ) {

              if (
                !remote.includes(id)
              ) {
                continue;
              }

              const name =
                String(
                  typeof item ===
                    "string"
                    ? ""
                    : (
                        item?.name ||
                        item?.displayName ||
                        item?.producerName ||
                        ""
                      )
                ).trim();

              if (name) {

                names.current.set(
                  id,
                  name
                );
              }
            }

            const nameObject =
              {};

            for (
              const id
              of remote
            ) {

              const name =
                names.current.get(
                  id
                );

              if (name) {

                nameObject[id] =
                  name;
              }
            }

            setProducerNames(
              current => ({
                ...current,
                ...nameObject
              })
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
                msg.id ||
                ""
              ).trim();

            if (!producerId) {
              return;
            }

            if (
              producerId ===
              myId.current
            ) {
              return;
            }

            const name =
              String(
                msg.displayName ||
                msg.producerName ||
                msg.name ||
                ""
              ).trim();

            if (name) {

              names.current.set(
                producerId,
                name
              );

              setProducerNames(
                current => ({
                  ...current,
                  [producerId]:
                    name
                })
              );
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

                const maxRemote =
                  sharing
                    ? MAX_PRODUCERS - 1
                    : MAX_PRODUCERS;

                if (
                  current.length >=
                  maxRemote
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
             VIEWERS
          ================================================ */

          if (
            msg.type ===
            "viewer-count"
          ) {

            setViewerCount(
              Number(
                msg.count ||
                0
              )
            );

            return;
          }

          /* ================================================
             ALREADY ACTIVE
          ================================================ */

          if (
            msg.type ===
            "sharing-already-active"
          ) {

            localProducerActive.current =
              true;

            return;
          }

          /* ================================================
             ERROR
          ================================================ */

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
              localProducerActive.current &&
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
     DERIVED
  ======================================================= */

  const displayProducers =
    [
      ...(sharing
        ? ["local"]
        : []),

      ...producers
    ]
      .filter(
        (id, index, array) =>
          array.indexOf(id) ===
          index
      )
      .slice(
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

          <div className="name-field">

            <label htmlFor="user-name">
              Seu nome
            </label>

            <input
              id="user-name"
              className="name-input"
              type="text"
              value={userName}
              onChange={
                event =>
                  setUserName(
                    event.target.value
                  )
              }
              onKeyDown={
                event => {

                  if (
                    event.key ===
                    "Enter"
                  ) {
                    createRoom();
                  }
                }
              }
              placeholder="Como você quer aparecer?"
              maxLength={24}
              autoComplete="off"
            />

            <div className="name-hint">
              Esse nome será mostrado para quem estiver na sala.
            </div>

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
              key={
                `${mainProducer}-${streamVersion}`
              }
            >

              {hasStreams ? (

                <div className="main-video-wrapper">

                  <video
                    ref={
                      element => {

                        mainVideoRef.current =
                          element;

                        const stream =
                          streams.current.get(
                            mainProducer
                          );

                        if (
                          element &&
                          stream
                        ) {

                          attachMainVideo(
                            mainProducer,
                            stream
                          );
                        }
                      }
                    }
                    autoPlay
                    muted={
                      mainProducer ===
                      "local"
                    }
                    playsInline
                    controls
                  />

                  <div className="main-overlay">

                    <div className="stream-title">

                      {
                        mainProducer ===
                        "local"
                          ? (
                              names.current.get(
                                "local"
                              ) ||
                              userName ||
                              "Sua transmissão"
                            )
                          : (
                              producerNames[
                                mainProducer
                              ] ||
                              names.current.get(
                                mainProducer
                              ) ||
                              "Transmissão"
                            )
                      }

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

                    const displayName =
                      isLocal
                        ? (
                            names.current.get(
                              "local"
                            ) ||
                            userName ||
                            "Você"
                          )
                        : (
                            producerNames[
                              producerId
                            ] ||
                            names.current.get(
                              producerId
                            ) ||
                            "Transmissão"
                          );

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

                          <div className="thumb-placeholder">

                            <span className="thumb-screen-icon">
                              🖥️
                            </span>

                            <span>
                              {displayName}
                            </span>

                          </div>

                          <span className="thumb-live">
                            ● AO VIVO
                          </span>

                        </div>

                        <div className="thumb-info">

                          <span>
                            {displayName}
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
                    disabled={
                      startingSharing.current ||
                      producers.length >=
                        MAX_PRODUCERS
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
   ROOT
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