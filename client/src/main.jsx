
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

const MAX_STREAMS = 3;

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
    console.error(
      "Erro TURN:",
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
    viewerCount,
    setViewerCount
  ] = useState(0);

  const [
    error,
    setError
  ] = useState("");

  const [
    roomCode,
    setRoomCode
  ] = useState("");

  const [
    currentRoom,
    setCurrentRoom
  ] = useState("");

  const [
    roomInput,
    setRoomInput
  ] = useState("");

  const [
    inRoom,
    setInRoom
  ] = useState(false);

  /*
   * Lista de transmissões remotas.
   *
   * Cada objeto:
   *
   * {
   *   id,
   *   stream,
   *   muted
   * }
   */

  const [
    remoteStreams,
    setRemoteStreams
  ] = useState([]);

  /*
   * Qual transmissão está grande.
   *
   * Pode ser:
   * - "local"
   * - producerId
   * - null
   */

  const [
    selectedStream,
    setSelectedStream
  ] = useState("local");

  /* =======================================================
     REFS
  ======================================================= */

  const localVideo =
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
    useRef("");

  /* =======================================================
     DISCORD
  ======================================================= */

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

      cleanup();

      if (ws.current) {
        ws.current.close();
      }

    };

  }, []);

  /* =======================================================
     CLEANUP
  ======================================================= */

  function cleanup() {

    if (localStream.current) {

      localStream.current
        .getTracks()
        .forEach(
          track =>
            track.stop()
        );

    }

    localStream.current =
      null;

    if (localVideo.current) {

      localVideo.current.srcObject =
        null;

    }

    closeAllPeers();

  }

  /* =======================================================
     WEBSOCKET
  ======================================================= */

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
        async (event) => {

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
            "Servidor:",
            msg
          );

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
             SAIU
          ================================================= */

          if (
            msg.type ===
            "left-room"
          ) {

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

            setViewerCount(
              0
            );

            setRemoteStreams(
              []
            );

            setSelectedStream(
              "local"
            );

            closeAllPeers();

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
              msg.count || 0
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
             NOVO PRODUTOR
          ================================================= */

          if (
            msg.type ===
            "producer"
          ) {

            /*
             * Não adiciona o mesmo produtor
             * duas vezes.
             */

            if (
              msg.producerId &&
              msg.producerId !==
                "local"
            ) {

              setRemoteStreams(
                previous => {

                  if (
                    previous.some(
                      stream =>
                        stream.id ===
                        msg.producerId
                    )
                  ) {
                    return previous;
                  }

                  if (
                    previous.length >=
                    MAX_STREAMS
                  ) {
                    return previous;
                  }

                  return [
                    ...previous,
                    {
                      id:
                        msg.producerId,

                      stream:
                        null,

                      muted:
                        false
                    }
                  ];

                }
              );

              requestOffer(
                msg.producerId
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

            setRemoteStreams(
              previous =>
                previous.filter(
                  stream =>
                    stream.id !==
                    producerId
                )
            );

            if (
              selectedStream ===
              producerId
            ) {

              setSelectedStream(
                "local"
              );

            }

            const pc =
              peerConnections.current.get(
                producerId
              );

            if (pc) {

              try {
                pc.close();
              } catch {}

              peerConnections.current.delete(
                producerId
              );

            }

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

              await createPeer(
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

            const pc =
              peerConnections.current.get(
                msg.from
              );

            if (!pc) {
              return;
            }

            try {

              await pc.setRemoteDescription(
                msg.answer
              );

              await flushPendingCandidates(
                msg.from
              );

            } catch (error) {

              console.error(
                "Erro answer:",
                error
              );

            }

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

  /* =======================================================
     SEND
  ======================================================= */

  function send(message) {

    if (
      !ws.current ||
      ws.current.readyState !==
        WebSocket.OPEN
    ) {

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

  /* =======================================================
     CRIAR SALA
  ======================================================= */

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

  /* =======================================================
     ENTRAR
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
     SAIR
  ======================================================= */

  function leaveRoom() {

    if (
      localStream.current
    ) {

      localStream.current
        .getTracks()
        .forEach(
          track =>
            track.stop()
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
        WebSocket.OPEN &&
      roomId.current
    ) {

      send({
        type:
          "leave-room"
      });

    }

    roomId.current =
      "";

    setInRoom(
      false
    );

    setCurrentRoom(
      ""
    );

    setRoomCode(
      ""
    );

    setSharing(
      false
    );

    setViewerCount(
      0
    );

    setRemoteStreams(
      []
    );

    setSelectedStream(
      "local"
    );

    setStatus(
      "Servidor conectado"
    );

  }

  /* =======================================================
     CAPTURA
  ======================================================= */

  async function startSharing() {

    setError("");

    if (!inRoom) {

      setError(
        "Entre em uma sala primeiro."
      );

      return;
    }

    /*
     * Impede mais de 3 streams
     * neste frontend.
     */

    const totalStreams =
      remoteStreams.length +
      (sharing ? 1 : 0);

    if (
      totalStreams >=
      MAX_STREAMS
    ) {

      setError(
        "A sala já possui o máximo de 3 transmissões."
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
              }
            },

            /*
             * NÃO captura áudio.
             *
             * Dessa forma o áudio
             * do Discord não entra
             * na transmissão.
             */

            audio: false

          });

      localStream.current =
        stream;

      if (
        localVideo.current
      ) {

        localVideo.current.srcObject =
          stream;

        await localVideo.current
          .play()
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
            stopSharing();
          }
        );

      }

      setSharing(
        true
      );

      setSelectedStream(
        "local"
      );

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

  /* =======================================================
     PARAR
  ======================================================= */

  function stopSharing() {

    if (
      localStream.current
    ) {

      localStream.current
        .getTracks()
        .forEach(
          track =>
            track.stop()
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
        WebSocket.OPEN &&
      roomId.current
    ) {

      send({
        type:
          "stop-sharing"
      });

    }

    setSharing(
      false
    );

    if (
      remoteStreams.length > 0
    ) {

      setSelectedStream(
        remoteStreams[0].id
      );

    } else {

      setSelectedStream(
        "local"
      );

    }

    setStatus(
      "Servidor conectado"
    );

  }

  /* =======================================================
     PEERS
  ======================================================= */

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

  /* =======================================================
     REQUEST OFFER
  ======================================================= */

  function requestOffer(
    producerId
  ) {

    send({
      type:
        "request-offer",

      producerId
    });

  }

  /* =======================================================
     CREATE PEER — PRODUTOR
  ======================================================= */

  async function createPeer(
    viewerId
  ) {

    const old =
      peerConnections.current.get(
        viewerId
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
        iceServers,
        iceTransportPolicy:
          "all"
      });

    peerConnections.current.set(
      viewerId,
      pc
    );

    if (
      localStream.current
    ) {

      for (
        const track of
          localStream.current.getTracks()
      ) {

        pc.addTrack(
          track,
          localStream.current
        );

      }

    }

    pc.onicecandidate =
      ({ candidate }) => {

        if (candidate) {

          send({
            type:
              "ice",

            target:
              viewerId,

            candidate
          });

        }

      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "PRODUTOR:",
          viewerId,
          pc.connectionState
        );

      };

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

      offer:
        pc.localDescription
    });

  }

  /* =======================================================
     HANDLE OFFER — VIEWER
  ======================================================= */

  async function handleOffer(
    msg
  ) {

    const producerId =
      msg.from;

    const old =
      peerConnections.current.get(
        producerId
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
        iceServers,
        iceTransportPolicy:
          "all"
      });

    peerConnections.current.set(
      producerId,
      pc
    );

    /*
     * Quando receber o vídeo,
     * colocamos ele na lista.
     */

    pc.ontrack =
      ({ streams }) => {

        const stream =
          streams?.[0];

        if (!stream) {
          return;
        }

        setRemoteStreams(
          previous => {

            const exists =
              previous.some(
                item =>
                  item.id ===
                  producerId
              );

            if (exists) {

              return previous.map(
                item =>
                  item.id ===
                  producerId
                    ? {
                        ...item,
                        stream
                      }
                    : item
              );

            }

            if (
              previous.length >=
              MAX_STREAMS
            ) {

              return previous;

            }

            return [
              ...previous,
              {
                id:
                  producerId,

                stream,

                muted:
                  false
              }
            ];

          }
        );

        /*
         * Se não existe uma
         * transmissão principal,
         * essa vira principal.
         */

        setSelectedStream(
          current => {

            if (
              current ===
                "local" &&
              !sharing
            ) {

              return producerId;

            }

            return current;

          }
        );

      };

    pc.onicecandidate =
      ({ candidate }) => {

        if (candidate) {

          send({
            type:
              "ice",

            target:
              producerId,

            candidate
          });

        }

      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "VIEWER:",
          producerId,
          pc.connectionState
        );

        if (
          pc.connectionState ===
            "failed" ||
          pc.connectionState ===
            "closed"
        ) {

          setRemoteStreams(
            previous =>
              previous.filter(
                item =>
                  item.id !==
                  producerId
              )
          );

        }

      };

    try {

      await pc.setRemoteDescription(
        msg.offer
      );

      await flushPendingCandidates(
        producerId
      );

    } catch (error) {

      console.error(
        "Erro setRemoteDescription:",
        error
      );

      return;

    }

    try {

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      send({
        type:
          "answer",

        target:
          producerId,

        answer:
          pc.localDescription
      });

    } catch (error) {

      console.error(
        "Erro answer:",
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

    const pc =
      peerConnections.current.get(
        msg.from
      );

    if (
      !pc ||
      !pc.remoteDescription
    ) {

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

    } catch (error) {

      console.warn(
        "ICE:",
        error
      );

    }

  }

  /* =======================================================
     FLUSH ICE
  ======================================================= */

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

    for (
      const candidate of
        candidates
    ) {

      try {

        await pc.addIceCandidate(
          candidate
        );

      } catch {}

    }

    pendingCandidates.current.delete(
      peerId
    );

  }

  /* =======================================================
     SELECIONAR TRANSMISSÃO
  ======================================================= */

  function selectStream(
    id
  ) {

    setSelectedStream(
      id
    );

  }

  /* =======================================================
     MUTAR TRANSMISSÃO
  ======================================================= */

  function toggleMute(
    id
  ) {

    setRemoteStreams(
      previous =>
        previous.map(
          item =>
            item.id === id
              ? {
                  ...item,
                  muted:
                    !item.muted
                }
              : item
        )
    );

  }

  /* =======================================================
     REMOTE VIDEO
  ======================================================= */

  function RemoteVideo({
    item,
    main
  }) {

    const videoRef =
      useRef(null);

    useEffect(() => {

      if (
        videoRef.current &&
        item.stream
      ) {

        videoRef.current.srcObject =
          item.stream;

        videoRef.current.muted =
          item.muted;

        videoRef.current
          .play()
          .catch(
            () => {}
          );

      }

    }, [
      item.stream
    ]);

    useEffect(() => {

      if (
        videoRef.current
      ) {

        videoRef.current.muted =
          item.muted;

      }

    }, [
      item.muted
    ]);

    return (

      <div
        className={
          main
            ? "stream main-stream"
            : "stream mini-stream"
        }
        onClick={() =>
          selectStream(item.id)
        }
      >

        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="stream-video"
        />

        <div className="stream-label">
          <span>
            ● TRANSMISSÃO
          </span>

          <button
            className="audio-button"
            onClick={event => {
              event.stopPropagation();
              toggleMute(item.id);
            }}
          >
            {item.muted
              ? "🔇"
              : "🔊"}
          </button>
        </div>

      </div>

    );

  }

  /* =======================================================
     TODAS AS STREAMS
  ======================================================= */

  const allStreams = [];

  if (sharing) {

    allStreams.push({
      id:
        "local",

      stream:
        localStream.current,

      local:
        true
    });

  }

  for (
    const stream of
      remoteStreams
  ) {

    if (stream.stream) {

      allStreams.push({
        ...stream,
        local:
          false
      });

    }

  }

  /*
   * A transmissão principal.
   */

  let mainStream =
    allStreams.find(
      stream =>
        stream.id ===
        selectedStream
    );

  if (!mainStream) {

    mainStream =
      allStreams[0];

  }

  const miniStreams =
    allStreams.filter(
      stream =>
        stream.id !==
        mainStream?.id
    );

  /* =======================================================
     UI
  ======================================================= */

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

      {!inRoom ? (

        <section className="room-menu">

          <h2>
            Salas
          </h2>

          <p className="muted">
            Crie uma sala ou entre
            usando um código.
          </p>

          <button
            className="primary"
            onClick={
              createRoom
            }
          >
            ➕ Criar sala
          </button>

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

        </section>

      ) : (

        <>

          <section className="room-bar">

            <div>

              <span>
                SALA
              </span>

              <strong>
                {currentRoom}
              </strong>

            </div>

            <div className="room-actions">

              <span className="stream-counter">
                {allStreams.length}/3
                {" "}
                transmissões
              </span>

              <button
                className="secondary"
                onClick={
                  leaveRoom
                }
              >
                Sair da sala
              </button>

            </div>

          </section>

          <section className="stage">

            <div className="video-area">

              {mainStream ? (

                <>

                  <div className="main-video">

                    {mainStream.local ? (

                      <video
                        ref={
                          localVideo
                        }
                        autoPlay
                        muted
                        playsInline
                        className="main-video-element"
                      />

                    ) : (

                      <RemoteVideo
                        item={
                          mainStream
                        }
                        main
                      />

                    )}

                    <div className="main-badge">

                      {mainStream.local
                        ? "● VOCÊ"
                        : "● AO VIVO"}

                    </div>

                  </div>

                  {miniStreams.length >
                    0 && (

                    <div className="mini-streams">

                      {miniStreams.map(
                        stream => (

                          stream.local ? (

                            <div
                              key={
                                stream.id
                              }
                              className="stream mini-stream"
                              onClick={() =>
                                selectStream(
                                  stream.id
                                )
                              }
                            >

                              <video
                                ref={
                                  localVideo
                                }
                                autoPlay
                                muted
                                playsInline
                                className="stream-video"
                              />

                              <div className="stream-label">
                                ● VOCÊ
                              </div>

                            </div>

                          ) : (

                            <RemoteVideo
                              key={
                                stream.id
                              }
                              item={
                                stream
                              }
                              main={false}
                            />

                          )

                        )
                      )}

                    </div>

                  )}

                </>

              ) : (

                <div className="empty">

                  <div className="screen-icon">
                    🖥️
                  </div>

                  <h2>
                    Nenhuma transmissão
                  </h2>

                  <p>
                    Alguém desta sala
                    precisa iniciar
                    uma transmissão.
                  </p>

                </div>

              )}

            </div>

            <aside className="panel">

              <h2>
                ScreenCast
              </h2>

              <p className="muted">
                Até 3 pessoas podem
                transmitir ao mesmo
                tempo.
              </p>

              {!sharing ? (

                <button
                  className="primary"
                  onClick={
                    startSharing
                  }
                  disabled={
                    allStreams.length >=
                    MAX_STREAMS
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
                    {allStreams.length}
                  </strong>

                  <span>
                    transmissões
                  </span>

                </div>

              </div>

              {error && (

                <div className="error">
                  {error}
                </div>

              )}

              <small>
                Código da sala:
                {" "}
                <b>
                  {currentRoom}
                </b>
              </small>

              <small>
                Clique em uma miniatura
                para colocá-la na tela
                principal.
              </small>

            </aside>

          </section>

        </>

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
