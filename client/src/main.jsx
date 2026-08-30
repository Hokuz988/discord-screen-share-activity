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

let discordSdk = null;

/* =========================================================
   TURN
========================================================= */

async function getIceServers() {
  try {
    console.log(
      "Buscando credenciais TURN..."
    );

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

    console.log(
      "TURN configurado."
    );

    return data.iceServers;

  } catch (error) {
    console.error(
      "Erro TURN:",
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
   * Lista dos produtores remotos.
   *
   * Cada item:
   *
   * {
   *   id: "producer-id",
   *   stream: MediaStream
   * }
   */

  const [
    remoteStreams,
    setRemoteStreams
  ] = useState([]);

  /*
   * Qual transmissão está grande.
   */

  const [
    selectedStreamId,
    setSelectedStreamId
  ] = useState(null);

  /* =======================================================
     REFS
  ======================================================= */

  const localVideo =
    useRef(null);

  const ws =
    useRef(null);

  const localStream =
    useRef(null);

  /*
   * PeerConnections:
   *
   * produtor/viewer ID
   *        ↓
   * RTCPeerConnection
   */

  const peerConnections =
    useRef(new Map());

  /*
   * ICE que chegou antes
   * da RemoteDescription.
   */

  const pendingCandidates =
    useRef(new Map());

  /*
   * Streams remotos.
   */

  const remoteStreamsRef =
    useRef(new Map());

  /*
   * Evita problemas com
   * estado antigo dentro
   * dos eventos WebSocket.
   */

  const sharingRef =
    useRef(false);

  const inRoomRef =
    useRef(false);

  const roomId =
    useRef("");

  /* =========================================================
     DISCORD
  ========================================================= */

  useEffect(() => {

    let alive = true;

    async function setupDiscord() {

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

        setDiscordReady(
          true
        );

        setStatus(
          "Conectado ao Discord"
        );

        console.log(
          "Discord SDK conectado."
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

      stopSharing();

      closeAllPeers();

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
        async (event) => {

          let msg;

          try {

            msg =
              JSON.parse(
                event.data
              );

          } catch (error) {

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

            inRoomRef.current =
              true;

            setError("");

            setStatus(
              "Sala criada"
            );

            console.log(
              "SALA CRIADA:",
              code
            );

            return;
          }

          /* =================================================
             ENTROU NA SALA
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

            inRoomRef.current =
              true;

            setError("");

            setStatus(
              "Você entrou na sala"
            );

            console.log(
              "ENTROU NA SALA:",
              code
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

            inRoomRef.current =
              false;

            sharingRef.current =
              false;

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

            clearRemoteStreams();

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
              "Servidor retornou erro:",
              msg.message
            );

            setError(
              msg.message ||
              "Erro no servidor."
            );

            return;
          }

          /* =================================================
             PRODUTOR
          ================================================= */

          if (
            msg.type ===
            "producer"
          ) {

            /*
             * Se somos o produtor,
             * não precisamos assistir
             * nossa própria transmissão
             * como stream remota.
             */

            if (
              sharingRef.current
            ) {
              return;
            }

            if (
              !msg.producerId
            ) {
              return;
            }

            console.log(
              "NOVO PRODUTOR:",
              msg.producerId
            );

            requestOffer(
              msg.producerId
            );

            return;
          }

          /* =================================================
             PRODUTORES
             
             Suporte caso o servidor
             envie vários produtores
             de uma vez.
          ================================================= */

          if (
            msg.type ===
            "producers"
          ) {

            if (
              sharingRef.current
            ) {
              return;
            }

            const producers =
              Array.isArray(
                msg.producers
              )
                ? msg.producers
                : [];

            for (
              const producerId
              of producers
            ) {

              if (
                producerId
              ) {

                requestOffer(
                  producerId
                );
              }
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
              msg.producerId ||
              msg.id;

            console.log(
              "PRODUTOR SAIU:",
              producerId
            );

            removeRemoteStream(
              producerId
            );

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

            console.log(
              "PEDIDO DE OFFER:",
              msg.viewerId
            );

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
        (error) => {

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
        "WebSocket ainda não está conectado."
      );

      setError(
        "Servidor ainda não conectado."
      );

      return;
    }

    const payload = {
      ...message
    };

    /*
     * Só coloca o roomId automaticamente
     * se a mensagem ainda não possuir um.
     */

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

    console.log(
      "CRIANDO SALA..."
    );

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

    console.log(
      "ENTRANDO NA SALA:",
      code
    );

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

    console.log(
      "SAINDO DA SALA:",
      roomId.current
    );

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

      localVideo.current
        .srcObject =
        null;
    }

    closeAllPeers();

    clearRemoteStreams();

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

    inRoomRef.current =
      false;

    sharingRef.current =
      false;

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

    setStatus(
      "Servidor conectado"
    );
  }

  /* =========================================================
     CAPTURA
========================================================= */

  async function startSharing() {

    setError("");

    if (!inRoomRef.current) {

      setError(
        "Entre em uma sala primeiro."
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
              }
            },

            /*
             * IMPORTANTE:
             *
             * false = NÃO captura
             * áudio do sistema/Discord.
             */

            audio: false
          }
        );

      console.log(
        "Stream:",
        stream
      );

      localStream.current =
        stream;

      sharingRef.current =
        true;

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

      /*
       * Ao começar uma transmissão,
       * fechamos conexões antigas de viewer
       * somente se necessário.
       */

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
     PARAR
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
          track =>
            track.stop()
        );
    }

    localStream.current =
      null;

    sharingRef.current =
      false;

    if (
      localVideo.current
    ) {

      localVideo.current
        .srcObject =
        null;
    }

    /*
     * Como produtor,
     * fecha as conexões que estavam
     * enviando nossa tela.
     */

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

    if (inRoomRef.current) {

      setStatus(
        "Servidor conectado"
      );
    }
  }

  /* =========================================================
     PEERS
========================================================= */

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

  /* =========================================================
     REMOTE STREAMS
========================================================= */

  function addRemoteStream(
    producerId,
    stream
  ) {

    if (
      !producerId ||
      !stream
    ) {
      return;
    }

    remoteStreamsRef.current.set(
      producerId,
      stream
    );

    setRemoteStreams(
      Array.from(
        remoteStreamsRef.current.entries()
      ).map(
        ([id, remoteStream]) => ({
          id,
          stream:
            remoteStream
        })
      )
    );

    /*
     * Se ainda não existe uma
     * transmissão selecionada,
     * seleciona esta.
     */

    setSelectedStreamId(
      current => {

        if (current) {
          return current;
        }

        return producerId;
      }
    );
  }

  function removeRemoteStream(
    producerId
  ) {

    if (!producerId) {
      return;
    }

    remoteStreamsRef.current.delete(
      producerId
    );

    setRemoteStreams(
      Array.from(
        remoteStreamsRef.current.entries()
      ).map(
        ([id, stream]) => ({
          id,
          stream
        })
      )
    );

    setSelectedStreamId(
      current => {

        if (
          current ===
          producerId
        ) {

          const remaining =
            Array.from(
              remoteStreamsRef.current.keys()
            );

          return (
            remaining[0] ||
            null
          );
        }

        return current;
      }
    );
  }

  function clearRemoteStreams() {

    remoteStreamsRef.current.clear();

    setRemoteStreams([]);

    setSelectedStreamId(
      null
    );
  }

  /* =========================================================
     REQUEST OFFER
========================================================= */

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

  /* =========================================================
     CREATE PEER — PRODUTOR
========================================================= */

  async function createPeer(
    viewerId
  ) {

    console.log(
      "Criando PeerConnection:",
      viewerId
    );

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

    /* =====================================================
       TRACKS
    ===================================================== */

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

    /* =====================================================
       ICE
    ===================================================== */

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

    pc.onicecandidateerror =
      event => {

        console.warn(
          "PRODUTOR ICE ERROR:",
          event
        );
      };

    pc.onconnectionstatechange =
      () => {

        console.log(
          "PRODUTOR:",
          viewerId,
          pc.connectionState
        );
      };

    /* =====================================================
       OFFER
    ===================================================== */

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

    console.log(
      "OFFER ENVIADA:",
      viewerId
    );
  }

  /* =========================================================
     HANDLE OFFER — VIEWER
========================================================= */

  async function handleOffer(
    msg
  ) {

    const producerId =
      msg.from;

    console.log(
      "OFFER RECEBIDA DO PRODUTOR:",
      producerId
    );

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

    /*
     * IMPORTANTE:
     *
     * Cada produtor possui
     * seu próprio PeerConnection.
     */

    peerConnections.current.set(
      producerId,
      pc
    );

    /* =====================================================
       TRACK
    ===================================================== */

    pc.ontrack =
      ({ streams }) => {

        console.log(
          "TRACK RECEBIDA:",
          producerId
        );

        const stream =
          streams?.[0];

        if (!stream) {
          return;
        }

        addRemoteStream(
          producerId,
          stream
        );
      };

    /* =====================================================
       ICE
    ===================================================== */

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

    pc.onicecandidateerror =
      event => {

        console.warn(
          "VIEWER ICE ERROR:",
          event
        );
      };

    /* =====================================================
       CONNECTION
    ===================================================== */

    pc.onconnectionstatechange =
      () => {

        console.log(
          "VIEWER:",
          producerId,
          pc.connectionState
        );

        if (
          pc.connectionState ===
          "failed"
        ) {

          setError(
            "Uma conexão WebRTC falhou."
          );
        }

        if (
          pc.connectionState ===
          "closed"
        ) {

          removeRemoteStream(
            producerId
          );
        }
      };

    /* =====================================================
       REMOTE DESCRIPTION
    ===================================================== */

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

    /* =====================================================
       ANSWER
    ===================================================== */

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

      console.log(
        "ANSWER ENVIADA:",
        producerId
      );

    } catch (error) {

      console.error(
        "Erro criando answer:",
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

  /* =========================================================
     FLUSH ICE
========================================================= */

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
      `Processando ${candidates.length} ICE candidates para ${peerId}`
    );

    for (
      const candidate of
      candidates
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
      peerId
    );
  }

  /* =========================================================
     VIDEO COMPONENT
========================================================= */

  function RemoteVideo({
    stream,
    large = false,
    onClick
  }) {

    const videoRef =
      useRef(null);

    useEffect(() => {

      if (
        videoRef.current &&
        stream
      ) {

        videoRef.current.srcObject =
          stream;

        videoRef.current
          .play()
          .catch(
            () => {}
          );
      }

    }, [stream]);

    return (
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={
          large
            ? "remote-video large"
            : "remote-video"
        }
        onClick={onClick}
      />
    );
  }

  /* =========================================================
     STREAM SELECTION
========================================================= */

  function selectStream(
    producerId
  ) {

    console.log(
      "Selecionando transmissão:",
      producerId
    );

    setSelectedStreamId(
      producerId
    );
  }

  /* =========================================================
     UI
========================================================= */

  return (

    <main className="app">

      {/* =====================================================
          TOPBAR
      ===================================================== */}

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

      {/* =====================================================
          MENU
      ===================================================== */}

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

          {/* =================================================
              ROOM BAR
          ================================================= */}

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

              <span className="stream-count">
                {remoteStreams.length}
                {" "}
                transmissão
                {remoteStreams.length !== 1
                  ? "ões"
                  : ""}
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

          {/* =================================================
              CONTENT
          ================================================= */}

          <section className="stage">

            {/* =================================================
                VIDEO AREA
            ================================================= */}

            <div className="video-area">

              {remoteStreams.length > 0 ? (

                <div className="stream-layout">

                  {/* =================================================
                      STREAM PRINCIPAL
                  ================================================= */}

                  <div className="main-stream">

                    {(() => {

                      const selected =
                        remoteStreams.find(
                          item =>
                            item.id ===
                            selectedStreamId
                        ) ||
                        remoteStreams[0];

                      return (

                        <RemoteVideo
                          stream={
                            selected.stream
                          }
                          large={true}
                          onClick={() =>
                            selectStream(
                              selected.id
                            )
                          }
                        />

                      );

                    })()}

                    <div className="stream-label">

                      <span className="live-dot">
                        ●
                      </span>

                      AO VIVO

                    </div>

                  </div>

                  {/* =================================================
                      MINI STREAMS
                  ================================================= */}

                  {remoteStreams.length > 1 && (

                    <div className="stream-sidebar">

                      {remoteStreams
                        .filter(
                          item =>
                            item.id !==
                            selectedStreamId
                        )
                        .map(
                          item => (

                            <div
                              className="mini-stream"
                              key={
                                item.id
                              }
                              onClick={() =>
                                selectStream(
                                  item.id
                                )
                              }
                            >

                              <RemoteVideo
                                stream={
                                  item.stream
                                }
                              />

                              <div className="mini-label">
                                ● AO VIVO
                              </div>

                            </div>

                          )
                        )}

                    </div>

                  )}

                </div>

              ) : sharing ? (

                <div className="local-only">

                  <video
                    ref={
                      localVideo
                    }
                    autoPlay
                    muted
                    playsInline
                  />

                  <div className="stream-label">
                    ● SUA TRANSMISSÃO
                  </div>

                </div>

              ) : (

                <div className="empty">

                  <div className="screen-icon">
                    ▣
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

            {/* =================================================
                PANEL
            ================================================= */}

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
                    espectadores
                  </span>

                </div>

                <div>

                  <strong>
                    {remoteStreams.length}
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

              {remoteStreams.length > 1 && (

                <div className="hint">

                  💡 Clique em uma
                  transmissão pequena
                  para colocá-la em
                  destaque.

                </div>

              )}

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
