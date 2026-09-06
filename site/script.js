// Progressive enhancement: add a "Copy" button to code blocks marked with
// data-copy when the Clipboard API is available. Without it, the commands
// remain plain selectable text.
(function () {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    return;
  }

  document.querySelectorAll("[data-copy]").forEach(function (block) {
    var code = block.querySelector("pre code");
    var top = block.querySelector(".code-top");
    var status = block.querySelector(".code-status");
    if (!code || !top || !status) {
      return;
    }

    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = "Copy commands";
    top.appendChild(button);

    var resetTimer = null;

    function setStatus(message, ok) {
      status.textContent = message;
      status.classList.toggle("is-ok", ok);
      status.classList.toggle("is-error", !ok);
      button.textContent = ok ? "Copied" : "Copy commands";
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(function () {
        status.textContent = "";
        status.classList.remove("is-ok", "is-error");
        button.textContent = "Copy commands";
      }, 4000);
    }

    button.addEventListener("click", function () {
      navigator.clipboard.writeText(code.textContent).then(
        function () {
          setStatus("Copied to your clipboard.", true);
        },
        function () {
          setStatus("Copy failed. Select the commands and copy them manually.", false);
        }
      );
    });
  });
})();
