const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL;
if (isExtension) {
  document.documentElement.classList.add('is-extension');
}
const isWebContext = !isExtension;

let isRecording = false;
let websocket = null;
let recorder = null;
let chunkDuration = 100;
let websocketUrl = "ws://localhost:8000/asr";
let userClosing = false;
let wakeLock = null;
let startTime = null;
let timerInterval = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let workletNode = null;
let recorderWorker = null;
let waveCanvas = document.getElementById("waveCanvas");
let waveCtx = waveCanvas.getContext("2d");
let animationFrame = null;
let waitingForStop = false;
let lastReceivedData = null;
let availableMicrophones = [];
let selectedMicrophoneId = null;
let serverUseAudioWorklet = null;
let configReadyResolve;
const configReady = new Promise((r) => (configReadyResolve = r));
let outputAudioContext = null;
let audioSource = null;
let systemAudioEnabled = false;
let systemAudioStream = null;
let systemAudioSourceNode = null;
let systemTrackEndedHandler = null;
// Server prunes lines older than ~5 min from each response to bound memory.
// Frontend keeps the full session locally so the rendered transcript and any
// download contain the entire meeting. Keyed by start time (number) for
// in-place updates when a line's text grows or its speaker is reassigned.
const sessionLines = new Map();
// Rendered DOM node per line, keyed the same way as sessionLines, so a payload
// only rewrites the lines that changed. See reconcileLineNodes.
const renderedLines = new Map();
let emptyStateShown = false;
// How close to the bottom the reader has to be for the transcript to keep
// following new text. Above that, their scroll position is left alone.
const SCROLL_STICK_THRESHOLD_PX = 80;

waveCanvas.width = 60 * (window.devicePixelRatio || 1);
waveCanvas.height = 30 * (window.devicePixelRatio || 1);
waveCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

const statusText = document.getElementById("status");
const recordButton = document.getElementById("recordButton");
const chunkSelector = document.getElementById("chunkSelector");
const websocketInput = document.getElementById("websocketInput");
const websocketDefaultSpan = document.getElementById("wsDefaultUrl");
const linesTranscriptDiv = document.getElementById("linesTranscript");
const timerElement = document.querySelector(".timer");
const themeRadios = document.querySelectorAll('input[name="theme"]');
const microphoneSelect = document.getElementById("microphoneSelect");
const systemAudioToggle = document.getElementById("systemAudioToggle");
const systemAudioHint = document.getElementById("systemAudioHint");
const languageSelect = document.getElementById("languageSelect");
const diarizationToggle = document.getElementById("diarizationToggle");

const settingsToggle = document.getElementById("settingsToggle");
const settingsDiv = document.querySelector(".settings");
const downloadButton = document.getElementById("downloadButton");

// if (isExtension) {
//   chrome.runtime.onInstalled.addListener((details) => {
//     if (details.reason.search(/install/g) === -1) {
//       return;
//     }
//     chrome.tabs.create({
//       url: chrome.runtime.getURL("welcome.html"),
//       active: true
//     });
//   });
// }

const translationIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="12px" viewBox="0 -960 960 960" width="12px" fill="#5f6368"><path d="m603-202-34 97q-4 11-14 18t-22 7q-20 0-32.5-16.5T496-133l152-402q5-11 15-18t22-7h30q12 0 22 7t15 18l152 403q8 19-4 35.5T868-80q-13 0-22.5-7T831-106l-34-96H603ZM362-401 188-228q-11 11-27.5 11.5T132-228q-11-11-11-28t11-28l174-174q-35-35-63.5-80T190-640h84q20 39 40 68t48 58q33-33 68.5-92.5T484-720H80q-17 0-28.5-11.5T40-760q0-17 11.5-28.5T80-800h240v-40q0-17 11.5-28.5T360-880q17 0 28.5 11.5T400-840v40h240q17 0 28.5 11.5T680-760q0 17-11.5 28.5T640-720h-76q-21 72-63 148t-83 116l96 98-30 82-122-125Zm266 129h144l-72-204-72 204Z"/></svg>`
const silenceIcon = `<svg xmlns="http://www.w3.org/2000/svg" style="vertical-align: text-bottom;" height="14px" viewBox="0 -960 960 960" width="14px" fill="#5f6368"><path d="M514-556 320-752q9-3 19-5.5t21-2.5q66 0 113 47t47 113q0 11-1.5 22t-4.5 22ZM40-200v-32q0-33 17-62t47-44q51-26 115-44t141-18q26 0 49.5 2.5T456-392l-56-54q-9 3-19 4.5t-21 1.5q-66 0-113-47t-47-113q0-11 1.5-21t4.5-19L84-764q-11-11-11-28t11-28q12-12 28.5-12t27.5 12l675 685q11 11 11.5 27.5T816-80q-11 13-28 12.5T759-80L641-200h39q0 33-23.5 56.5T600-120H120q-33 0-56.5-23.5T40-200Zm80 0h480v-32q0-14-4.5-19.5T580-266q-36-18-92.5-36T360-320q-71 0-127.5 18T140-266q-9 5-14.5 14t-5.5 20v32Zm240 0Zm560-400q0 69-24.5 131.5T829-355q-12 14-30 15t-32-13q-13-13-12-31t12-33q30-38 46.5-85t16.5-98q0-51-16.5-97T767-781q-12-15-12.5-33t12.5-32q13-14 31.5-13.5T829-845q42 51 66.5 113.5T920-600Zm-182 0q0 32-10 61.5T700-484q-11 15-29.5 15.5T638-482q-13-13-13.5-31.5T633-549q6-11 9.5-24t3.5-27q0-14-3.5-27t-9.5-25q-9-17-8.5-35t13.5-31q14-14 32.5-13.5T700-716q18 25 28 54.5t10 61.5Z"/></svg>`;
const languageIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="12" viewBox="0 -960 960 960" width="12" fill="#5f6368"><path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm0-82q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z"/></svg>`
const speakerIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="16px" style="vertical-align: text-bottom;" viewBox="0 -960 960 960" width="16px" fill="#5f6368"><path d="M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-240v-32q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v32q0 33-23.5 56.5T720-160H240q-33 0-56.5-23.5T160-240Zm80 0h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T560-640q0-33-23.5-56.5T480-720q-33 0-56.5 23.5T400-640q0 33 23.5 56.5T480-560Zm0-80Zm0 400Z"/></svg>`;

function getWaveStroke() {
  const styles = getComputedStyle(document.documentElement);
  const v = styles.getPropertyValue("--wave-stroke").trim();
  return v || "#000";
}

let waveStroke = getWaveStroke();
function updateWaveStroke() {
  waveStroke = getWaveStroke();
}

function applyTheme(pref) {
  if (pref === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else if (pref === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  updateWaveStroke();
}

// Persisted theme preference
const savedThemePref = localStorage.getItem("themePreference") || "system";
applyTheme(savedThemePref);
if (themeRadios.length) {
  themeRadios.forEach((r) => {
    r.checked = r.value === savedThemePref;
    r.addEventListener("change", () => {
      if (r.checked) {
        localStorage.setItem("themePreference", r.value);
        applyTheme(r.value);
      }
    });
  });
}

// React to OS theme changes when in "system" mode
const darkMq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
const handleOsThemeChange = () => {
  const pref = localStorage.getItem("themePreference") || "system";
  if (pref === "system") updateWaveStroke();
};
if (darkMq && darkMq.addEventListener) {
  darkMq.addEventListener("change", handleOsThemeChange);
} else if (darkMq && darkMq.addListener) {
  // deprecated, but included for Safari compatibility
  darkMq.addListener(handleOsThemeChange);
}

async function enumerateMicrophones() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    availableMicrophones = devices.filter(device => device.kind === 'audioinput');

    populateMicrophoneSelect();
    console.log(`Found ${availableMicrophones.length} microphone(s)`);
  } catch (error) {
    console.error('Error enumerating microphones:', error);
    statusText.textContent = "Error accessing microphones. Please grant permission.";
  }
}

function populateMicrophoneSelect() {
  if (!microphoneSelect) return;

  microphoneSelect.innerHTML = '<option value="">Default Microphone</option>';

  availableMicrophones.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    microphoneSelect.appendChild(option);
  });

  const savedMicId = localStorage.getItem('selectedMicrophone');
  if (savedMicId && availableMicrophones.some(mic => mic.deviceId === savedMicId)) {
    microphoneSelect.value = savedMicId;
    selectedMicrophoneId = savedMicId;
  }
}

function handleMicrophoneChange() {
  selectedMicrophoneId = microphoneSelect.value || null;
  localStorage.setItem('selectedMicrophone', selectedMicrophoneId || '');

  const selectedDevice = availableMicrophones.find(mic => mic.deviceId === selectedMicrophoneId);
  const deviceName = selectedDevice ? selectedDevice.label : 'Default Microphone';

  console.log(`Selected microphone: ${deviceName}`);
  statusText.textContent = `Microphone changed to: ${deviceName}`;

  if (isRecording) {
    statusText.textContent = "Switching microphone... Please wait.";
    stopRecording().then(() => {
      setTimeout(() => {
        toggleRecording();
      }, 1000);
    });
  }
}

// Helpers
function fmt1(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(1) : x;
}

function isSystemAudioSupported() {
  if (!isWebContext) return false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") return false;
  // Firefox and Safari implement getDisplayMedia but silently ignore the audio request.
  const ua = navigator.userAgent || "";
  const isFirefox = /Firefox\//i.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return !isFirefox && !isSafari;
}

async function getSystemAudioStream() {
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    const e = new Error("System audio sharing cancelled or denied.");
    e.code = "USER_CANCELLED";
    throw e;
  }
  displayStream.getVideoTracks().forEach((t) => {
    try { t.stop(); } catch (_) {}
  });
  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    const e = new Error('No audio in shared source. Re-share and tick "Share audio".');
    e.code = "NO_AUDIO_TRACK";
    throw e;
  }
  return new MediaStream(audioTracks);
}

// Server emits start/end as formatted strings ("H:MM:SS.cc") via Segment.to_dict
// in timed_objects.py. Parse back to seconds for keying, sorting, and timestamp
// formatting. Tolerant of numeric input for safety in tests / future callers.
function parseTimeSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parts = value.split(":");
  if (parts.length < 2) return Number(value) || 0;
  const sec = parseFloat(parts[parts.length - 1]) || 0;
  const min = parseInt(parts[parts.length - 2], 10) || 0;
  const hrs = parts.length >= 3 ? parseInt(parts[parts.length - 3], 10) || 0 : 0;
  return hrs * 3600 + min * 60 + sec;
}

function parseStartSeconds(line) {
  return line ? parseTimeSeconds(line.start) : 0;
}

function parseEndSeconds(line) {
  return line ? parseTimeSeconds(line.end) : 0;
}

// A zero-duration segment can leave two lines on the same start, which would
// collide in the start-keyed session map and silently drop one. Fold them into a
// single line so neither text is lost. Payload lines are ordered by start, so
// colliding lines are always adjacent.
function foldSameStartLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && parseStartSeconds(prev) === parseStartSeconds(line)) {
      const prevText = (prev.text || "").trim();
      const text = (line.text || "").trim();
      out[out.length - 1] = {
        ...line,
        text: prevText && text ? `${prevText} ${text}` : prevText || text,
        end: parseEndSeconds(prev) > parseEndSeconds(line) ? prev.end : line.end,
      };
    } else {
      out.push(line);
    }
  }
  return out;
}

function mergeSessionLines(incoming) {
  // Silence segments (speaker -2) are transient markers with no text; they are
  // not rendered and must never accumulate in the session transcript.
  const lines = foldSameStartLines(
    (incoming || []).filter((it) => it && it.speaker !== -2),
  );
  if (!lines.length) return;

  // The server rebuilds its whole line list on every update -- segments get
  // re-split and speakers get re-attributed as diarization catches up -- so the
  // payload is authoritative for the span it covers. Classify each retained line
  // against where that span begins:
  //
  //   start >= spanStart  inside the payload's span, so the server is
  //                       re-deriving it -- drop ours, the payload wins.
  //   start <  spanStart  either pruned away entirely, or head-cut -- ours is
  //                       the complete copy, keep it.
  //
  // The old rule keyed off `end > spanStart` instead, which cannot tell a
  // re-split apart from a head-cut and so deleted the full copy of every line
  // the server had begun to prune.
  //
  // retainedReach is how far into the payload our own lines already extend.
  // Retained lines never overlap each other, so only the one reaching furthest
  // forward can straddle spanStart -- tracking that single number is enough, and
  // avoids comparing every incoming line against the whole meeting.
  // Deleting the current key while iterating a Map is well defined.
  const spanStart = Math.min(...lines.map(parseStartSeconds));
  let retainedReach = -Infinity;
  for (const [key, line] of sessionLines) {
    if (parseStartSeconds(line) >= spanStart) sessionLines.delete(key);
    else retainedReach = Math.max(retainedReach, parseEndSeconds(line));
  }

  // A line whose head the server pruned comes back starting later and holding
  // only its tail -- ground down a token at a time until nothing but its final
  // "." is left. We hold that line whole and the remnant carries nothing new
  // (tokens_alignment.py caps line length below the retention window, so a line
  // is always published whole before its head can be cut). Admitting it would
  // duplicate text, and at ~20 payloads a second it would pile up.
  //
  // Only the FIRST line of a payload can be head-cut: the prune cutoff falls at
  // a single point in time, so every later line lies entirely after it and is
  // complete.
  //
  // It counts as a remnant only when a line we kept covers its whole span --
  // retainedReach is the furthest any of them reaches, and they all start before
  // it. Merely overlapping is not enough: as diarization settles the server
  // re-splits a span slightly differently, so boundaries jitter by a fraction of
  // a second in both directions. Treating that jitter as a head-cut discards
  // real text (measured on a real 18 min meeting: 73 words, plus 3 whole lines).
  const admitted =
    parseEndSeconds(lines[0]) <= retainedReach ? lines.slice(1) : lines;

  // Keyed by start time alone so a re-attributed segment replaces its earlier
  // self instead of forking into a second line under the new speaker.
  for (const line of admitted) {
    sessionLines.set(parseStartSeconds(line), line);
  }
}

function getSessionLinesArray() {
  return Array.from(sessionLines.values()).sort(
    (a, b) => parseStartSeconds(a) - parseStartSeconds(b),
  );
}

function resetSessionLines() {
  sessionLines.clear();
  renderedLines.clear();
  linesTranscriptDiv.innerHTML = "";
  emptyStateShown = false;
}

function formatTimestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "00:00";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function buildTranscriptText() {
  const lines = getSessionLinesArray();
  const out = [];
  for (const line of lines) {
    const text = (line.text || "").trim();
    if (!text) continue;
    const startSec = parseStartSeconds(line);
    const ts = Number.isFinite(startSec) ? `[${formatTimestamp(startSec)}] ` : "";
    const speaker = line.speaker && line.speaker > 0 ? `Speaker ${line.speaker}: ` : "";
    out.push(`${ts}${speaker}${text}`);
  }
  return out.join("\n");
}

function downloadTranscript() {
  let text = buildTranscriptText();
  let usedFallback = false;
  // Defensive fallback: if the session map happens to be empty (stale tab,
  // page refresh mid-session, etc.) but the DOM has rendered transcript
  // content, dump the visible text so the button still produces a file.
  if (!text && linesTranscriptDiv) {
    const dom = (linesTranscriptDiv.innerText || "").trim();
    if (dom && !dom.toLowerCase().startsWith("no audio detected")) {
      text = dom;
      usedFallback = true;
    }
  }
  if (!text) {
    statusText.textContent = "Nothing to download yet.";
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  statusText.textContent = usedFallback
    ? "Transcript downloaded (from rendered text)."
    : "Transcript downloaded.";
}

function detachSystemAudio() {
  if (systemAudioSourceNode) {
    try { systemAudioSourceNode.disconnect(); } catch (_) {}
    systemAudioSourceNode = null;
  }
  if (systemAudioStream) {
    const sysTrack = systemAudioStream.getAudioTracks()[0];
    if (sysTrack && systemTrackEndedHandler) {
      try { sysTrack.removeEventListener("ended", systemTrackEndedHandler); } catch (_) {}
    }
    systemAudioStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    systemAudioStream = null;
  }
  systemTrackEndedHandler = null;
}

let host, port, protocol;
port = 8000;
if (isExtension) {
    host = "localhost";
    protocol = "ws";
} else {
    host = window.location.hostname || "localhost";
    port = window.location.port;
    protocol = window.location.protocol === "https:" ? "wss" : "ws";
}
const defaultWebSocketUrl = `${protocol}://${host}${port ? ":" + port : ""}/asr`;

