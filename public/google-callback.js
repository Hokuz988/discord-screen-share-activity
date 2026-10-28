/*
 * Retorno do login do Google. O token vem no fragmento (#),
 * que nunca é enviado a servidor nenhum. Repassa para a aba
 * do ScreenCast e apaga da barra de endereço.
 */
(function () {
  var params = new URLSearchParams(location.hash.slice(1));

  history.replaceState(null, "", location.pathname);

  var channel = new BroadcastChannel("screencast-google-auth");

  channel.postMessage({
    state: params.get("state"),
    idToken: params.get("id_token"),
    error: params.get("error")
  });

  channel.close();

  setTimeout(function () {
    window.close();
  }, 300);
})();
