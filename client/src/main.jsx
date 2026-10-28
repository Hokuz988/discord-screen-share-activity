import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiscordSDK } from "@discord/embedded-app-sdk";

import "./fonts.js";
import "./style.css";

import { api, getToken, IN_DISCORD, setToken } from "./lib/api.js";
import { useRoom } from "./hooks/useRoom.js";
import { AudioGuide } from "./components/AudioGuide.jsx";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { Lobby } from "./components/Lobby.jsx";
import { Room } from "./components/Room.jsx";
import { TopBar } from "./components/TopBar.jsx";

/* =========================================================
   DISCORD
========================================================= */

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || "";

function useDiscord() {
  useEffect(() => {
    if (!DISCORD_CLIENT_ID || !IN_DISCORD) {
      return;
    }

    new DiscordSDK(DISCORD_CLIENT_ID)
      .ready()
      .catch(error => console.warn("[DISCORD]", error));
  }, []);
}

/* =========================================================
   APP
========================================================= */

function SignedIn({ token, user, onLogout, onExpired }) {
  const room = useRoom({ token, onUnauthorized: onExpired });
  const [tab, setTab] = useState("rooms");

  if (room.room) {
    return <Room room={room} />;
  }

  return (
    <div className="shell">
      <TopBar
        user={user}
        connection={room.connection}
        tab={tab}
        onTab={setTab}
        onLogout={onLogout}
      />

      {tab === "audio" ? (
        <main className="page">
          <AudioGuide />
        </main>
      ) : (
        <Lobby room={room} />
      )}
    </div>
  );
}

function App() {
  useDiscord();

  const [token, setTokenState] = useState(getToken);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));

  const signOutLocally = useCallback(() => {
    setToken("");
    setTokenState("");
    setUser(null);
  }, []);

  useEffect(() => {
    if (!token || user) {
      setChecking(false);
      return;
    }

    let alive = true;

    api.me()
      .then(data => alive && setUser(data.user))
      .catch(error => {
        if (alive && error.status === 401) {
          signOutLocally();
        }
      })
      .finally(() => alive && setChecking(false));

    return () => {
      alive = false;
    };
  }, [token]);

  function handleAuthenticated(nextToken, nextUser) {
    setToken(nextToken);
    setUser(nextUser);
    setTokenState(nextToken);
  }

  async function logout() {
    try {
      await api.logout();
    } catch {}

    signOutLocally();
  }

  if (checking) {
    return (
      <div className="boot">
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (!token || !user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <SignedIn
      token={token}
      user={user}
      onLogout={logout}
      onExpired={signOutLocally}
    />
  );
}

/* =========================================================
   ROOT
========================================================= */

createRoot(document.getElementById("root")).render(<App />);