// Populate default caption and input
if (websocketDefaultSpan) websocketDefaultSpan.textContent = defaultWebSocketUrl;
websocketInput.value = defaultWebSocketUrl;
websocketUrl = defaultWebSocketUrl;

// Optional chunk selector (guard for presence)
if (chunkSelector) {
  chunkSelector.addEventListener("change", () => {
    chunkDuration = parseInt(chunkSelector.value);
  });
}

// WebSocket input change handling
websocketInput.addEventListener("change", () => {
  const urlValue = websocketInput.value.trim();
  if (!urlValue.startsWith("ws://") && !urlValue.startsWith("wss://")) {
    statusText.textContent = "Invalid WebSocket URL (must start with ws:// or wss://)";
    return;
  }
  websocketUrl = urlValue;
  statusText.textContent = "WebSocket URL updated. Ready to connect.";
});

// Build the final connection URL from the (user-editable) base websocketUrl
// plus per-session options as query params.
function buildWebSocketUrl() {
  let url;
  try {
    url = new URL(websocketUrl);
  } catch (_) {
    return websocketUrl;
  }
  const lang = languageSelect ? languageSelect.value : "auto";
  if (lang && lang !== "auto") {
    url.searchParams.set("language", lang);
  }
  if (diarizationToggle) {
    // Send explicitly so the checkbox can also turn diarization OFF on a
    // server started with --diarization.
    url.searchParams.set("diarization", diarizationToggle.checked ? "true" : "false");
  }
  return url.toString();
}

