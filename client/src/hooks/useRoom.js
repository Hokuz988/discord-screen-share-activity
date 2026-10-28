import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { api, SIGNALING_URL } from "../lib/api.js";

import {
  computeKeyCheck,
  createRoomCipher,
  formatInvite,
  generateRoomSecret,
  parseInvite,
  signalContext
} from "../lib/e2e.js";

export const MAX_PRODUCERS = 3;

export const QUALITY_PRESETS = {
  light: { label: "Leve", detail: "720p · 30 fps", width: 1280, height: 720, fps: 30, bitrate: 2_500_000, hint: "detail" },
  balanced: { label: "Equilibrada", detail: "1080p · 30 fps", width: 1920, height: 1080, fps: 30, bitrate: 4_500_000, hint: "detail" },
  smooth: { label: "Fluida", detail: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, hint: "motion" }
};

/*
 * O navegador não deixa excluir um app específico do áudio.
 * "tab" captura só a aba escolhida (nunca o Discord). "system"
 * pede restrictOwnAudio, que tira o som do próprio app quando
 * suportado — dentro do app do Discord, isso inclui a call.
 */
function displayMediaOptions({ quality, audio }) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;

  return {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
      displaySurface: audio === "tab" ? "browser" : "monitor"
    },
    audio:
      audio === "none"
        ? false
        : {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false,
            restrictOwnAudio: true
          },
    systemAudio: audio === "system" ? "include" : "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include"
  };
}

async function applySenderLimits(pc, preset) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") {
      continue;
    }

    try {
      const params = sender.getParameters();

      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.bitrate;
      params.encodings[0].maxFramerate = preset.fps;
      params.degradationPreference =
        preset.hint === "motion" ? "maintain-framerate" : "maintain-resolution";

      await sender.setParameters(params);
    } catch {}
  }
}

const FALLBACK_ICE = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];

const ICE_CACHE_MS = 10 * 60 * 1000;
const ICE_GATHER_TIMEOUT_MS = 4000;
const RETRY_DELAY_MS = 2000;

function stopTracks(stream) {
  stream?.getTracks().forEach(track => {
    try {
      track.stop();
    } catch {}
  });
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };

    const check = () => {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    };

    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);

    pc.addEventListener("icegatheringstatechange", check);
  });
}

/* =========================================================
   HOOK
   Toda a lógica lida com refs; o estado do React é só o que a
   UI precisa desenhar. Assim os handlers do WebSocket nunca
   enxergam valores antigos.
========================================================= */

