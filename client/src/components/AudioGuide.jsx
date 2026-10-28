import React from "react";

/* =========================================================
   GUIA: TRANSMITIR SEM O SOM DO DISCORD
========================================================= */

function Step({ number, title, children }) {
  return (
    <li className="step">
      <span className="step-number mono">{String(number).padStart(2, "0")}</span>
      <div className="step-content">
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

export function AudioGuide() {
  return (
    <article className="guide">
      <header className="guide-header">
        <p className="kicker">Guia · Windows</p>
        <h1>Transmitir sem o som do Discord</h1>
        <p className="lede">
          O navegador captura o som do computador inteiro, então a call do
          Discord vai junto. Dá para evitar de dois jeitos.
        </p>
      </header>

      <section className="guide-section">
        <h2>Jeito rápido: compartilhar uma aba</h2>
        <p>
          Serve para vídeo, música ou jogo que roda no navegador. Na janela
          “Compartilhar tela”, escolha <strong>Som da aba</strong>. No seletor do
          navegador, abra a aba <strong>Guia do Chrome</strong>, escolha a aba e
          deixe marcado <strong>Compartilhar áudio da aba</strong>.
        </p>
        <p className="muted">Só o som daquela aba vai para a transmissão. O Discord nunca entra.</p>
      </section>

      <section className="guide-section">
        <h2>Jogo ou programa instalado</h2>
        <p>
          Aqui a ideia é mandar o jogo para um “cabo virtual” (que vira a saída
          padrão e entra na transmissão) e o Discord direto para o seu fone.
        </p>

        <table className="routing">
          <caption className="sr-only">Para onde vai cada som</caption>
          <thead>
            <tr>
              <th scope="col">Som</th>
              <th scope="col">Toca em</th>
              <th scope="col">Na transmissão</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Jogo</td>
              <td>CABLE Input (padrão)</td>
              <td>Sim</td>
            </tr>
            <tr>
              <td>Discord</td>
              <td>Seu fone</td>
              <td>Não</td>
            </tr>
          </tbody>
        </table>

        <h3 className="group-title">Configuração, uma vez só</h3>

        <ol className="steps">
          <Step number={1} title="Instale o VB-Audio Virtual Cable">
            <p>
              É grátis. Baixe em{" "}
              <a href="https://vb-audio.com/Cable/" target="_blank" rel="noopener noreferrer">vb-audio.com/Cable</a>,
              extraia o .zip, clique com o botão direito em{" "}
              <code>VBCABLE_Setup_x64.exe</code> → <strong>Executar como administrador</strong> →{" "}
              <strong>Install Driver</strong>. Reinicie o PC.
            </p>
          </Step>

          <Step number={2} title="Deixe o cabo como saída padrão">
            <p>
              Botão direito no ícone de som da barra de tarefas →{" "}
              <strong>Configurações de som</strong> → em <strong>Saída</strong>, escolha{" "}
              <strong>CABLE Input</strong>.
            </p>
            <p className="muted">Você vai parar de ouvir o PC por um instante. O passo 3 resolve.</p>
          </Step>

          <Step number={3} title="Continue ouvindo pelo seu fone">
            <p>
              <kbd>Win</kbd> + <kbd>R</kbd>, digite <code>mmsys.cpl</code> e Enter. Na aba{" "}
              <strong>Gravação</strong>, dê dois cliques em <strong>CABLE Output</strong> → aba{" "}
              <strong>Escutar</strong> → marque <strong>Escutar este dispositivo</strong> → em
              “Reprodução por este dispositivo”, escolha o seu fone ou caixa → <strong>OK</strong>.
            </p>
          </Step>

          <Step number={4} title="Mande o Discord direto para o fone">
            <p>
              No Discord: engrenagem → <strong>Voz e vídeo</strong> →{" "}
              <strong>Dispositivo de saída</strong> → escolha o seu fone ou caixa. Não deixe em
              “Padrão”, senão ele vai para o cabo e entra na transmissão.
            </p>
          </Step>
        </ol>

        <h3 className="group-title">Na hora de transmitir</h3>

        <ol className="steps" start={5}>
          <Step number={5} title="Compartilhe com o som do computador">
            <p>
              Em “Compartilhar tela”, escolha <strong>Som do computador</strong> →{" "}
              <strong>Escolher tela</strong>. No seletor, vá em <strong>Tela inteira</strong> e
              deixe marcado <strong>Compartilhar áudio do sistema</strong>.
            </p>
          </Step>

          <Step number={6} title="Teste uma vez">
            <p>
              Com alguém assistindo, fale na call do Discord e pergunte se a pessoa ouviu pela
              transmissão. Se ouviu, revise o passo 4.
            </p>
          </Step>
        </ol>
      </section>

      <section className="guide-section">
        <h2>Outras situações</h2>
        <dl className="faq">
          <dt>Quero voltar ao normal</dt>
          <dd>
            Volte a saída do Windows para o seu fone (passo 2) e desmarque “Escutar este
            dispositivo” (passo 3).
          </dd>

          <dt>Tenho fone e caixa de som</dt>
          <dd>
            Não precisa do cabo: deixe o jogo no aparelho padrão do Windows e mande o Discord para
            o outro aparelho (passo 4).
          </dd>

          <dt>Estou usando dentro do app do Discord</dt>
          <dd>
            Lá não existe “Som da aba”. Para ter certeza de que a call não vaza, abra o ScreenCast
            no Chrome ou no Edge.
          </dd>
        </dl>
      </section>
    </article>
  );
}