function setupWebSocket() {
  return new Promise((resolve, reject) => {
    try {
      websocket = new WebSocket(buildWebSocketUrl());
    } catch (error) {
      statusText.textContent = "Invalid WebSocket URL. Please check and try again.";
      reject(error);
      return;
    }

    websocket.onopen = () => {
      statusText.textContent = "Connected to server.";
      resolve();
    };

    websocket.onclose = () => {
      if (userClosing) {
        if (waitingForStop) {
          statusText.textContent = "Processing finalized or connection closed.";
          if (lastReceivedData) {
            // Render the whole session, not lastReceivedData.lines -- that is
            // only the server's ~5 min window, so using it here collapsed the
            // visible transcript to the last few minutes the moment a long
            // meeting ended. Mirrors the ready_to_stop path below.
            mergeSessionLines(lastReceivedData.lines || []);
            renderLinesWithBuffer(
              getSessionLinesArray(),
              lastReceivedData.buffer_diarization || "",
              lastReceivedData.buffer_transcription || "",
              lastReceivedData.buffer_translation || "",
              0,
              0,
              true
            );
          }
        }
      } else {
        statusText.textContent = "Disconnected from the WebSocket server. (Check logs if model is loading.)";
        if (isRecording) {
          stopRecording();
        }
      }
      isRecording = false;
      waitingForStop = false;
      userClosing = false;
      lastReceivedData = null;
      websocket = null;
      updateUI();
    };

    websocket.onerror = () => {
      statusText.textContent = "Error connecting to WebSocket.";
      reject(new Error("Error connecting to WebSocket"));
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "config") {
        serverUseAudioWorklet = !!data.useAudioWorklet;
        statusText.textContent = serverUseAudioWorklet
          ? "Connected. Using AudioWorklet (PCM)."
          : "Connected. Using MediaRecorder (WebM).";
        if (configReadyResolve) configReadyResolve();
        return;
      }

      // Ignore diff/snapshot messages — the default frontend uses full-state mode.
      // These are only sent when a client explicitly opts in via ?mode=diff.
      if (data.type === "diff" || data.type === "snapshot") {
        console.warn("Received diff-protocol message but frontend is in full mode; ignoring.", data.type);
        return;
      }

      if (data.type === "ready_to_stop") {
        console.log("Ready to stop received, finalizing display and closing WebSocket.");
        waitingForStop = false;

        if (lastReceivedData) {
          mergeSessionLines(lastReceivedData.lines || []);
          renderLinesWithBuffer(
            getSessionLinesArray(),
            lastReceivedData.buffer_diarization || "",
            lastReceivedData.buffer_transcription || "",
            lastReceivedData.buffer_translation || "",
            0,
            0,
            true
          );
        }
        statusText.textContent = "Finished processing audio! Ready to record again.";
        recordButton.disabled = false;

        if (websocket) {
          websocket.close();
        }
        return;
      }

      lastReceivedData = data;

      const {
        lines = [],
        buffer_transcription = "",
        buffer_diarization = "",
        buffer_translation = "",
        remaining_time_transcription = 0,
        remaining_time_diarization = 0,
        status = "active_transcription",
      } = data;

      mergeSessionLines(lines);

      renderLinesWithBuffer(
        getSessionLinesArray(),
        buffer_diarization,
        buffer_transcription,
        buffer_translation,
        remaining_time_diarization,
        remaining_time_transcription,
        false,
        status
      );
    };
  });
}

