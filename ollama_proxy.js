const OLLAMA_URL = "http://localhost:11434";
const term = require("terminal-kit").terminal;

const FIELDS = [
  { key: "model", label: "Model" },
  { key: "prompt", label: "Prompt" },
  { key: "messages", label: "Messages" },
  { key: "options", label: "Options" },
  { key: "name", label: "Name" },
  { key: "stream", label: "Stream" },
  { key: "raw", label: "Raw Body" },
  { key: "truncate", label: "Truncate", isToggle: true },
];

const DETAIL_LEVELS = [
  ["prompt"],
  ["model", "prompt"],
  ["model", "prompt", "messages"],
  ["model", "prompt", "messages", "options"],
  ["model", "prompt", "messages", "options", "name", "stream"],
  ["model", "prompt", "messages", "options", "name", "stream", "raw"],
];

const requests = [];
let requestId = 0;
let detailLevel = 3;
let visibleFields = new Set(DETAIL_LEVELS[detailLevel]);
let menuOpen = false;
let menuSelection = 0;
let menuFields = FIELDS.map((f) => visibleFields.has(f.key));
let truncate = true;
let scrollOffset = 0;

function render() {
  term.clear();
  term.moveTo(1, 1);

  if (menuOpen) {
    term.bgBlue.white(" Select fields (space: toggle, enter: confirm, q/esc: close) \n\n");

    FIELDS.forEach((field, i) => {
      const selected = i === menuSelection;

      if (selected) {
        term.defaultColor.bgWhite(" ");
      } else {
        term(" ");
      }

      if (field.isToggle) {
        if (truncate) term.green("✓ ");
        else term.red("✗ ");
      } else {
        const checked = menuFields[i];
        if (checked) term.green("✓ ");
        else term.red("✗ ");
      }

      if (selected) {
        term.bgWhite.black(field.label + (field.isToggle ? "" : "") + " ");
      } else {
        term(field.label);
      }
      term("\n");
    });

    term("\n" + "^DDetail level: ^" + detailLevel + "\n");
  } else {
    term.dim("[←/→ detail: " + detailLevel + "] [t: truncate: " + (truncate ? "on" : "off") + "] [Enter: menu] [↑/↓/PgUp/PgDn: scroll] [q: quit]\n");

    const maxVisible = Math.floor(term.height - 2);
    const startIdx = Math.max(0, requests.length - maxVisible - scrollOffset);
    const endIdx = requests.length - scrollOffset;
    const toShow = requests.slice(startIdx, endIdx);

    toShow.forEach((req) => {
      const time = new Date(req.time).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const idStr = "[" + String(req.id).padStart(3, " ") + "]";

      term.cyan(idStr);
      term.dim(" " + time + " ");
      term.bold.magenta(req.method.padEnd(5));
      term.bold.yellow(" " + req.pathname + "\n");

      if (req.bodyData) {
        const bd = req.bodyData;

        if (bd.model && visibleFields.has("model")) {
          term.cyan(idStr);
          term.blue(" Model: ");
          term.bold.cyan(bd.model + "\n");
        }

        if (bd.prompt !== undefined && visibleFields.has("prompt")) {
          let promptText = bd.prompt;
          if (truncate && bd.prompt.length > 80) {
            promptText = bd.prompt.slice(0, 80) + "...";
          }
          term.cyan(idStr);
          term.blue(" Prompt: ");
          term.bold(promptText.replace(/\n/g, "\\n") + "\n");
        }

        if (bd.messages && visibleFields.has("messages")) {
          term.cyan(idStr);
          term.blue(" Messages: " + bd.messages.length + "\n");
          bd.messages.slice(-2).forEach((m) => {
            let content = m.content;
            if (truncate && m.content.length > 50) {
              content = m.content.slice(0, 50) + "...";
            }
            term.cyan(idStr + "   ");
            if (m.role === "user") term.yellow(m.role + ":");
            else term.green(m.role + ":");
            term.bold(" " + content.replace(/\n/g, " ") + "\n");
          });
        }

        if (bd.options && visibleFields.has("options")) {
          const opts = bd.options;
          const optStrs = [];
          if (opts.temperature !== undefined) optStrs.push("temp=" + opts.temperature);
          if (opts.top_p !== undefined) optStrs.push("top_p=" + opts.top_p);
          if (opts.top_k !== undefined) optStrs.push("top_k=" + opts.top_k);
          if (opts.num_predict !== undefined) optStrs.push("max=" + opts.num_predict);
          if (optStrs.length) {
            term.cyan(idStr);
            term.blue(" Options: ");
            term.dim(optStrs.join(", ") + "\n");
          }
        }

        if (bd.name !== undefined && visibleFields.has("name")) {
          term.cyan(idStr);
          term.blue(" Name: " + bd.name + "\n");
        }

        if (bd.stream !== undefined && visibleFields.has("stream")) {
          term.cyan(idStr);
          term.blue(" Stream: " + bd.stream + "\n");
        }

        if (req.rawBody && visibleFields.has("raw")) {
          term.cyan(idStr);
          term.blue(" Raw:\n");
          const lines = req.rawBody.split("\n");
          lines.forEach((line) => {
            term.cyan(idStr + "   ");
            term.dim(line + "\n");
          });
        }
      }

      term.cyan(idStr + " ");
      if (req.status < 400) term.bold.green(req.status);
      else term.bold.red(req.status);
      term.dim(" " + req.latency + "ms\n");

      term("\n");
    });
  }
}

