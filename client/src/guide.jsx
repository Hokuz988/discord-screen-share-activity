import React from "react";
import { createRoot } from "react-dom/client";

import "./fonts.js";
import "./style.css";

import { AudioGuide } from "./components/AudioGuide.jsx";
import { Wordmark } from "./components/TopBar.jsx";

/* Página avulsa do guia, aberta a partir da janela de compartilhar. */
function GuidePage() {
  return (
    <div className="shell">
      <header className="nav">
        <div className="nav-left">
          <Wordmark />
        </div>
        <a className="btn btn-quiet" href="/">Voltar ao ScreenCast</a>
      </header>
      <main className="page">
        <AudioGuide />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<GuidePage />);