function renderLinesWithBuffer(
  lines,
  buffer_diarization,
  buffer_transcription,
  buffer_translation,
  remaining_time_diarization,
  remaining_time_transcription,
  isFinalizing = false,
  current_status = "active_transcription"
) {
  // Silence segments are hidden from the transcript entirely (they also never
  // enter sessionLines, but this render path can receive raw server lines).
  lines = (lines || []).filter((it) => it && it.speaker !== -2);
  // Don't wipe the transcript when the server reports no_audio_detected if we
  // already have content — the server prunes lines >5 min old, and during
  // silence the response can briefly contain no lines even mid-meeting.
  const hasContent = (lines && lines.length > 0) || (buffer_transcription && buffer_transcription.length > 0);
  if (current_status === "no_audio_detected" && !hasContent) {
    showEmptyState(
      "<p style='text-align: center; color: var(--muted); margin-top: 20px;'><em>No audio detected...</em></p>",
    );
    return;
  }

  // When there are no committed lines yet but buffer text exists (common with
  // slow backends like voxtral on MPS), render the buffer as a standalone line.
  const effectiveLines = (lines || []).length === 0 && (buffer_transcription || buffer_diarization)
    ? [{ speaker: 1, text: "" }]
    : (lines || []);

  // Measure before touching the DOM: if the reader has scrolled up to re-read
  // something, leave them there. Only follow the transcript when they are
  // already at the bottom.
  const transcriptContainer = document.querySelector('.transcript-container');
  const stickToBottom =
    !transcriptContainer ||
    transcriptContainer.scrollHeight -
      transcriptContainer.scrollTop -
      transcriptContainer.clientHeight <
      SCROLL_STICK_THRESHOLD_PX;

  reconcileLineNodes(effectiveLines, (item, isLast) =>
    buildLineHtml(item, isLast, {
      buffer_diarization,
      buffer_transcription,
      buffer_translation,
      remaining_time_diarization,
      remaining_time_transcription,
      isFinalizing,
    }),
  );

  if (transcriptContainer && stickToBottom) {
    transcriptContainer.scrollTo({ top: transcriptContainer.scrollHeight, behavior: "smooth" });
  }
}