export function useRoom({ token, onUnauthorized }) {
  const [connection, setConnection] = useState("connecting");
  const [room, setRoom] = useState(null);
  const [producers, setProducers] = useState([]);
  const [viewers, setViewers] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [audioMuted, setAudioMuted] = useState(false);
  const [notices, setNotices] = useState([]);
  const [, refresh] = useReducer(value => value + 1, 0);

  const ws = useRef(null);
  const myId = useRef("");
  const roomRef = useRef(null);
  const pendingRoom = useRef(null);
  const localStream = useRef(null);
  const sharingRef = useRef(false);
  const streams = useRef(new Map());
  const peers = useRef(new Map());
  const requested = useRef(new Set());
  const activeProducers = useRef(new Set());
  const iceCache = useRef({ servers: null, at: 0 });
  const preset = useRef(QUALITY_PRESETS.balanced);
  const producerNames = useRef(new Map());
  const namesSeeded = useRef(false);
  const noticeId = useRef(0);
  const onUnauthorizedRef = useRef(onUnauthorized);

  onUnauthorizedRef.current = onUnauthorized;

  /* ------------------------- SEND ------------------------- */

  const send = useCallback(message => {
    const socket = ws.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify(message));
    return true;
  }, []);

  /* ----------------------- NOTICES ------------------------ */

  function notify(text) {
    const id = ++noticeId.current;

    setNotices(list => [...list.slice(-2), { id, text }]);
    setTimeout(() => {
      setNotices(list => list.filter(item => item.id !== id));
    }, 4000);
  }

  /* ------------------------- ICE -------------------------- */

  async function getIceServers() {
    const cache = iceCache.current;

    if (cache.servers && Date.now() - cache.at < ICE_CACHE_MS) {
      return cache.servers;
    }

    try {
      const data = await api.turn();

      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        iceCache.current = { servers: data.iceServers, at: Date.now() };
        return data.iceServers;
      }
    } catch {}

    return FALLBACK_ICE;
  }

  /* ------------------------ PEERS ------------------------- */

  function closePeer(key) {
    const pc = peers.current.get(key);

    if (!pc) {
      return;
    }

    peers.current.delete(key);

    pc.ontrack = null;
    pc.onconnectionstatechange = null;

    try {
      pc.close();
    } catch {}
  }

  function closeAllPeers() {
    for (const key of [...peers.current.keys()]) {
      closePeer(key);
    }
  }

  function removeRemote(producerId) {
    closePeer(`in:${producerId}`);
    requested.current.delete(producerId);
    activeProducers.current.delete(producerId);

    if (streams.current.delete(producerId)) {
      refresh();
    }
  }

  function requestOffer(producerId) {
    if (
      producerId === myId.current ||
      requested.current.has(producerId) ||
      peers.current.has(`in:${producerId}`)
    ) {
      return;
    }

    requested.current.add(producerId);
    send({ type: "request-offer", producerId });
  }

  function retryLater(producerId) {
    requested.current.delete(producerId);

    setTimeout(() => {
      if (activeProducers.current.has(producerId)) {
        requestOffer(producerId);
      }
    }, RETRY_DELAY_MS);
  }

  async function sendSignal({ kind, target, producerId, sdp }) {
    const current = roomRef.current;

    if (!current) {
      return;
    }

    const payload = await current.cipher.seal(
      { sdp },
      signalContext({
        code: current.code,
        from: myId.current,
        to: target,
        producerId,
        kind
      })
    );

    send({ type: "signal", kind, target, producerId, payload });
  }

  /* Sou producer: alguém pediu para assistir. */
  async function offerTo(viewerId) {
    const stream = localStream.current;

    if (!stream || !roomRef.current) {
      return;
    }

    const key = `out:${viewerId}`;
    const iceServers = await getIceServers();

    closePeer(key);

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    peers.current.set(key, pc);

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        closePeer(key);
      }
    };

    try {
      await applySenderLimits(pc, preset.current);
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);

      if (peers.current.get(key) !== pc) {
        return;
      }

      await sendSignal({
        kind: "offer",
        target: viewerId,
        producerId: myId.current,
        sdp: pc.localDescription.toJSON()
      });
    } catch (err) {
      console.warn("[RTC] oferta falhou", err);
      closePeer(key);
    }
  }

  /* Sou viewer: chegou a oferta de um producer. */
  async function acceptOffer(producerId, sdp) {
    const key = `in:${producerId}`;
    const iceServers = await getIceServers();

    closePeer(key);

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    peers.current.set(key, pc);

    pc.ontrack = event => {
      let stream = event.streams[0];

      if (!stream) {
        stream = streams.current.get(producerId) || new MediaStream();
        stream.addTrack(event.track);
      }

      streams.current.set(producerId, stream);
      refresh();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        requested.current.delete(producerId);
      }

      if (pc.connectionState === "failed") {
        closePeer(key);
        streams.current.delete(producerId);
        refresh();
        retryLater(producerId);
      }
    };

    try {
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc);

      if (peers.current.get(key) !== pc) {
        return;
      }

      await sendSignal({
        kind: "answer",
        target: producerId,
        producerId,
        sdp: pc.localDescription.toJSON()
      });
    } catch (err) {
      console.warn("[RTC] resposta falhou", err);
      closePeer(key);
      retryLater(producerId);
    }
  }

  async function acceptAnswer(viewerId, sdp) {
    const pc = peers.current.get(`out:${viewerId}`);

    if (!pc || pc.signalingState !== "have-local-offer") {
      return;
    }

    try {
      await pc.setRemoteDescription(sdp);
    } catch (err) {
      console.warn("[RTC] answer inválida", err);
      closePeer(`out:${viewerId}`);
    }
  }

  async function handleSignal(msg) {
    const current = roomRef.current;

    if (!current) {
      return;
    }

    let data;

    try {
      data = await current.cipher.open(
        msg.payload,
        signalContext({
          code: current.code,
          from: msg.from,
          to: myId.current,
          producerId: msg.producerId,
          kind: msg.kind
        })
      );
    } catch {
      /*
       * Não decifrou: chave errada, mensagem adulterada ou
       * reenviada. Descarta sem dar detalhes.
       */
      console.warn("[E2E] sinal rejeitado");
      return;
    }

    if (msg.kind === "offer" && msg.from === msg.producerId) {
      await acceptOffer(msg.producerId, data.sdp);
    }

    if (msg.kind === "answer") {
      await acceptAnswer(msg.from, data.sdp);
    }
  }

  /* ----------------------- SHARING ------------------------ */

  function releaseLocal() {
    stopTracks(localStream.current);
    localStream.current = null;
    sharingRef.current = false;
    streams.current.delete("local");

    for (const key of [...peers.current.keys()]) {
      if (key.startsWith("out:")) {
        closePeer(key);
      }
    }

    setSharing(false);
    refresh();
  }

  async function startSharing(options = {}) {
    if (localStream.current || !roomRef.current) {
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Este dispositivo não permite compartilhar a tela. Use um computador.");
      return;
    }

    setError("");

    preset.current = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS.balanced;

    let stream;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions(options)
      );
    } catch (err) {
      if (err?.name !== "NotAllowedError") {
        setError("Não foi possível iniciar a captura de tela.");
      }

      return;
    }

    if (localStream.current) {
      stopTracks(stream);
      return;
    }

    const [videoTrack] = stream.getVideoTracks();

    if (videoTrack) {
      videoTrack.contentHint = preset.current.hint;
      videoTrack.addEventListener("ended", () => stopSharing());
    }

    if (options.audio !== "none" && stream.getAudioTracks().length === 0) {
      notify(
        options.audio === "tab"
          ? "Sem som: marque “Compartilhar áudio da aba” ao escolher uma aba."
          : "Sem som: o navegador não liberou o áudio dessa tela."
      );
    }

    setAudioMuted(false);
    localStream.current = stream;
    streams.current.set("local", stream);

    if (!send({ type: "start-sharing" })) {
      releaseLocal();
      setError("Sem conexão com o servidor.");
      return;
    }

    refresh();
  }

  function stopSharing() {
    if (!localStream.current) {
      return;
    }

    send({ type: "stop-sharing" });
    releaseLocal();
  }

  /*
   * Silencia sem renegociar: a trilha continua, mas envia
   * silêncio para todo mundo.
   */
  function toggleAudio() {
    const tracks = localStream.current?.getAudioTracks() || [];

    if (tracks.length === 0) {
      return;
    }

    const muted = tracks[0].enabled;

    for (const track of tracks) {
      track.enabled = !muted;
    }

    setAudioMuted(muted);
  }

  /* ------------------------ ROOMS ------------------------- */

  function resetRoom() {
    releaseLocal();
    closeAllPeers();

    for (const id of [...streams.current.keys()]) {
      streams.current.delete(id);
    }

    requested.current.clear();
    activeProducers.current.clear();
    producerNames.current.clear();
    roomRef.current = null;
    pendingRoom.current = null;

    setRoom(null);
    setProducers([]);
    setViewers(0);
    setBusy(false);
    refresh();
  }

  async function createRoom() {
    setError("");
    setBusy(true);

    const secret = generateRoomSecret();
    const keyCheck = await computeKeyCheck(secret);

    pendingRoom.current = { secret, keyCheck };

    if (!send({ type: "create-room", keyCheck })) {
      pendingRoom.current = null;
      setBusy(false);
      setError("Sem conexão com o servidor.");
    }
  }

  async function joinRoom(invite) {
    setError("");

    const parsed = parseInvite(invite);

    if (!parsed) {
      setError("Convite inválido. Cole o convite completo, com o ponto e a chave.");
      return;
    }

    setBusy(true);

    const keyCheck = await computeKeyCheck(parsed.secret);

    pendingRoom.current = { ...parsed, keyCheck };

    if (!send({ type: "join-room", roomId: parsed.code, keyCheck })) {
      pendingRoom.current = null;
      setBusy(false);
      setError("Sem conexão com o servidor.");
    }
  }

  function leaveRoom() {
    send({ type: "leave-room" });
    resetRoom();
  }

  async function onRoomJoined(code) {
    const pending = pendingRoom.current;

    if (!pending || (pending.code && pending.code !== code)) {
      return;
    }

    pendingRoom.current = null;
    namesSeeded.current = false;

    roomRef.current = {
      code,
      secret: pending.secret,
      keyCheck: pending.keyCheck,
      cipher: await createRoomCipher(pending.secret, code)
    };

    setRoom({ code, invite: formatInvite(code, pending.secret) });
    setBusy(false);

    /* Voltando de uma queda com a tela ainda capturada. */
    if (localStream.current) {
      send({ type: "start-sharing" });
    }
  }

  function onRoomState(msg) {
    const list = Array.isArray(msg.producers) ? msg.producers : [];
    const ids = new Set(list.map(item => item.id));

    for (const id of [...activeProducers.current]) {
      if (!ids.has(id)) {
        notify(`${producerNames.current.get(id) || "Alguém"} parou de transmitir`);
        producerNames.current.delete(id);
        removeRemote(id);
      }
    }

    const announce = namesSeeded.current;
    namesSeeded.current = true;

    for (const item of list) {
      if (
        announce &&
        item.id !== myId.current &&
        !activeProducers.current.has(item.id) &&
        !producerNames.current.has(item.id)
      ) {
        notify(`${item.name} começou a transmitir`);
      }

      producerNames.current.set(item.id, item.name);
    }

    activeProducers.current = new Set(
      [...ids].filter(id => id !== myId.current)
    );

    setProducers(list);
    setViewers(Number(msg.participants) || 0);

    for (const id of activeProducers.current) {
      requestOffer(id);
    }
  }

  /* ---------------------- MESSAGES ------------------------ */

  const handlers = {
    ready(msg) {
      myId.current = msg.id;
      setConnection("online");

      /* Reconectou estando numa sala: volta para ela. */
      const current = roomRef.current;

      if (current) {
        pendingRoom.current = {
          code: current.code,
          secret: current.secret,
          keyCheck: current.keyCheck
        };

        send({ type: "join-room", roomId: current.code, keyCheck: current.keyCheck });
      }
    },

    "room-joined": msg => onRoomJoined(String(msg.roomId || "")),
    "room-state": onRoomState,
    "producer-left": msg => removeRemote(String(msg.producerId || "")),
    "peer-left": msg => closePeer(`out:${msg.peerId}`),
    "request-offer": msg => offerTo(String(msg.viewerId || "")),
    signal: handleSignal,

    "sharing-started"() {
      sharingRef.current = true;
      setSharing(true);
    },

    error(msg) {
      setError(msg.message || "Erro no servidor.");

      if (pendingRoom.current) {
        const wasRejoin = Boolean(roomRef.current);

        pendingRoom.current = null;
        setBusy(false);

        if (wasRejoin) {
          resetRoom();
        }
      }

      /* Pediu para transmitir mas a sala lotou. */
      if (localStream.current && !sharingRef.current) {
        releaseLocal();
      }
    }
  };

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  /* ---------------------- CONNECTION ---------------------- */

  useEffect(() => {
    if (!token) {
      return;
    }

    let alive = true;
    let attempts = 0;
    let retryTimer = null;

    function connect() {
      setConnection("connecting");

      const socket = new WebSocket(SIGNALING_URL);
      ws.current = socket;

      socket.onopen = () => {
        attempts = 0;
        socket.send(JSON.stringify({ type: "auth", token }));
      };

      socket.onmessage = event => {
        let msg;

        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        const handler = handlersRef.current[msg?.type];

        if (handler) {
          Promise.resolve(handler(msg)).catch(err =>
            console.warn("[WS] handler", msg.type, err)
          );
        }
      };

      socket.onclose = event => {
        if (ws.current === socket) {
          ws.current = null;
        }

        if (!alive) {
          return;
        }

        setConnection("offline");

        /* Peers dependem do id antigo; refaz tudo ao voltar. */
        closeAllPeers();
        requested.current.clear();
        sharingRef.current = false;

        for (const id of [...streams.current.keys()]) {
          if (id !== "local") {
            streams.current.delete(id);
          }
        }

        refresh();

        if (event.code === 4001) {
          resetRoom();
          onUnauthorizedRef.current?.();
          return;
        }

        const delay = Math.min(15000, 1000 * 2 ** attempts++);
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      alive = false;
      clearTimeout(retryTimer);

      try {
        ws.current?.close(1000);
      } catch {}

      ws.current = null;
      resetRoom();
    };
  }, [token]);

  /* ------------------------ VIEW -------------------------- */

  const tiles = producers.map(item => {
    const isLocal = item.id === myId.current;

    return {
      id: item.id,
      name: isLocal ? "Você" : item.name,
      isLocal,
      stream: streams.current.get(isLocal ? "local" : item.id) || null
    };
  });

  /* Mostra a própria captura enquanto o servidor confirma. */
  if (localStream.current && !tiles.some(tile => tile.isLocal)) {
    tiles.unshift({
      id: "local",
      name: "Você",
      isLocal: true,
      stream: localStream.current
    });
  }

  return {
    connection,
    room,
    tiles,
    viewers,
    sharing: sharing || Boolean(localStream.current),
    canShare: !localStream.current && producers.length < MAX_PRODUCERS,
    hasAudio: Boolean(localStream.current?.getAudioTracks().length),
    audioMuted,
    toggleAudio,
    notices,
    busy,
    error,
    clearError: () => setError(""),
    createRoom,
    joinRoom,
    leaveRoom,
    startSharing,
    stopSharing
  };
}