function addRequest(req) {
  requests.push(req);
  if (requests.length > 100) {
    requests.shift();
    if (scrollOffset > 0) {
      scrollOffset = Math.max(0, scrollOffset - 1);
    }
  }
  if (scrollOffset > 0) {
    scrollOffset++;
  }
  render();
}

term.on("key", (name) => {
  if (menuOpen) {
    if (name === "UP" || name === "k") {
      menuSelection = (menuSelection - 1 + FIELDS.length) % FIELDS.length;
      render();
    } else if (name === "DOWN" || name === "j") {
      menuSelection = (menuSelection + 1) % FIELDS.length;
      render();
    } else if (name === " " || name === "ENTER") {
      const field = FIELDS[menuSelection];
      if (field.isToggle) {
        truncate = !truncate;
      } else {
        menuFields[menuSelection] = !menuFields[menuSelection];
        visibleFields = new Set(
          FIELDS.filter((_, i) => menuFields[i] && !FIELDS[i].isToggle).map((f) => f.key)
        );
      }
      render();
    } else if (name === "q" || name === "ESCAPE") {
      menuOpen = false;
      render();
    }
  } else {
    if (name === "RIGHT") {
      detailLevel = Math.min(DETAIL_LEVELS.length - 1, detailLevel + 1);
      visibleFields = new Set(DETAIL_LEVELS[detailLevel]);
      menuFields = FIELDS.map((f) => visibleFields.has(f.key));
      render();
    } else if (name === "LEFT") {
      detailLevel = Math.max(0, detailLevel - 1);
      visibleFields = new Set(DETAIL_LEVELS[detailLevel]);
      menuFields = FIELDS.map((f) => visibleFields.has(f.key));
      render();
    } else if (name === "ENTER") {
      menuOpen = true;
      menuSelection = 0;
      render();
    } else if (name === "t") {
      truncate = !truncate;
      render();
    } else if (name === "UP" || name === "k") {
      scrollOffset = Math.min(requests.length - 1, scrollOffset + 1);
      render();
    } else if (name === "DOWN" || name === "j") {
      scrollOffset = Math.max(0, scrollOffset - 1);
      render();
    } else if (name === "PAGE_UP") {
      scrollOffset = Math.min(requests.length - 1, scrollOffset + Math.floor(term.height / 2));
      render();
    } else if (name === "PAGE_DOWN") {
      scrollOffset = Math.max(0, scrollOffset - Math.floor(term.height / 2));
      render();
    } else if (name === "q" || name === "CTRL_C") {
      term.clear();
      term.moveTo(1, 1);
      term.processExit(0);
    }
  }
});

term.fullscreen(true);
term.grabInput();
render();

Bun.serve({
  port: 11435,

  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = `${OLLAMA_URL}${url.pathname}${url.search}`;
    const start = Date.now();
    const id = ++requestId;

    const bodyText = req.method !== "GET" ? await req.clone().text() : null;
    let bodyData = null;
    if (bodyText) {
      try {
        bodyData = JSON.parse(bodyText);
      } catch {}
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: bodyText,
    });

    const latency = Date.now() - start;

    addRequest({
      id,
      time: Date.now(),
      method: req.method,
      pathname: url.pathname,
      bodyData,
      rawBody: bodyText,
      status: response.status,
      latency,
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});