function buildLineHtml(item, isLast, ctx) {
  const {
    buffer_diarization,
    buffer_transcription,
    buffer_translation,
    remaining_time_diarization,
    remaining_time_transcription,
    isFinalizing,
  } = ctx;

  let timeInfo = "";
  if (item.start !== undefined && item.end !== undefined) {
    timeInfo = ` ${item.start} - ${item.end}`;
  }

  let speakerLabel = "";
  if (item.speaker == 0 && !isFinalizing) {
    speakerLabel = `<span class='loading'><span class="spinner"></span><span id='timeInfo'><span class="loading-diarization-value">${fmt1(
      remaining_time_diarization
    )}</span> second(s) of audio are undergoing diarization</span></span>`;
  } else if (item.speaker !== 0) {
    const speakerNum = `<span class="speaker-badge">${item.speaker}</span>`;
    speakerLabel = `<span id="speaker">${speakerIcon}${speakerNum}<span id='timeInfo'>${timeInfo}</span></span>`;

    if (item.detected_language) {
      speakerLabel += `<span class="label_language">${languageIcon}<span>${item.detected_language}</span></span>`;
    }
  }

  let currentLineText = item.text || "";

  if (isLast) {
    if (!isFinalizing && item.speaker !== -2) {
        speakerLabel += `<span class="label_transcription"><span class="spinner"></span>Transcription lag <span id='timeInfo'><span class="lag-transcription-value">${fmt1(
          remaining_time_transcription
        )}</span>s</span></span>`;

      if (buffer_diarization && remaining_time_diarization) {
        speakerLabel += `<span class="label_diarization"><span class="spinner"></span>Diarization lag<span id='timeInfo'><span class="lag-diarization-value">${fmt1(
          remaining_time_diarization
        )}</span>s</span></span>`;
      }
    }

    if (buffer_diarization) {
      if (isFinalizing) {
        currentLineText +=
          (currentLineText.length > 0 && buffer_diarization.trim().length > 0 ? " " : "") + buffer_diarization.trim();
      } else {
        currentLineText += `<span class="buffer_diarization">${buffer_diarization}</span>`;
      }
    }
    if (buffer_transcription) {
      if (isFinalizing) {
        currentLineText +=
          (currentLineText.length > 0 && buffer_transcription.trim().length > 0 ? " " : "") +
          buffer_transcription.trim();
      } else {
        currentLineText += `<span class="buffer_transcription">${buffer_transcription}</span>`;
      }
    }
  }
  let translationContent = "";
  if (item.translation) {
    translationContent += item.translation.trim();
  }
  if (isLast && buffer_translation) {
    const bufferPiece = isFinalizing
      ? buffer_translation
      : `<span class="buffer_translation">${buffer_translation}</span>`;
    translationContent += translationContent ? `${bufferPiece}` : bufferPiece;
  }
  if (translationContent.trim().length > 0) {
    currentLineText += `
        <div>
            <div class="label_translation">
                ${translationIcon}
                <span class="translation_text">${translationContent}</span>
            </div>
        </div>`;
  }

  return currentLineText.trim().length > 0 || speakerLabel.length > 0
    ? `<p>${speakerLabel}<br/><div class='textcontent'>${currentLineText}</div></p>`
    : `<p>${speakerLabel}<br/></p>`;
}

// Update only the lines that actually changed.
//
// The transcript is the whole meeting and a payload lands ~20 times a second, so
// rebuilding every line's HTML (and re-parsing it into the DOM) made a long
// session progressively more sluggish. Lines outside the server's ~5 min window
// are never touched by mergeSessionLines, so their object identity is stable and
// they can be skipped with a single === -- the per-message work becomes
// proportional to what changed, not to how long the meeting has run.
function reconcileLineNodes(items, buildHtml) {
  clearEmptyState();

  const wanted = new Set();
  let previousNode = null;

  items.forEach((item, idx) => {
    const isLast = idx === items.length - 1;
    const key = parseStartSeconds(item);
    wanted.add(key);

    let entry = renderedLines.get(key);
    // The last line carries the live buffers and lag counters, so it is rebuilt
    // every time; the rest only when their data actually changed.
    if (!entry || entry.item !== item || entry.isLast !== isLast || isLast) {
      const html = buildHtml(item, isLast);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "transcript-line";
        el.innerHTML = html;
        entry = { el, html, item, isLast };
        renderedLines.set(key, entry);
      } else {
        if (entry.html !== html) {
          entry.el.innerHTML = html;
          entry.html = html;
        }
        entry.item = item;
        entry.isLast = isLast;
      }
    }

    const expected = previousNode ? previousNode.nextSibling : linesTranscriptDiv.firstChild;
    if (entry.el !== expected) linesTranscriptDiv.insertBefore(entry.el, expected);
    previousNode = entry.el;
  });

  for (const [key, entry] of Array.from(renderedLines)) {
    if (wanted.has(key)) continue;
    if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    renderedLines.delete(key);
  }
}

function showEmptyState(html) {
  renderedLines.clear();
  linesTranscriptDiv.innerHTML = html;
  emptyStateShown = true;
}

function clearEmptyState() {
  if (!emptyStateShown) return;
  linesTranscriptDiv.innerHTML = "";
  emptyStateShown = false;
}

function updateTimer() {
  if (!startTime) return;

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  timerElement.textContent = `${minutes}:${seconds}`;
}

function drawWaveform() {
  if (!analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(dataArray);

  waveCtx.clearRect(
    0,
    0,
    waveCanvas.width / (window.devicePixelRatio || 1),
    waveCanvas.height / (window.devicePixelRatio || 1)
  );
  waveCtx.lineWidth = 1;
  waveCtx.strokeStyle = waveStroke;
  waveCtx.beginPath();

  const sliceWidth = (waveCanvas.width / (window.devicePixelRatio || 1)) / bufferLength;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * (waveCanvas.height / (window.devicePixelRatio || 1))) / 2;

    if (i === 0) {
      waveCtx.moveTo(x, y);
    } else {
      waveCtx.lineTo(x, y);
    }

    x += sliceWidth;
  }

  waveCtx.lineTo(
    waveCanvas.width / (window.devicePixelRatio || 1),
    (waveCanvas.height / (window.devicePixelRatio || 1)) / 2
  );
  waveCtx.stroke();

  animationFrame = requestAnimationFrame(drawWaveform);
}

async function startRecording() {
  try {
    resetSessionLines();
    linesTranscriptDiv.innerHTML = "";
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      console.log("Error acquiring wake lock.");
    }

    let stream;
    
    // chromium extension. in the future, both chrome page audio and mic will be used
    if (isExtension) {
      try {
        stream = await new Promise((resolve, reject) => {
          chrome.tabCapture.capture({audio: true}, (s) => {
            if (s) {
              resolve(s);
            } else {
              reject(new Error('Tab capture failed or not available'));
            }
          });
        });
        
        try {
          outputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          audioSource = outputAudioContext.createMediaStreamSource(stream);
          audioSource.connect(outputAudioContext.destination);
        } catch (audioError) {
          console.warn('could not preserve system audio:', audioError);
        }
        
        statusText.textContent = "Using tab audio capture.";
      } catch (tabError) {
        console.log('Tab capture not available, falling back to microphone', tabError);
        const audioConstraints = selectedMicrophoneId
          ? { audio: { deviceId: { exact: selectedMicrophoneId } } }
          : { audio: true };
        stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
        statusText.textContent = "Using microphone audio.";
      }
    } else if (isWebContext) {
      const audioConstraints = selectedMicrophoneId
        ? { audio: { deviceId: { exact: selectedMicrophoneId } } }
        : { audio: true };
      stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    }

    if (systemAudioEnabled && isWebContext) {
      try {
        systemAudioStream = await getSystemAudioStream();
        const sysTrack = systemAudioStream.getAudioTracks()[0];
        systemTrackEndedHandler = () => {
          statusText.textContent = "System audio sharing ended; continuing with microphone.";
          detachSystemAudio();
        };
        sysTrack.addEventListener("ended", systemTrackEndedHandler);
        statusText.textContent = "Capturing microphone + system audio.";
      } catch (sysErr) {
        statusText.textContent = sysErr.message || "Could not capture system audio.";
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        if (wakeLock) {
          try { await wakeLock.release(); } catch (_) {}
          wakeLock = null;
        }
        console.warn("System audio capture failed:", sysErr);
        return;
      }
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    if (serverUseAudioWorklet) {
      if (!audioContext.audioWorklet) {
        throw new Error("AudioWorklet is not supported in this browser");
      }
      await audioContext.audioWorklet.addModule("/web/pcm_worklet.js");
      workletNode = new AudioWorkletNode(audioContext, "pcm-forwarder", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      microphone.connect(workletNode);

      if (systemAudioStream) {
        systemAudioSourceNode = audioContext.createMediaStreamSource(systemAudioStream);
        systemAudioSourceNode.connect(workletNode);
      }

      recorderWorker = new Worker("/web/recorder_worker.js");
      recorderWorker.postMessage({
        command: "init",
        config: {
          sampleRate: audioContext.sampleRate,
        },
      });

      recorderWorker.onmessage = (e) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(e.data.buffer);
        }
      };

      workletNode.port.onmessage = (e) => {
        const data = e.data;
        const ab = data instanceof ArrayBuffer ? data : data.buffer;
        recorderWorker.postMessage(
          {
            command: "record",
            buffer: ab,
          },
          [ab]
        );
      };
    } else {
      let recorderStream = stream;
      if (systemAudioStream) {
        const dest = audioContext.createMediaStreamDestination();
        microphone.connect(dest);
        systemAudioSourceNode = audioContext.createMediaStreamSource(systemAudioStream);
        systemAudioSourceNode.connect(dest);
        recorderStream = dest.stream;
      }
      try {
        recorder = new MediaRecorder(recorderStream, { mimeType: "audio/webm" });
      } catch (e) {
        recorder = new MediaRecorder(recorderStream);
      }
      recorder.ondataavailable = (e) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          if (e.data && e.data.size > 0) {
            websocket.send(e.data);
          }
        }
      };
      recorder.start(chunkDuration);
    }

    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    drawWaveform();

    isRecording = true;
    updateUI();
  } catch (err) {
    detachSystemAudio();
    if (window.location.hostname === "0.0.0.0") {
      statusText.textContent =
        "Error accessing microphone. Browsers may block microphone access on 0.0.0.0. Try using localhost:8000 instead.";
    } else {
      statusText.textContent = "Error accessing microphone. Please allow microphone access.";
    }
    console.error(err);
  }
}

async function stopRecording() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      // ignore
    }
    wakeLock = null;
  }

  userClosing = true;
  waitingForStop = true;

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    const emptyBlob = new Blob([], { type: "audio/webm" });
    websocket.send(emptyBlob);
    statusText.textContent = "Recording stopped. Processing final audio...";
  }

  if (recorder) {
    try {
      recorder.stop();
    } catch (e) {
    }
    recorder = null;
  }

  if (recorderWorker) {
    recorderWorker.terminate();
    recorderWorker = null;
  }
  
  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
    } catch (e) {}
    try {
      workletNode.disconnect();
    } catch (e) {}
    workletNode = null;
  }

  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }

  if (analyser) {
    analyser = null;
  }

  detachSystemAudio();

  if (audioContext && audioContext.state !== "closed") {
    try {
      await audioContext.close();
    } catch (e) {
      console.warn("Could not close audio context:", e);
    }
    audioContext = null;
  }

  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }

  if (outputAudioContext && outputAudioContext.state !== "closed") {
    outputAudioContext.close()
    outputAudioContext = null;
  }

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerElement.textContent = "00:00";
  startTime = null;

  isRecording = false;
  updateUI();
}

async function toggleRecording() {
  if (!isRecording) {
    if (waitingForStop) {
      console.log("Waiting for stop, early return");
      return;
    }
    console.log("Connecting to WebSocket");
    try {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        await configReady;
        await startRecording();
      } else {
        await setupWebSocket();
        await configReady;
        await startRecording();
      }
    } catch (err) {
      statusText.textContent = "Could not connect to WebSocket or access mic. Aborted.";
      console.error(err);
    }
  } else {
    console.log("Stopping recording");
    stopRecording();
  }
}

function updateUI() {
  recordButton.classList.toggle("recording", isRecording);
  recordButton.disabled = waitingForStop;

  if (waitingForStop) {
    if (statusText.textContent !== "Recording stopped. Processing final audio...") {
      statusText.textContent = "Please wait for processing to complete...";
    }
  } else if (isRecording) {
    statusText.textContent = "";
  } else {
    if (
      statusText.textContent !== "Finished processing audio! Ready to record again." &&
      statusText.textContent !== "Processing finalized or connection closed."
    ) {
      statusText.textContent = "Click to start transcription";
    }
  }
  if (!waitingForStop) {
    recordButton.disabled = false;
  }
}

recordButton.addEventListener("click", toggleRecording);

if (microphoneSelect) {
  microphoneSelect.addEventListener("change", handleMicrophoneChange);
}

if (systemAudioToggle) {
  if (!isSystemAudioSupported()) {
    systemAudioToggle.disabled = true;
    systemAudioToggle.checked = false;
    systemAudioEnabled = false;
    systemAudioToggle.title = "Capturing system audio requires Chrome or Edge on desktop.";
    if (systemAudioHint) {
      systemAudioHint.textContent = "Not supported in this browser";
    }
  } else {
    const saved = localStorage.getItem("systemAudioEnabled") === "1";
    systemAudioToggle.checked = saved;
    systemAudioEnabled = saved;
    systemAudioToggle.addEventListener("change", () => {
      systemAudioEnabled = !!systemAudioToggle.checked;
      localStorage.setItem("systemAudioEnabled", systemAudioEnabled ? "1" : "0");
    });
  }
}
if (languageSelect) {
  const savedLanguage = localStorage.getItem("languagePreference") || "auto";
  languageSelect.value = savedLanguage;
  if (languageSelect.value !== savedLanguage) languageSelect.value = "auto";
  languageSelect.addEventListener("change", () => {
    localStorage.setItem("languagePreference", languageSelect.value);
  });
}

if (diarizationToggle) {
  diarizationToggle.checked = localStorage.getItem("diarizationEnabled") === "1";
  diarizationToggle.addEventListener("change", () => {
    localStorage.setItem("diarizationEnabled", diarizationToggle.checked ? "1" : "0");
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await enumerateMicrophones();
  } catch (error) {
    console.log("Could not enumerate microphones on load:", error);
  }
});
// navigator.mediaDevices is undefined on insecure origins (e.g. reaching the
// server by LAN IP over plain HTTP), where an unguarded access would abort the
// rest of this script.
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    console.log('Device change detected, re-enumerating microphones');
    try {
      await enumerateMicrophones();
    } catch (error) {
      console.log("Error re-enumerating microphones:", error);
    }
  });
}


settingsToggle.addEventListener("click", () => {
settingsDiv.classList.toggle("visible");
settingsToggle.classList.toggle("active");
});

if (downloadButton) {
  downloadButton.addEventListener("click", downloadTranscript);
}

if (isExtension) {
  async function checkAndRequestPermissions() {
    const micPermission = await navigator.permissions.query({
      name: "microphone",
    });

    const permissionDisplay = document.getElementById("audioPermission");
    if (permissionDisplay) {
      permissionDisplay.innerText = `MICROPHONE: ${micPermission.state}`;
    }

    // if (micPermission.state !== "granted") {
    //   chrome.tabs.create({ url: "welcome.html" });
    // }

    const intervalId = setInterval(async () => {
      const micPermission = await navigator.permissions.query({
        name: "microphone",
      });
      if (micPermission.state === "granted") {
        if (permissionDisplay) {
          permissionDisplay.innerText = `MICROPHONE: ${micPermission.state}`;
        }
        clearInterval(intervalId);
      }
    }, 100);
  }

  void checkAndRequestPermissions();
}
