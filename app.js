const DB_NAME = "colorsafe-eye-ai";
const DB_VERSION = 1;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ITERATIONS = 310000;
const SESSION_KEY = "colorsafe-session";
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MEDIAPIPE_VERSION = "1.2.0";
const MEDIAPIPE_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const FACE_LANDMARKER_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const elements = Object.fromEntries([
  "account-name", "account-button", "image-input", "upload-zone", "upload-error",
  "open-camera", "choose-image", "camera-dialog", "camera-close",
  "camera-view", "camera-video", "camera-placeholder", "camera-error", "eye-tracking-status",
  "face-status", "eye-status", "eye-guide-left", "eye-guide-right", "take-photo",
  "triage-status", "triage-clinic-link", "triage-continue", "clinic-map-link", "calibration-open-camera", "sticker-status",
  "image-preview-wrap", "image-preview", "remove-image", "measurement-preview",
  "metric-r", "metric-g", "metric-b", "metric-l", "save-record", "report",
  "report-image", "report-image-status", "report-metrics", "report-save", "report-history", "report-new", "history-content",
  "report-risk-level", "eye-roi-metrics", "report-summary", "feature-sclera", "feature-redness", "feature-pupil", "feature-iris-rim",
  "feature-sclera-status", "feature-redness-status", "feature-pupil-status", "feature-iris-rim-status",
  "dataset-input", "dataset-status", "dataset-results",
  "history-refresh", "auth-dialog", "auth-form", "auth-close",
  "login-tab", "register-tab", "auth-title", "auth-intro", "auth-submit",
  "auth-error", "name-field", "display-name", "email", "password",
  "detail-dialog", "detail-close", "detail-body", "toast"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

let db;
let currentImage = null;
let currentMetrics = null;
let currentEyeFeatures = null;
let currentCalibration = null;
let currentReportImageUrl = null;
let triageAllowsCapture = false;
let imageSelectionId = 0;
let cameraStream = null;
let eyeTrackerWorker = null;
let eyeTrackerWorkerUrl = null;
let rejectEyeTrackerStartup = null;
let cameraFrameRequest = null;
let cameraRequestId = 0;
let lastCameraFrameAt = 0;
let lastVideoTime = -1;
let cameraFramePending = false;
let eyesDetected = false;
let authMode = "login";
let toastTimer;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("users")) {
        database.createObjectStore("users", { keyPath: "email" });
      }
      if (!database.objectStoreNames.contains("records")) {
        const records = database.createObjectStore("records", { keyPath: "id" });
        records.createIndex("ownerEmail", "ownerEmail", { unique: false });
        records.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("無法開啟本機資料庫。"));
    request.onblocked = () => reject(new Error("資料庫正在被其他分頁更新，請關閉重複分頁後重試。"));
  });
}

function storeRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("資料操作失敗。"));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("資料操作未完成。"));
  });
}

function activeUser() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function hashPassword(password, salt) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("此瀏覽器無法使用安全密碼雜湊，請改以 localhost 或 HTTPS 開啟網站。");
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

async function makePasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  return { salt: bytesToBase64(salt), passwordHash: bytesToBase64(hash) };
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function openNearbyEyeClinicMap() {
  const mapWindow = window.open("about:blank", "_blank");
  if (!mapWindow) {
    showToast("請允許此網站開啟新分頁，才能前往 Google 地圖。");
    return;
  }
  mapWindow.opener = null;
  mapWindow.document.title = "正在開啟 Google 地圖…";
  mapWindow.document.body.textContent = "正在取得目前位置，以搜尋附近眼科診所路線…";
  const searchUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("附近眼科診所");
  if (!navigator.geolocation) {
    mapWindow.location.replace(searchUrl);
    showToast("瀏覽器不支援定位，已改為開啟附近眼科診所搜尋。");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const origin = `${coords.latitude},${coords.longitude}`;
      const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent("眼科診所")}`;
      mapWindow.location.replace(directionsUrl);
    },
    () => {
      mapWindow.location.replace(searchUrl);
      showToast("無法取得目前位置，已開啟附近眼科診所搜尋；請確認地圖中的起點。");
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  elements.loginTab.classList.toggle("active", !isRegister);
  elements.registerTab.classList.toggle("active", isRegister);
  elements.loginTab.setAttribute("aria-selected", String(!isRegister));
  elements.registerTab.setAttribute("aria-selected", String(isRegister));
  elements.nameField.hidden = !isRegister;
  elements.displayName.required = isRegister;
  elements.password.autocomplete = isRegister ? "new-password" : "current-password";
  elements.authTitle.textContent = isRegister ? "建立本機帳號" : "歡迎回來";
  elements.authIntro.textContent = isRegister ? "建立帳號以保存並查看此瀏覽器中的影像紀錄。" : "登入以查看儲存在此瀏覽器的影像紀錄。";
  elements.authSubmit.textContent = isRegister ? "建立帳號" : "登入";
  elements.authError.textContent = "";
}

function openAuth(mode = "login") {
  setAuthMode(mode);
  elements.authForm.reset();
  elements.authError.textContent = "";
  elements.authDialog.showModal();
  elements.email.focus();
}

function renderAccount() {
  const user = activeUser();
  elements.accountName.textContent = user ? user.name : "";
  elements.accountButton.textContent = user ? "登出" : "登入 / 註冊";
  renderHistory().catch((error) => showToast(`無法讀取歷史紀錄：${error.message}`));
}

async function submitAuth(event) {
  event.preventDefault();
  elements.authError.textContent = "";
  const email = normalizeEmail(elements.email.value);
  const password = elements.password.value;

  try {
    if (authMode === "register") {
      const name = elements.displayName.value.trim();
      if (!name) throw new Error("請輸入顯示名稱。");
      if (password.length < 8) throw new Error("密碼至少需要 8 個字元。");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("請輸入有效的電子郵件地址。");
      if (await storeRequest("users", "readonly", (store) => store.get(email))) {
        throw new Error("此電子郵件已建立本機帳號，請直接登入。");
      }
      const passwordData = await makePasswordHash(password);
      await storeRequest("users", "readwrite", (store) => store.add({
        email,
        name,
        ...passwordData,
        createdAt: new Date().toISOString()
      }));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ email, name }));
    } else {
      const user = await storeRequest("users", "readonly", (store) => store.get(email));
      if (!user) throw new Error("找不到此本機帳號，請確認電子郵件或建立帳號。");
      const candidate = await hashPassword(password, base64ToBytes(user.salt));
      if (!sameBytes(candidate, base64ToBytes(user.passwordHash))) throw new Error("電子郵件或密碼不正確。");
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ email: user.email, name: user.name }));
    }

    elements.authDialog.close();
    elements.authForm.reset();
    renderAccount();
    showToast(authMode === "register" ? "本機帳號已建立。" : "已登入本機帳號。");
  } catch (error) {
    elements.authError.textContent = error.message || "帳號操作失敗，請重試。";
  }
}

function validateImage(file) {
  if (!file) throw new Error("請先選擇影像。");
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error("檔案格式不支援，請選擇 JPG、PNG 或 WebP。");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("影像大小不可超過 8 MB。");
  if (file.size === 0) throw new Error("影像檔案是空的，請重新選擇。");
}

function getTriageAnswers() {
  const answerFor = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || null;
  return {
    injury: answerFor("triage-injury"),
    contacts: answerFor("triage-contacts"),
    drops: answerFor("triage-drops")
  };
}

function updateTriageStatus() {
  const answers = getTriageAnswers();
  const unanswered = Object.values(answers).some((answer) => answer === null);
  triageAllowsCapture = !unanswered &&
    answers.injury === "no" &&
    answers.contacts === "no" &&
    answers.drops === "no";
  elements.triageClinicLink.hidden = answers.injury !== "yes";
  elements.triageContinue.disabled = !triageAllowsCapture;
  elements.triageStatus.classList.toggle("warning", !triageAllowsCapture);

  if (answers.injury === "yes") {
    elements.triageStatus.textContent = "近 3 個月內有眼傷或眼部手術，請停止拍攝，先聯絡眼科專業人員確認是否適合檢查。";
  } else if (answers.contacts === "yes") {
    elements.triageStatus.textContent = "請先取下隱形眼鏡；取下後重新回答本預檢，再進行拍攝。";
  } else if (answers.drops === "yes") {
    elements.triageStatus.textContent = "請於最後一次點眼藥水後等待滿 30 分鐘，再重新回答本預檢。";
  } else if (unanswered) {
    elements.triageStatus.textContent = "請完成三項回答；有任何一項符合時，請先依提示處理後再測。";
  } else {
    elements.triageStatus.classList.remove("warning");
    elements.triageStatus.textContent = "三項預檢皆無符合情況，可以繼續。此工具不取代眼科檢查。";
  }
}

function ensureTriageAllowsCapture() {
  updateTriageStatus();
  if (triageAllowsCapture) return true;
  document.getElementById("triage").scrollIntoView({ behavior: "smooth", block: "center" });
  elements.triageStatus.focus?.();
  return false;
}

function findRgbwSticker(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  const integral = [new Float64Array((width + 1) * (height + 1)), new Float64Array((width + 1) * (height + 1)), new Float64Array((width + 1) * (height + 1))];
  const stride = width + 1;
  for (let y = 1; y <= height; y += 1) {
    let rowR = 0;
    let rowG = 0;
    let rowB = 0;
    for (let x = 1; x <= width; x += 1) {
      const pixel = ((y - 1) * width + x - 1) * 4;
      rowR += data[pixel];
      rowG += data[pixel + 1];
      rowB += data[pixel + 2];
      const index = y * stride + x;
      const above = index - stride;
      integral[0][index] = integral[0][above] + rowR;
      integral[1][index] = integral[1][above] + rowG;
      integral[2][index] = integral[2][above] + rowB;
    }
  }

  const average = (x, y, size) => {
    const x1 = Math.max(0, Math.floor(x));
    const y1 = Math.max(0, Math.floor(y));
    const x2 = Math.min(width, Math.ceil(x + size));
    const y2 = Math.min(height, Math.ceil(y + size));
    const area = (x2 - x1) * (y2 - y1);
    if (!area) return [0, 0, 0];
    return integral.map((channel) => (
      channel[y2 * stride + x2] - channel[y1 * stride + x2] -
      channel[y2 * stride + x1] + channel[y1 * stride + x1]
    ) / area);
  };
  const classify = ([red, green, blue]) => ({
    red: (red - Math.max(green, blue)) / Math.max(red, 1),
    green: (green - Math.max(red, blue)) / Math.max(green, 1),
    blue: (blue - Math.max(red, green)) / Math.max(blue, 1),
    whiteNeutral: 1 - (Math.max(red, green, blue) - Math.min(red, green, blue)) / Math.max(red, green, blue, 1),
    whiteBrightness: Math.min(red, green, blue)
  });
  const patchLayouts = [
    ["red", "green", "blue", "white"],
    ["green", "red", "white", "blue"],
    ["blue", "white", "red", "green"],
    ["white", "blue", "green", "red"],
    ["red", "blue", "green", "white"],
    ["blue", "red", "white", "green"],
    ["green", "white", "red", "blue"],
    ["white", "green", "blue", "red"]
  ];

  let best = null;
  const maxCell = Math.floor(Math.min(width, height) / 2);
  for (let cell = 14; cell <= maxCell; cell += 2) {
    const positionStep = Math.max(2, Math.floor(cell / 4));
    const sampleOffset = cell * .25;
    const sampleSize = cell * .5;
    for (let y = 0; y + cell * 2 <= height; y += positionStep) {
      for (let x = 0; x + cell * 2 <= width; x += positionStep) {
        const patches = [
          average(x + sampleOffset, y + sampleOffset, sampleSize),
          average(x + cell + sampleOffset, y + sampleOffset, sampleSize),
          average(x + sampleOffset, y + cell + sampleOffset, sampleSize),
          average(x + cell + sampleOffset, y + cell + sampleOffset, sampleSize)
        ];
        const colors = patches.map(classify);
        for (const layout of patchLayouts) {
          const expected = layout.map((label, index) => ({ label, color: colors[index], patch: patches[index] }));
          const red = expected.find((patch) => patch.label === "red");
          const green = expected.find((patch) => patch.label === "green");
          const blue = expected.find((patch) => patch.label === "blue");
          const white = expected.find((patch) => patch.label === "white");
          if (red.color.red < .14 || green.color.green < .12 || blue.color.blue < .12 ||
              white.color.whiteNeutral < .76 || white.color.whiteBrightness < 75) continue;
          const score = red.color.red + green.color.green + blue.color.blue + white.color.whiteNeutral * .35;
          if (!best || score > best.score) best = { score, whitePatch: white.patch };
        }
      }
    }
  }
  return best;
}

function calibrateImageWithSticker(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = async () => {
      try {
        const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
        const scanCanvas = document.createElement("canvas");
        scanCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        scanCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
        if (!scanContext) throw new Error("瀏覽器無法分析校色貼紙。");
        scanContext.drawImage(image, 0, 0, scanCanvas.width, scanCanvas.height);
        const sticker = findRgbwSticker(scanContext, scanCanvas.width, scanCanvas.height);
        if (!sticker) {
          resolve({ image: file, calibration: { found: false, method: "none" } });
          return;
        }

        const white = sticker.whitePatch;
        const target = (white[0] + white[1] + white[2]) / 3;
        const gains = white.map((channel) => Math.min(1.5, Math.max(.67, target / Math.max(channel, 1))));
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("瀏覽器無法建立校色影像。");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let index = 0; index < pixels.data.length; index += 4) {
          pixels.data[index] = Math.min(255, pixels.data[index] * gains[0]);
          pixels.data[index + 1] = Math.min(255, pixels.data[index + 1] * gains[1]);
          pixels.data[index + 2] = Math.min(255, pixels.data[index + 2] * gains[2]);
        }
        context.putImageData(pixels, 0, 0);
        const blob = await new Promise((resolveBlob, rejectBlob) => {
          canvas.toBlob((result) => result
            ? resolveBlob(result)
            : rejectBlob(new Error("無法輸出貼紙校色影像。")), "image/jpeg", .95);
        });
        resolve({
          image: new File([blob], file.name.replace(/\.[^.]+$/, "") + "-balanced.jpg", { type: blob.type }),
          calibration: {
            found: true,
            method: "rgbw-white-balance",
            gains: gains.map((gain) => Number(gain.toFixed(3))),
            confidence: Number(sticker.score.toFixed(3))
          }
        });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("無法讀取影像以檢查校色貼紙。"));
    };
    image.src = objectUrl;
  });
}

function measureImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("瀏覽器無法讀取影像像素。");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let luminance = 0;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] === 0) continue;
          red += pixels[i];
          green += pixels[i + 1];
          blue += pixels[i + 2];
          luminance += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
          count += 1;
        }
        if (!count) throw new Error("影像沒有可量測的像素。");
        resolve({
          red: Math.round(red / count),
          green: Math.round(green / count),
          blue: Math.round(blue / count),
          luminance: Math.round(luminance / count)
        });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("無法讀取此影像，請換一個檔案。"));
    };
    image.src = objectUrl;
  });
}

function metricMarkup(metrics) {
  return [
    ["平均 R", metrics.red],
    ["平均 G", metrics.green],
    ["平均 B", metrics.blue],
    ["平均亮度", metrics.luminance]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function getRiskAssessment(metrics, eyeFeatures) {
  const baseScore = metrics ? 0 : 1;
  let riskScore = baseScore;
  if (!metrics) return { level: "gray", label: "未評估", detail: "尚未取得可量測影像。" };
  if (metrics.luminance < 65 || metrics.luminance > 220) riskScore += 1;
  if (metrics.red > 180 && metrics.green < 170) riskScore += 1.2;
  if (eyeFeatures?.sclera) {
    if (eyeFeatures.sclera.redGreenRatio > 1.12) riskScore += 1.4;
    if (eyeFeatures.sclera.labB > 18) riskScore += 1.1;
  }
  if (eyeFeatures?.irisRim && eyeFeatures.irisRim.labB > 18) riskScore += 0.8;
  if (eyeFeatures?.pupil && eyeFeatures.pupil.labL < 14) riskScore += 0.6;
  if (riskScore >= 3.8) return { level: "red", label: "高風險", detail: "出現多項明顯異常訊號，請優先與眼科專業人員確認。" };
  if (riskScore >= 2.2) return { level: "yellow", label: "中風險", detail: "有偏高的異常訊號，建議再檢視拍攝條件與紀錄。" };
  return { level: "green", label: "低風險", detail: "目前數值較穩定，未出現明顯異常趨勢。" };
}

function updateReportRiskLevel(metrics, eyeFeatures) {
  const assessment = getRiskAssessment(metrics, eyeFeatures);
  const dots = document.querySelectorAll(".risk-dot");
  dots.forEach((dot) => dot.classList.remove("active"));
  const activeMap = {
    green: ".risk-green",
    yellow: ".risk-yellow",
    red: ".risk-red",
    gray: ""
  };
  if (assessment.level !== "gray") {
    const activeClass = activeMap[assessment.level];
    const targeted = document.querySelector(activeClass);
    if (targeted) targeted.classList.add("active");
  }

  const reportLevel = document.querySelector(".report-level");
  if (reportLevel) {
    reportLevel.classList.remove("risk-green", "risk-yellow", "risk-red", "risk-gray");
    if (assessment.level !== "gray") reportLevel.classList.add(`risk-${assessment.level}`);
  }

  const summaryCard = document.querySelector(".result-summary-card");
  if (summaryCard) {
    summaryCard.classList.remove("risk-green", "risk-yellow", "risk-red", "risk-gray");
    if (assessment.level !== "gray") summaryCard.classList.add(`risk-${assessment.level}`);
  }

  elements.reportRiskLevel.textContent = assessment.level === "gray" ? "未評估" : assessment.label;
  const summaryText = assessment.level === "gray" ? "目前尚未生成風險分級。" : assessment.detail;
  const riskLabel = document.getElementById("result-summary-title");
  if (riskLabel) {
    riskLabel.textContent = assessment.level === "gray"
      ? "本原型不提供疾病風險分級"
      : `紅綠燈風險分級：${assessment.label}`;
  }
  const reportSummary = document.getElementById("report-summary");
  if (reportSummary) {
    reportSummary.textContent = summaryText;
  }
  const pill = document.querySelector(".result-status-pill");
  if (pill) {
    pill.textContent = assessment.level === "gray" ? "未判讀" : assessment.label;
    pill.classList.remove("status-green", "status-yellow", "status-red");
    if (assessment.level !== "gray") pill.classList.add(`status-${assessment.level}`);
  }
}

function showUploadError(message = "") {
  elements.uploadError.textContent = message;
}

function eyeTrackerWorkerSource() {
  return `
    importScripts("${MEDIAPIPE_CDN}/vision_bundle.js");
    const { FaceLandmarker, FilesetResolver } = Vision;

    const modelUrl = "${FACE_LANDMARKER_MODEL}";
    const wasmUrl = "${MEDIAPIPE_CDN}/wasm";
    const eyeLandmarks = [
      { contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], irisCenter: 468, irisRing: [468, 469, 470, 471, 472] },
      { contour: [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398], irisCenter: 473, irisRing: [473, 474, 475, 476, 477] }
    ];
    let landmarker;

    function getBounds(points) {
      if (points.some((point) =>
        !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      )) return null;
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return { left, top, width: right - left, height: bottom - top };
    }

    function getEyeRegion(landmarks, definition) {
      const aperture = getBounds(definition.contour.map((index) => landmarks[index]));
      const irisCenter = landmarks[definition.irisCenter];
      const irisBounds = getBounds(definition.irisRing.map((index) => landmarks[index]));
      if (!aperture || !irisBounds || !irisCenter ||
          !Number.isFinite(irisCenter.x) || !Number.isFinite(irisCenter.y) ||
          aperture.width < .018 || aperture.height < .006) return null;
      return {
        ...aperture,
        iris: { x: irisCenter.x, y: irisCenter.y },
        irisBounds
      };
    }

    self.onmessage = async ({ data }) => {
      if (data.type === "initialize") {
        try {
          const vision = await FilesetResolver.forVisionTasks(wasmUrl);
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: .6,
            minFacePresenceConfidence: .6,
            minTrackingConfidence: .6
          });
          self.postMessage({ type: "ready" });
        } catch (error) {
          self.postMessage({ type: "error", message: error.message || "眼部追蹤模型載入失敗。" });
        }
        return;
      }

      if (data.type === "frame" && landmarker) {
        try {
          const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
          const landmarks = result.faceLandmarks?.[0];
          const eyes = landmarks ? eyeLandmarks.map((definition) => getEyeRegion(landmarks, definition)) : [];
          const detected = eyes.length === 2 && eyes.every(Boolean) &&
            Math.abs((eyes[0].left + eyes[0].width / 2) - (eyes[1].left + eyes[1].width / 2)) > .035;
          self.postMessage({ type: "tracking", facePresent: Boolean(landmarks), detected, eyes: detected ? eyes : [] });
        } catch (error) {
          self.postMessage({ type: "error", message: error.message || "眼部追蹤發生錯誤。" });
        } finally {
          data.bitmap.close();
        }
      }
    };
  `;
}

async function detectImageEyes(file) {
  const blobUrl = URL.createObjectURL(new Blob([eyeTrackerWorkerSource()], { type: "text/javascript" }));
  let worker;
  try {
    worker = new Worker(blobUrl);
    return await new Promise((resolve, reject) => {
      let initialized = false;
      worker.onmessage = async ({ data }) => {
        if (data.type === "ready" && !initialized) {
          initialized = true;
          try {
            const bitmap = await createImageBitmap(file);
            worker.postMessage({ type: "frame", bitmap, timestamp: performance.now() }, [bitmap]);
          } catch (error) {
            reject(new Error(`無法準備眼部影像：${error.message || "請重試。"}`));
          }
        } else if (data.type === "tracking") {
          resolve(data.detected ? data.eyes : null);
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || "眼部追蹤工作執行緒無法啟動。"));
      worker.postMessage({ type: "initialize" });
    });
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(blobUrl);
  }
}

function createEyeFocusedPreview(file, eyes) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const imageUrl = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        const eyeLeft = Math.min(...eyes.map((eye) => eye.left));
        const eyeRight = Math.max(...eyes.map((eye) => eye.left + eye.width));
        const eyeTop = Math.min(...eyes.map((eye) => eye.top));
        const eyeBottom = Math.max(...eyes.map((eye) => eye.top + eye.height));
        const centerX = ((eyeLeft + eyeRight) / 2) * width;
        const centerY = ((eyeTop + eyeBottom) / 2) * height;
        const cropWidth = Math.min(width, Math.max((eyeRight - eyeLeft) * width * 1.55, width * .18));
        const cropHeight = Math.min(height, cropWidth / 1.78);
        const sourceX = Math.max(0, Math.min(width - cropWidth, centerX - cropWidth / 2));
        const sourceY = Math.max(0, Math.min(height - cropHeight, centerY - cropHeight / 2));
        const scale = Math.min(1, 1600 / cropWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(cropWidth * scale));
        canvas.height = Math.max(1, Math.round(cropHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("瀏覽器無法建立眼部放大影像。");
        context.drawImage(image, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);

        const markerScale = canvas.width / cropWidth;
        eyes.forEach((eye) => {
          const x = eye.iris.x * width;
          const y = eye.iris.y * height;
          const px = (x - sourceX) * markerScale;
          const py = (y - sourceY) * markerScale;
          const radiusX = Math.max(12, eye.irisBounds.width * width * markerScale / 2);
          const radiusY = Math.max(12, eye.irisBounds.height * height * markerScale / 2);
          const bracketX = radiusX * 1.4;
          const bracketY = radiusY * 1.4;
          context.save();
          context.strokeStyle = "#00e9f6";
          context.lineWidth = Math.max(2, canvas.width / 500);
          context.shadowColor = "#00e9f6";
          context.shadowBlur = 9;
          context.beginPath();
          context.ellipse(px, py, radiusX, radiusY, 0, 0, Math.PI * 2);
          context.moveTo(px - radiusX * 1.5, py);
          context.lineTo(px + radiusX * 1.5, py);
          context.moveTo(px, py - radiusY * 1.5);
          context.lineTo(px, py + radiusY * 1.5);
          context.stroke();
          context.beginPath();
          context.moveTo(px - bracketX, py - bracketY);
          context.lineTo(px - bracketX * .45, py - bracketY);
          context.moveTo(px - bracketX, py - bracketY);
          context.lineTo(px - bracketX, py - bracketY * .45);
          context.moveTo(px + bracketX, py - bracketY);
          context.lineTo(px + bracketX * .45, py - bracketY);
          context.moveTo(px + bracketX, py - bracketY);
          context.lineTo(px + bracketX, py - bracketY * .45);
          context.moveTo(px - bracketX, py + bracketY);
          context.lineTo(px - bracketX * .45, py + bracketY);
          context.moveTo(px - bracketX, py + bracketY);
          context.lineTo(px - bracketX, py + bracketY * .45);
          context.moveTo(px + bracketX, py + bracketY);
          context.lineTo(px + bracketX * .45, py + bracketY);
          context.moveTo(px + bracketX, py + bracketY);
          context.lineTo(px + bracketX, py + bracketY * .45);
          context.stroke();
          context.restore();
        });

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("無法建立眼部放大影像。"));
            return;
          }
          resolve(URL.createObjectURL(blob));
        }, "image/jpeg", .94);
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("無法讀取此影像以建立眼部預覽。"));
    };
    image.src = imageUrl;
  });
}

function rgbToLab(red, green, blue) {
  const linearize = (value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  };
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const x = (r * .4124564 + g * .3575761 + b * .1804375) / .95047;
  const y = r * .2126729 + g * .7151522 + b * .072175;
  const z = (r * .0193339 + g * .119192 + b * .9503041) / 1.08883;
  const pivot = (value) => value > .008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function describePixels(pixels) {
  if (!pixels.length) return null;
  let red = 0;
  let green = 0;
  let blue = 0;
  let hueSin = 0;
  let hueCos = 0;
  let saturation = 0;
  let labL = 0;
  let labA = 0;
  let labB = 0;
  let redGreenRatio = 0;
  for (const [r, g, b] of pixels) {
    red += r;
    green += g;
    blue += b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    hueSin += Math.sin(hue * Math.PI / 180);
    hueCos += Math.cos(hue * Math.PI / 180);
    saturation += max ? delta / max : 0;
    const lab = rgbToLab(r, g, b);
    labL += lab.l;
    labA += lab.a;
    labB += lab.b;
    redGreenRatio += r / Math.max(g, 1);
  }
  const count = pixels.length;
  return {
    count,
    red: red / count,
    green: green / count,
    blue: blue / count,
    hue: (Math.atan2(hueSin / count, hueCos / count) * 180 / Math.PI + 360) % 360,
    saturation: saturation / count * 100,
    labL: labL / count,
    labA: labA / count,
    labB: labB / count,
    redGreenRatio: redGreenRatio / count
  };
}

function analyzeEyeRegions(file, eyes) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const imageUrl = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("瀏覽器無法讀取眼部區域像素。");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
        const regions = { sclera: [], irisRim: [], pupil: [] };
        const isInside = (nx, ny, bounds) =>
          nx >= bounds.left && nx <= bounds.left + bounds.width &&
          ny >= bounds.top && ny <= bounds.top + bounds.height;

        for (const eye of eyes) {
          const iris = eye.irisBounds;
          const apertureLeft = eye.left;
          const apertureRight = eye.left + eye.width;
          const centerY = eye.iris.y;
          const scleraTop = Math.max(eye.top, centerY - iris.height * .58);
          const scleraBottom = Math.min(eye.top + eye.height, centerY + iris.height * .58);
          const irisLeft = iris.left;
          const irisRight = iris.left + iris.width;
          const scleraAreas = [
            { left: apertureLeft + eye.width * .08, top: scleraTop, width: Math.max(0, irisLeft - apertureLeft - eye.width * .1), height: scleraBottom - scleraTop },
            { left: irisRight + eye.width * .1, top: scleraTop, width: Math.max(0, apertureRight - irisRight - eye.width * .18), height: scleraBottom - scleraTop }
          ];
          const pixelBounds = (bounds) => ({
            left: Math.max(0, Math.floor(bounds.left * width)),
            right: Math.min(width, Math.ceil((bounds.left + bounds.width) * width)),
            top: Math.max(0, Math.floor(bounds.top * height)),
            bottom: Math.min(height, Math.ceil((bounds.top + bounds.height) * height))
          });
          for (const area of scleraAreas) {
            if (area.width <= 0 || area.height <= 0) continue;
            const box = pixelBounds(area);
            for (let y = box.top; y < box.bottom; y += 2) {
              for (let x = box.left; x < box.right; x += 2) {
                const index = (y * width + x) * 4;
                if (data[index + 3] < 200) continue;
                const nx = (x + .5) / width;
                const ny = (y + .5) / height;
                if (!isInside(nx, ny, eye) || isInside(nx, ny, iris)) continue;
                regions.sclera.push([data[index], data[index + 1], data[index + 2]]);
              }
            }
          }

          const irisBox = pixelBounds(iris);
          for (let y = irisBox.top; y < irisBox.bottom; y += 2) {
            for (let x = irisBox.left; x < irisBox.right; x += 2) {
              const nx = (x + .5) / width;
              const ny = (y + .5) / height;
              const dx = (nx - eye.iris.x) / Math.max(iris.width * .5, .001);
              const dy = (ny - eye.iris.y) / Math.max(iris.height * .5, .001);
              const radius = dx * dx + dy * dy;
              const index = (y * width + x) * 4;
              if (data[index + 3] < 200) continue;
              if (radius >= .58 && radius <= 1) {
                regions.irisRim.push([data[index], data[index + 1], data[index + 2]]);
              } else if (radius <= .16) {
                regions.pupil.push([data[index], data[index + 1], data[index + 2]]);
              }
            }
          }
        }

        resolve({
          sclera: describePixels(regions.sclera),
          irisRim: describePixels(regions.irisRim),
          pupil: describePixels(regions.pupil)
        });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("無法讀取眼部區域進行取樣。"));
    };
    image.src = imageUrl;
  });
}

function formatFeature(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function eyeFeatureMetricsMarkup(features) {
  if (!features) return `<p>這筆紀錄沒有眼部 ROI 特徵；未作疾病判讀。</p>`;
  const { sclera, irisRim, pupil } = features;
  return [
    ["眼白 ROI · RGB", `${formatFeature(sclera?.red, 0)} / ${formatFeature(sclera?.green, 0)} / ${formatFeature(sclera?.blue, 0)}`],
    ["眼白 ROI · HSV H° / S%", `${formatFeature(sclera?.hue, 0)}° / ${formatFeature(sclera?.saturation)}`],
    ["眼白 ROI · CIELAB L* a* b*", `${formatFeature(sclera?.labL)} / ${formatFeature(sclera?.labA)} / ${formatFeature(sclera?.labB)}`],
    ["虹膜周邊 · CIELAB L* a* b*", `${formatFeature(irisRim?.labL)} / ${formatFeature(irisRim?.labA)} / ${formatFeature(irisRim?.labB)}`],
    ["眼虹膜中心 ROI · CIELAB L*", formatFeature(pupil?.labL)]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function updateEyeFeatures(features) {
  currentEyeFeatures = features;
  const { sclera, irisRim, pupil } = features || {};
  elements.featureScleraStatus.textContent = sclera ? "已量測" : "未評估";
  elements.featureRednessStatus.textContent = sclera ? "已量測" : "未評估";
  elements.featurePupilStatus.textContent = pupil ? "已量測" : "未評估";
  elements.featureIrisRimStatus.textContent = irisRim ? "已量測" : "未評估";
  if (!features) {
    elements.reportSummary.textContent = "未能可靠定位眼部 ROI；無法計算區域特徵，疾病項目維持未判讀。";
    elements.featureSclera.textContent = "無法定位／取樣眼白 ROI；未作疾病判讀。";
    elements.featureRedness.textContent = "無法定位／取樣眼表 ROI；未作疾病判讀。";
    elements.featurePupil.textContent = "無法定位／取樣瞳孔中心 ROI；未作疾病判讀。";
    elements.featureIrisRim.textContent = "無法定位／取樣虹膜周邊 ROI；未作疾病判讀。";
    elements.eyeRoiMetrics.innerHTML = `<p>未取得可量測的眼部區域。疾病項目維持未判讀。</p>`;
    updateReportRiskLevel(currentMetrics, null);
    return;
  }
  const measuredRegions = [sclera, irisRim, pupil].filter(Boolean).length;
  elements.reportSummary.textContent = measuredRegions
    ? `已取得 ${measuredRegions} 類眼部 ROI 的影像特徵；數值受光線、曝光與相機影響，並非疾病判讀。`
    : "眼部 ROI 取樣不足；疾病項目維持未判讀。";
  elements.featureSclera.textContent = sclera
    ? `眼白 ROI Lab b* ${formatFeature(sclera.labB)}；${sclera.count} 個取樣點，非黃疸判讀。`
    : "眼白 ROI 取樣不足；未作疾病判讀。";
  elements.featureRedness.textContent = sclera
    ? `眼白 ROI R/G ${formatFeature(sclera.redGreenRatio, 2)}；非結膜炎判讀。`
    : "眼白 ROI 取樣不足；未作疾病判讀。";
  elements.featurePupil.textContent = pupil
    ? `中心 ROI Lab L* ${formatFeature(pupil.labL)}；受反光及曝光影響，非白內障判讀。`
    : "瞳孔中心 ROI 取樣不足；未作疾病判讀。";
  elements.featureIrisRim.textContent = irisRim
    ? `虹膜周邊 Lab L* ${formatFeature(irisRim.labL)}、b* ${formatFeature(irisRim.labB)}；非角膜老年環判讀。`
    : "虹膜周邊 ROI 取樣不足；未作疾病判讀。";
  elements.eyeRoiMetrics.innerHTML = eyeFeatureMetricsMarkup(features);
  updateReportRiskLevel(currentMetrics, features);
}

async function selectImage(file) {
  if (!ensureTriageAllowsCapture()) return;
  const selectionId = ++imageSelectionId;
  showUploadError("");
  try {
    validateImage(file);
    const calibratedImage = await calibrateImageWithSticker(file);
    if (selectionId !== imageSelectionId) return;
    const analysisImage = calibratedImage.image;
    const metrics = await measureImage(analysisImage);
    if (selectionId !== imageSelectionId) return;
    let reportPreviewUrl;
    let reportImageStatus;
    let eyeFeatures = null;
    try {
      const eyes = await detectImageEyes(analysisImage);
      if (selectionId !== imageSelectionId) return;
      if (eyes) {
        try {
          eyeFeatures = await analyzeEyeRegions(analysisImage, eyes);
          if (selectionId !== imageSelectionId) return;
          reportImageStatus = "已定位雙眼並完成 ROI 特徵取樣，顯示放大眼部影像。";
        } catch (error) {
          if (selectionId !== imageSelectionId) return;
          reportImageStatus = `雙眼已定位，但 ROI 特徵取樣失敗：${error.message}`;
        }
        reportPreviewUrl = await createEyeFocusedPreview(analysisImage, eyes);
      } else {
        reportImageStatus = `未偵測到雙眼，以下顯示${calibratedImage.calibration.found ? "貼紙白平衡校正後的" : "原始"}影像。`;
      }
    } catch (error) {
      if (selectionId !== imageSelectionId) return;
      reportImageStatus = `無法定位雙眼，以下顯示${calibratedImage.calibration.found ? "貼紙白平衡校正後的" : "原始"}影像：${error.message}`;
    }
    if (selectionId !== imageSelectionId) {
      if (reportPreviewUrl) URL.revokeObjectURL(reportPreviewUrl);
      return;
    }
    if (currentImage?.url) URL.revokeObjectURL(currentImage.url);
    if (currentReportImageUrl) URL.revokeObjectURL(currentReportImageUrl);
    currentImage = {
      blob: file,
      analysisBlob: analysisImage,
      name: file.name,
      type: file.type,
      calibration: calibratedImage.calibration,
      url: URL.createObjectURL(analysisImage)
    };
    currentReportImageUrl = reportPreviewUrl;
    currentMetrics = metrics;
    currentCalibration = calibratedImage.calibration;
    updateEyeFeatures(eyeFeatures);
    elements.stickerStatus.textContent = calibratedImage.calibration.found
      ? "已偵測 RGBW 貼紙，已用白色色塊估算白平衡；這是簡易影像校正，非色彩或醫療校準。"
      : "未可靠偵測 RGBW 貼紙；已繼續使用未校正原圖分析。請確認貼紙清晰、完整入鏡且無反光。";
    elements.imagePreview.src = currentImage.url;
    elements.imagePreviewWrap.hidden = false;
    elements.uploadZone.hidden = true;
    elements.measurementPreview.hidden = false;
    elements.metricR.textContent = metrics.red;
    elements.metricG.textContent = metrics.green;
    elements.metricB.textContent = metrics.blue;
    elements.metricL.textContent = metrics.luminance;
    elements.saveRecord.disabled = false;
    elements.reportImage.src = currentReportImageUrl || currentImage.url;
    elements.reportImageStatus.textContent = `${calibratedImage.calibration.found ? "已估算 RGBW 貼紙白平衡。" : "未偵測到貼紙，使用原始色彩。"} ${reportImageStatus}`;
    elements.reportMetrics.innerHTML = metricMarkup(metrics);
    updateReportRiskLevel(metrics, eyeFeatures);
    elements.report.hidden = false;
    elements.report.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showUploadError(error.message || "影像處理失敗，請重試。");
  } finally {
    elements.imageInput.value = "";
  }
}

function stopCamera() {
  cameraRequestId += 1;
  if (rejectEyeTrackerStartup) {
    rejectEyeTrackerStartup(new Error("相機已關閉。"));
    rejectEyeTrackerStartup = null;
  }
  if (cameraFrameRequest !== null) {
    cancelAnimationFrame(cameraFrameRequest);
    cameraFrameRequest = null;
  }
  if (eyeTrackerWorker) {
    eyeTrackerWorker.terminate();
    eyeTrackerWorker = null;
  }
  if (eyeTrackerWorkerUrl) {
    URL.revokeObjectURL(eyeTrackerWorkerUrl);
    eyeTrackerWorkerUrl = null;
  }
  cameraFramePending = false;
  eyesDetected = false;
  elements.faceStatus.textContent = "等待";
  elements.eyeStatus.textContent = "等待";
  elements.faceStatus.classList.remove("ready");
  elements.eyeStatus.classList.remove("ready");
  elements.eyeTrackingStatus.textContent = "等待相機啟動";
  [elements.eyeGuideLeft, elements.eyeGuideRight].forEach((guide) => {
    guide.hidden = true;
    guide.classList.remove("detected");
  });
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  elements.cameraVideo.srcObject = null;
  elements.cameraView.style.aspectRatio = "4 / 3";
  elements.takePhoto.disabled = true;
  elements.cameraPlaceholder.hidden = false;
}

function createEyeTrackerWorker() {
  const source = eyeTrackerWorkerSource();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  eyeTrackerWorkerUrl = blobUrl;
  try {
    eyeTrackerWorker = new Worker(blobUrl);
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    eyeTrackerWorkerUrl = null;
    throw error;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectStartup = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    rejectEyeTrackerStartup = rejectStartup;
    eyeTrackerWorker.onmessage = (event) => {
      if (event.data.type === "ready") {
        if (settled) return;
        settled = true;
        rejectEyeTrackerStartup = null;
        if (eyeTrackerWorkerUrl) {
          URL.revokeObjectURL(eyeTrackerWorkerUrl);
          eyeTrackerWorkerUrl = null;
        }
        resolve(eyeTrackerWorker);
      } else if (event.data.type === "tracking") {
        cameraFramePending = false;
        updateEyeTracking(event.data);
      } else if (event.data.type === "error") {
        if (!settled) {
          rejectStartup(new Error(event.data.message));
        } else {
          cameraFramePending = false;
          stopCamera();
          elements.cameraError.textContent = `眼部追蹤發生錯誤：${event.data.message}`;
          elements.eyeTrackingStatus.textContent = "無法使用眼部追蹤";
        }
      }
    };
    eyeTrackerWorker.onerror = (event) => {
      const error = new Error(event.message || "眼部追蹤工作執行緒無法啟動。");
      if (!settled) rejectStartup(error);
      else {
        stopCamera();
        elements.cameraError.textContent = `眼部追蹤發生錯誤：${error.message}`;
        elements.eyeTrackingStatus.textContent = "無法使用眼部追蹤";
      }
    };
    eyeTrackerWorker.postMessage({ type: "initialize" });
  });
}

function mapVideoBoundsToView(bounds, videoWidth, videoHeight, viewWidth, viewHeight) {
  const scale = Math.min(viewWidth / videoWidth, viewHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (viewWidth - renderedWidth) / 2;
  const offsetY = (viewHeight - renderedHeight) / 2;
  return {
    left: (offsetX + bounds.left * renderedWidth) / viewWidth,
    top: (offsetY + bounds.top * renderedHeight) / viewHeight,
    width: bounds.width * renderedWidth / viewWidth,
    height: bounds.height * renderedHeight / viewHeight
  };
}

function positionEyeGuide(guide, bounds) {
  const view = elements.cameraView.getBoundingClientRect();
  const video = elements.cameraVideo;
  const mappedBounds = mapVideoBoundsToView(bounds, video.videoWidth, video.videoHeight, view.width, view.height);
  guide.style.left = `${mappedBounds.left * 100}%`;
  guide.style.top = `${mappedBounds.top * 100}%`;
  guide.style.width = `${mappedBounds.width * 100}%`;
  guide.style.height = `${mappedBounds.height * 100}%`;
  guide.hidden = false;
  guide.classList.add("detected");
}

function updateEyeTracking(result) {
  eyesDetected = Boolean(result.detected);
  elements.faceStatus.textContent = result.facePresent ? "OK" : "等待";
  elements.eyeStatus.textContent = eyesDetected ? "OK" : "等待";
  elements.faceStatus.classList.toggle("ready", Boolean(result.facePresent));
  elements.eyeStatus.classList.toggle("ready", eyesDetected);

  if (eyesDetected) {
    positionEyeGuide(elements.eyeGuideLeft, result.eyes[0]);
    positionEyeGuide(elements.eyeGuideRight, result.eyes[1]);
    elements.eyeTrackingStatus.textContent = "已偵測到雙眼，可以拍攝。";
  } else {
    [elements.eyeGuideLeft, elements.eyeGuideRight].forEach((guide) => {
      guide.hidden = true;
      guide.classList.remove("detected");
    });
    elements.eyeTrackingStatus.textContent = result.facePresent
      ? "已偵測到臉部，請正視鏡頭並讓雙眼清晰可見。"
      : "尚未偵測到臉部，請將臉部完整對準鏡頭。";
  }
  elements.takePhoto.disabled = !eyesDetected;
}

function trackEyes() {
  if (!cameraStream || !elements.cameraDialog.open) return;
  const now = performance.now();
  if (!cameraFramePending && eyeTrackerWorker &&
      elements.cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      elements.cameraVideo.currentTime !== lastVideoTime && now - lastCameraFrameAt >= 200) {
    lastVideoTime = elements.cameraVideo.currentTime;
    lastCameraFrameAt = now;
    cameraFramePending = true;
    createImageBitmap(elements.cameraVideo).then((bitmap) => {
      if (!cameraStream || !elements.cameraDialog.open || !eyeTrackerWorker) {
        bitmap.close();
        cameraFramePending = false;
        return;
      }
      eyeTrackerWorker.postMessage({ type: "frame", bitmap, timestamp: performance.now() }, [bitmap]);
    }).catch((error) => {
      stopCamera();
      elements.cameraError.textContent = `無法讀取相機影格：${error.message || "請重新啟動相機。"}`;
      elements.eyeTrackingStatus.textContent = "無法分析相機影格";
    });
  }
  cameraFrameRequest = requestAnimationFrame(trackEyes);
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return "此瀏覽器無法存取相機。請使用 localhost 或 HTTPS 開啟網站，並確認瀏覽器支援相機。";
  }
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "相機權限遭拒。請在瀏覽器網站設定中允許相機存取後再試一次。";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "找不到可用的相機，請連接或啟用相機後再試。";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "相機目前無法使用。請關閉其他使用相機的應用程式後再試。";
  }
  return `無法啟動相機：${error?.message || "請確認相機可用並重新嘗試。"}`;
}

async function openCamera() {
  if (!ensureTriageAllowsCapture()) return;
  elements.cameraError.textContent = "";
  elements.eyeTrackingStatus.textContent = "正在載入眼部追蹤模型…";
  elements.takePhoto.disabled = true;
  elements.cameraDialog.showModal();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    elements.cameraError.textContent = cameraErrorMessage();
    elements.eyeTrackingStatus.textContent = "無法使用相機";
    return;
  }

  const requestId = ++cameraRequestId;
  let stream;
  try {
    await createEyeTrackerWorker();
    if (!elements.cameraDialog.open || requestId !== cameraRequestId) return;
    elements.eyeTrackingStatus.textContent = "請允許相機權限…";
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    if (!elements.cameraDialog.open || requestId !== cameraRequestId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    elements.cameraVideo.srcObject = cameraStream;
    await elements.cameraVideo.play();
    elements.cameraView.style.aspectRatio = `${elements.cameraVideo.videoWidth} / ${elements.cameraVideo.videoHeight}`;
    elements.cameraPlaceholder.hidden = true;
    elements.eyeTrackingStatus.textContent = "請將雙眼完整對準鏡頭…";
    lastCameraFrameAt = 0;
    lastVideoTime = -1;
    cameraFrameRequest = requestAnimationFrame(trackEyes);
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (requestId !== cameraRequestId) return;
    stopCamera();
    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError" ||
        error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError" ||
        error?.name === "NotReadableError" || error?.name === "TrackStartError") {
      elements.cameraError.textContent = cameraErrorMessage(error);
    } else {
      elements.cameraError.textContent = `無法啟動眼部追蹤：${error.message || "請檢查網路連線並重試。"}`;
    }
    elements.eyeTrackingStatus.textContent = "無法啟動眼部追蹤";
  }
}

function takePhoto() {
  const video = elements.cameraVideo;
  if (!eyesDetected) {
    elements.cameraError.textContent = "偵測到雙眼後才能拍攝，請將雙眼完整對準鏡頭。";
    return;
  }
  if (!cameraStream || !video.videoWidth || !video.videoHeight) {
    elements.cameraError.textContent = "相機畫面尚未準備好，請稍候再拍攝。";
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    elements.cameraError.textContent = "瀏覽器無法擷取相機畫面，請改用選擇照片。";
    return;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) {
      elements.cameraError.textContent = "無法建立照片，請重試。";
      return;
    }
    const file = new File([blob], `eye-camera-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`, { type: blob.type });
    if (elements.cameraDialog.open) elements.cameraDialog.close();
    selectImage(file);
  }, "image/jpeg", .92);
}

function clearSelectedImage() {
  imageSelectionId += 1;
  if (currentImage?.url) URL.revokeObjectURL(currentImage.url);
  if (currentReportImageUrl) URL.revokeObjectURL(currentReportImageUrl);
  currentImage = null;
  currentMetrics = null;
  currentEyeFeatures = null;
  currentCalibration = null;
  currentReportImageUrl = null;
  elements.imagePreview.removeAttribute("src");
  elements.reportImage.removeAttribute("src");
  elements.reportImageStatus.textContent = "";
  elements.stickerStatus.textContent = "";
  elements.imagePreviewWrap.hidden = true;
  elements.uploadZone.hidden = false;
  elements.measurementPreview.hidden = true;
  elements.report.hidden = true;
  elements.saveRecord.disabled = true;
  showUploadError("");
}

async function saveRecord() {
  if (!currentImage || !currentMetrics) {
    showUploadError("請先選擇並分析一張影像。");
    return;
  }
  const user = activeUser();
  if (!user) {
    openAuth("login");
    elements.authIntro.textContent = "登入或建立本機帳號後，才能保存這筆影像紀錄。";
    return;
  }
  try {
    const risk = getRiskAssessment(currentMetrics, currentEyeFeatures);
    const record = {
      id: crypto.randomUUID(),
      ownerEmail: user.email,
      createdAt: new Date().toISOString(),
      fileName: currentImage.name,
      imageType: currentImage.type,
      image: currentImage.blob,
      calibratedImage: currentCalibration?.found ? currentImage.analysisBlob : null,
      calibration: currentCalibration,
      metrics: currentMetrics,
      eyeFeatures: currentEyeFeatures,
      riskLevel: risk.level,
      riskLabel: risk.label,
      note: "全圖與眼部 ROI 影像描述值；不代表眼部疾病或健康風險。"
    };
    await storeRequest("records", "readwrite", (store) => store.add(record));
    await renderHistory();
    showToast("影像與量測已儲存在本機歷史紀錄。");
  } catch (error) {
    showUploadError(`無法保存影像紀錄：${error.message || "本機儲存空間可能已滿。"}`);
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function renderHistory() {
  const user = activeUser();
  if (!user) {
    elements.historyContent.innerHTML = `<div class="history-empty"><span class="empty-art" aria-hidden="true"><i></i><i></i><i></i></span><strong>登入以查看你的歷史紀錄</strong><p>儲存的影像與量測會留在目前瀏覽器。</p><button class="text-link" id="history-login-inline" type="button">登入或建立本機帳號 ↗</button></div>`;
    document.getElementById("history-login-inline").addEventListener("click", () => openAuth());
    return;
  }
  const records = await storeRequest("records", "readonly", (store) => store.index("ownerEmail").getAll(user.email));
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!records.length) {
    elements.historyContent.innerHTML = `<div class="history-empty"><span class="empty-art" aria-hidden="true"><i></i><i></i><i></i></span><strong>還沒有保存的影像紀錄</strong><p>選擇影像並按下「儲存到歷史紀錄」即可開始整理。</p><a class="text-link" href="#screening">建立第一筆紀錄 ↗</a></div>`;
    return;
  }
  elements.historyContent.innerHTML = `<div class="history-grid">${records.map((record) => `
    <article class="history-card">
      <button class="history-thumb" type="button" data-action="view" data-id="${escapeHtml(record.id)}" aria-label="查看 ${escapeHtml(record.fileName)}">
        <img src="${URL.createObjectURL(record.image)}" alt="" loading="lazy">
      </button>
      <div class="history-card-body">
        <div class="history-card-head"><time datetime="${escapeHtml(record.createdAt)}">${escapeHtml(formatDate(record.createdAt))}</time><span class="record-tag risk-tag risk-${record.riskLevel || "gray"}">${escapeHtml(record.riskLabel || "未評估")}</span></div>
        <h3>${escapeHtml(record.fileName)}</h3>
        <p>RGB ${record.metrics.red} / ${record.metrics.green} / ${record.metrics.blue} · 亮度 ${record.metrics.luminance}</p>
        <div class="history-card-actions"><button type="button" data-action="view" data-id="${escapeHtml(record.id)}">查看紀錄</button><button class="delete-record" type="button" data-action="delete" data-id="${escapeHtml(record.id)}">刪除</button></div>
      </div>
    </article>`).join("")}</div>`;
  elements.historyContent.querySelectorAll(".history-thumb img").forEach((image) => {
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
  });
}

async function openRecord(id) {
  const record = await storeRequest("records", "readonly", (store) => store.get(id));
  const user = activeUser();
  if (!record || !user || record.ownerEmail !== user.email) {
    showToast("找不到這筆影像紀錄。");
    await renderHistory();
    return;
  }
  const imageUrl = URL.createObjectURL(record.calibratedImage || record.image);
  elements.detailBody.innerHTML = `
    <img class="detail-image" src="${imageUrl}" alt="${escapeHtml(record.fileName)}">
    <div class="detail-meta"><span>${escapeHtml(formatDate(record.createdAt))}</span><span>${escapeHtml(record.fileName)}</span></div>
    <div class="detail-measurements">${metricMarkup(record.metrics)}</div>
    <section class="detail-eye-features"><h3>眼部 ROI 特徵</h3><div class="report-metrics eye-roi-metrics">${eyeFeatureMetricsMarkup(record.eyeFeatures)}</div></section>
    <p class="detail-warning">${record.calibration?.found ? "影像以 RGBW 貼紙白色區域估算白平衡，非完整色彩校準。" : "未使用貼紙白平衡校正，顯示原始影像。"} 全圖及眼部 ROI 數值僅供影像描述，不是疾病偵測或醫療建議。紀錄留存在本機瀏覽器。</p>`;
  elements.detailDialog.showModal();
  elements.detailDialog.addEventListener("close", () => URL.revokeObjectURL(imageUrl), { once: true });
}

async function handleHistoryAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "view") await openRecord(id);
    if (action === "delete") {
      const record = await storeRequest("records", "readonly", (store) => store.get(id));
      const user = activeUser();
      if (!record || !user || record.ownerEmail !== user.email) throw new Error("找不到這筆影像紀錄。");
      if (!window.confirm(`確定刪除「${record.fileName}」及其保存的影像？此操作無法復原。`)) return;
      await storeRequest("records", "readwrite", (store) => store.delete(id));
      await renderHistory();
      showToast("影像紀錄已刪除。");
    }
  } catch (error) {
    showToast(`操作失敗：${error.message}`);
  }
}

const DATASET_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "tif", "tiff"]);
const DATASET_EXPECTED_DISEASES = ["Cataract", "Corneal_Disease", "Glaucoma", "Trachoma"];
const DATASET_HASH_LIMIT = 64 * 1024 * 1024;
let datasetScanId = 0;

function datasetExtension(path) {
  return path.split(".").pop().toLowerCase();
}

function datasetStem(path) {
  const normalizedPath = normalizeDatasetPath(path);
  const extensionIndex = normalizedPath.lastIndexOf(".");
  return (extensionIndex > normalizedPath.lastIndexOf("/") ? normalizedPath.slice(0, extensionIndex) : normalizedPath).toLowerCase();
}

function normalizeDatasetPath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function parseDatasetPng(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 26 || bytes[0] !== 0x89 || String.fromCharCode(...bytes.slice(1, 4)) !== "PNG") {
    throw new Error("PNG 標頭無效");
  }
  const view = new DataView(buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25];
  const modes = { 0: ["灰階", 1], 2: ["RGB", 3], 3: ["索引色", null], 4: ["灰階＋透明", 2], 6: ["RGB＋透明", 4] };
  const mode = modes[colorType];
  if (!width || !height || !mode) throw new Error("無法辨識 PNG 尺寸或色彩模式");
  return { width, height, mode: mode[0], channels: mode[1] };
}

function parseDatasetJpeg(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG 標頭無效");
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (frameMarkers.has(marker)) {
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      const channels = bytes[offset + 7];
      if (!width || !height || !channels) throw new Error("無法辨識 JPEG 尺寸或通道數");
      return { width, height, channels, mode: channels === 1 ? "灰階" : channels === 3 ? "3 通道（JPEG 色彩編碼）" : `${channels} 通道` };
    }
    offset += segmentLength;
  }
  throw new Error("找不到 JPEG 影像尺寸標記");
}

async function parseDatasetTiff(file) {
  const header = await file.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(header);
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
  const headerView = new DataView(header);
  if ((!littleEndian && !bigEndian) || headerView.getUint16(2, littleEndian) !== 42) {
    throw new Error("不支援此 TIFF 標頭（僅支援標準 TIFF，不含 BigTIFF）");
  }
  const ifdOffset = headerView.getUint32(4, littleEndian);
  const countBuffer = await file.slice(ifdOffset, ifdOffset + 2).arrayBuffer();
  if (countBuffer.byteLength < 2) throw new Error("TIFF 標籤目錄不完整");
  const entryCount = new DataView(countBuffer).getUint16(0, littleEndian);
  const ifdBuffer = await file.slice(ifdOffset + 2, ifdOffset + 2 + entryCount * 12).arrayBuffer();
  const view = new DataView(ifdBuffer);
  const tags = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    const entry = index * 12;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const count = view.getUint32(entry + 4, littleEndian);
    if (count !== 1 || (type !== 3 && type !== 4)) continue;
    tags.set(tag, type === 3 ? view.getUint16(entry + 8, littleEndian) : view.getUint32(entry + 8, littleEndian));
  }
  const width = tags.get(256);
  const height = tags.get(257);
  const channels = tags.get(277) || 1;
  const photo = tags.get(262);
  const mode = photo === 0 || photo === 1 ? (channels === 2 ? "灰階＋透明" : "灰階") : photo === 2 ? (channels === 3 ? "RGB" : channels === 4 ? "RGB＋透明" : `RGB 標記／${channels} 通道`) : photo === 3 ? "索引色" : photo === 5 ? "CMYK" : photo === 6 ? "YCbCr" : `${channels} 通道（色彩模式未知）`;
  if (!width || !height) throw new Error("TIFF 缺少影像尺寸標籤");
  return { width, height, channels, mode };
}

async function inspectDatasetImage(file, extension) {
  if (extension === "png") return parseDatasetPng(await file.slice(0, 32).arrayBuffer());
  if (extension === "jpg" || extension === "jpeg") return parseDatasetJpeg(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  return parseDatasetTiff(file);
}

function parseDatasetCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((header) => header.trim().replace(/^\uFEFF/, "").toLowerCase());
  return {
    headers,
    records: rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] || "").trim()])))
  };
}

function datasetFileRecord(file) {
  const path = normalizeDatasetPath(file.webkitRelativePath || file.name);
  const parts = path.split("/");
  const imagesIndex = parts.findIndex((part) => part.toLowerCase() === "images");
  if (imagesIndex < 1 || imagesIndex >= parts.length - 1) return null;
  return {
    file,
    path,
    disease: parts[imagesIndex - 1],
    relativePath: parts.slice(imagesIndex + 1).join("/"),
    extension: datasetExtension(path),
    key: `${parts[imagesIndex - 1].toLowerCase()}/${parts.slice(imagesIndex + 1).join("/").toLowerCase()}`
  };
}

function datasetLabelRecord(file) {
  const path = normalizeDatasetPath(file.webkitRelativePath || file.name);
  const parts = path.split("/");
  const labelsIndex = parts.findIndex((part) => part.toLowerCase() === "labels");
  if (labelsIndex < 1 || labelsIndex >= parts.length - 1) return null;
  const relativePath = parts.slice(labelsIndex + 1).join("/");
  return {
    path,
    disease: parts[labelsIndex - 1],
    key: `${parts[labelsIndex - 1].toLowerCase()}/${datasetStem(relativePath)}`
  };
}

function datasetMetadataImageKey(value) {
  const parts = normalizeDatasetPath(value).split("/").filter(Boolean);
  const imagesIndex = parts.findIndex((part) => part.toLowerCase() === "images");
  if (imagesIndex > 0) return `${parts[imagesIndex - 1]}/${parts.slice(imagesIndex + 1).join("/")}`.toLowerCase();
  return parts.length > 1 ? parts.slice(-2).join("/").toLowerCase() : "";
}

async function hashDatasetFile(file) {
  if (!globalThis.crypto?.subtle) throw new Error("此瀏覽器不支援 SHA-256，無法檢查重複影像");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function datasetResultMarkup({ files, classes, foundClassCount, metadataSummary, issues, dimensions, dimensionsByModality, formatCounts, duplicates, repeatPatients, modalitySummary, unsupported, inspectionErrors, labeledCount, metadataMissingRows, metadataMissingPatients, metadataMissingModalities }) {
  const imageCount = files.length;
  const dimensionGroups = metadataSummary ? [...dimensionsByModality.entries()] : [["全部影像", dimensions]];
  const inconsistentDimensionGroups = dimensionGroups.filter(([, sizes]) => sizes.size > 1);
  const consistentDimensions = metadataSummary ? inconsistentDimensionGroups.length === 0 : dimensions.size <= 1;
  const commonDimensions = [...dimensions.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const dimensionDetails = dimensionGroups.map(([modality, sizes]) => {
    const breakdown = [...sizes.entries()].map(([size, count]) => `${escapeHtml(size)}：${count} 張`).join("、");
    return `${escapeHtml(modality)}：${breakdown || "無可讀尺寸"}`;
  }).join("；");
  const findings = [
    { title: "資料夾架構", detail: foundClassCount ? `找到 ${foundClassCount} 個疾病資料夾；${classes.filter((item) => item.imageCount).length} 個含有影像。` : "沒有找到疾病/Images/ 或疾病/Labels/ 目錄。", status: foundClassCount ? "檢查完成" : "需整理", warning: !foundClassCount },
    { title: "疾病標籤", detail: `${labeledCount}/${imageCount} 張影像有同名 Labels/ 檔案或 metadata.csv 標籤。`, status: labeledCount === imageCount && imageCount ? "完整" : "有缺漏", warning: labeledCount !== imageCount || !imageCount },
    { title: "色彩通道", detail: `${issues.rgb} 張 RGB、${issues.gray} 張灰階、${issues.other} 張其他/未知模式。JPEG 的 3 通道不保證原始編碼即為 RGB。`, status: issues.gray || issues.other || unsupported || inspectionErrors ? "請確認" : "已檢查", warning: issues.gray > 0 || issues.other > 0 || unsupported > 0 || inspectionErrors > 0 },
    { title: "影像尺寸", detail: !imageCount ? "尚無可檢查的影像。" : consistentDimensions ? (metadataSummary ? "各影像類型內尺寸一致。" : "所有成功讀取的影像尺寸一致。") : `${inconsistentDimensionGroups.length || dimensions.size} 組影像尺寸不一致；請依影像類型檢查。`, status: consistentDimensions && imageCount ? "一致" : "有差異", warning: !consistentDimensions || !imageCount },
    { title: "完全重複檔案", detail: duplicates ? `SHA-256 找到 ${duplicates} 張可逐位元組確認的重複影像。` : "未發現可逐位元組確認的重複影像。", status: duplicates ? "有重複" : "未發現", warning: duplicates > 0 },
    { title: "病人與影像類型", detail: metadataSummary ? `${repeatPatients} 位病人有多張影像；${modalitySummary || "metadata.csv 未提供 modality 值。"}${metadataMissingRows ? `；${metadataMissingRows} 張影像缺少中繼資料列` : ""}${metadataMissingPatients ? `；${metadataMissingPatients} 張缺少 patient_id` : ""}${metadataMissingModalities ? `；${metadataMissingModalities} 張缺少 modality` : ""}` : "缺少合規的 Metadata/metadata.csv，無法核對病人重複影像或影像類型。", status: metadataSummary ? "依中繼資料檢查" : "無法檢查", warning: !metadataSummary || repeatPatients > 0 || metadataMissingRows > 0 || metadataMissingPatients > 0 || metadataMissingModalities > 0 },
    { title: "影像格式與可讀性", detail: `JPEG ${formatCounts.JPEG}、PNG ${formatCounts.PNG}、TIFF ${formatCounts.TIFF} 張；${inspectionErrors} 張影像無法讀取尺寸/色彩資訊；${unsupported} 個 Images/ 中的檔案格式不支援檢查。`, status: inspectionErrors || unsupported ? "需確認" : "正常", warning: inspectionErrors > 0 || unsupported > 0 }
  ];
  const classRows = classes.map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>Images：${item.imageCount} · Labels：${item.labelCount}${item.hasImagesFolder ? "" : " · 缺少 Images/"}${item.hasLabelsFolder ? "" : " · 缺少 Labels/"}</span></li>`).join("");
  return `<div class="dataset-summary-grid">${findings.map((item) => `<article class="dataset-check ${item.warning ? "warning" : "ready"}"><div><h3>${item.title}</h3><span class="dataset-check-status">${item.status}</span></div><p>${item.detail}</p></article>`).join("")}</div>
    ${classRows ? `<section class="dataset-class-list"><h3>疾病資料夾</h3><ul>${classRows}</ul></section>` : ""}
    ${dimensions.size > 1 ? `<p class="dataset-note">尺寸分布：${dimensionDetails || `${escapeHtml(commonDimensions || "未知")}`}</p>` : ""}
    <p class="dataset-note">支援檢查 JPEG、PNG 與標準 TIFF；BigTIFF 或不支援的格式會列為無法讀取。完全相同的病人影像以中繼資料中的 patient_id 比對；不同但相似的影像不會自動視為重複。</p>`;
}

async function validateDataset(fileList) {
  const scanId = ++datasetScanId;
  const allFiles = [...fileList];
  const imageEntries = allFiles.map(datasetFileRecord).filter(Boolean);
  const images = imageEntries.filter((image) => DATASET_IMAGE_EXTENSIONS.has(image.extension));
  const unsupportedFiles = imageEntries.filter((image) => !DATASET_IMAGE_EXTENSIONS.has(image.extension));
  const labels = allFiles.map(datasetLabelRecord).filter(Boolean);
  const labelsByKey = new Set(labels.map((label) => label.key));
  const classNames = new Map();
  for (const file of allFiles) {
    const path = normalizeDatasetPath(file.webkitRelativePath || file.name);
    const parts = path.split("/");
    const index = parts.findIndex((part) => ["images", "labels"].includes(part.toLowerCase()));
    if (index > 0) {
      const name = parts[index - 1];
      const key = name.toLowerCase();
      if (!classNames.has(key)) classNames.set(key, { name, hasImagesFolder: false, hasLabelsFolder: false, imageCount: 0, labelCount: 0 });
      if (parts[index].toLowerCase() === "images") classNames.get(key).hasImagesFolder = true;
      if (parts[index].toLowerCase() === "labels") classNames.get(key).hasLabelsFolder = true;
    }
  }
  for (const image of images) {
    const item = classNames.get(image.disease.toLowerCase());
    item.imageCount += 1;
  }
  for (const label of labels) {
    const item = classNames.get(label.disease.toLowerCase());
    item.labelCount += 1;
  }
  const foundClassCount = classNames.size;
  for (const expected of DATASET_EXPECTED_DISEASES) {
    if (!classNames.has(expected.toLowerCase())) {
      classNames.set(expected.toLowerCase(), { name: expected, hasImagesFolder: false, hasLabelsFolder: false, imageCount: 0, labelCount: 0 });
    }
  }
  const metadataFile = allFiles.find((file) => {
    const parts = normalizeDatasetPath(file.webkitRelativePath || file.name).split("/");
    return parts.some((part, index) => part.toLowerCase() === "metadata" && parts[index + 1]?.toLowerCase() === "metadata.csv");
  });
  let metadata = { headers: [], records: [] };
  if (metadataFile) metadata = parseDatasetCsv(await metadataFile.text());
  const requiredHeaders = ["image_filename", "patient_id", "modality", "label"];
  const hasMetadata = requiredHeaders.every((header) => metadata.headers.includes(header));
  const metadataByPath = new Map();
  const metadataByName = new Map();
  if (hasMetadata) {
    for (const record of metadata.records) {
      const path = datasetMetadataImageKey(record.image_filename);
      metadataByPath.set(path, record);
      const name = normalizeDatasetPath(record.image_filename).split("/").pop().toLowerCase();
      if (!metadataByName.has(name)) metadataByName.set(name, []);
      metadataByName.get(name).push(record);
    }
  }
  const dimensions = new Map();
  const dimensionsByModality = new Map();
  const hashGroups = new Map();
  const patientImages = new Map();
  const modalityCounts = new Map();
  const formatCounts = { JPEG: 0, PNG: 0, TIFF: 0 };
  let rgb = 0;
  let gray = 0;
  let other = 0;
  const unsupported = unsupportedFiles.length;
  let inspectionErrors = 0;
  let hashSkipped = 0;
  let labeledCount = 0;
  let metadataMissingPatients = 0;
  let metadataMissingModalities = 0;
  let metadataMissingRows = 0;
  const results = [];
  for (let index = 0; index < images.length; index += 1) {
    if (scanId !== datasetScanId) return;
    const image = images[index];
    if (image.extension === "jpg" || image.extension === "jpeg") formatCounts.JPEG += 1;
    else if (image.extension === "png") formatCounts.PNG += 1;
    else formatCounts.TIFF += 1;
    const metadataPath = `${image.disease}/${image.relativePath}`.toLowerCase();
    const basename = image.relativePath.split("/").pop().toLowerCase();
    const metadataRecord = metadataByPath.get(metadataPath) || (metadataByName.get(basename)?.length === 1 ? metadataByName.get(basename)[0] : null);
    if (hasMetadata && !metadataRecord) metadataMissingRows += 1;
    const hasLabel = labelsByKey.has(`${image.disease.toLowerCase()}/${datasetStem(image.relativePath)}`) || Boolean(metadataRecord?.label);
    if (hasLabel) labeledCount += 1;
    try {
      const details = await inspectDatasetImage(image.file, image.extension);
      const size = `${details.width}×${details.height}`;
      dimensions.set(size, (dimensions.get(size) || 0) + 1);
      const modality = metadataRecord?.modality.trim() || "未分類";
      if (!dimensionsByModality.has(modality)) dimensionsByModality.set(modality, new Map());
      const modalityDimensions = dimensionsByModality.get(modality);
      modalityDimensions.set(size, (modalityDimensions.get(size) || 0) + 1);
      if (details.mode === "RGB" || details.mode.startsWith("RGB＋")) rgb += 1;
      else if (details.mode === "灰階" || details.mode === "灰階＋透明") gray += 1;
      else other += 1;
    } catch {
      inspectionErrors += 1;
    }
    if (image.file.size <= DATASET_HASH_LIMIT) {
      try {
        const hash = await hashDatasetFile(image.file);
        if (!hashGroups.has(hash)) hashGroups.set(hash, []);
        hashGroups.get(hash).push(image.path);
      } catch {
        hashSkipped += 1;
      }
    } else hashSkipped += 1;
    if (metadataRecord) {
      const patientId = metadataRecord.patient_id.trim();
      if (patientId) {
        if (!patientImages.has(patientId)) patientImages.set(patientId, new Set());
        patientImages.get(patientId).add(image.path);
      } else metadataMissingPatients += 1;
      const modality = metadataRecord.modality.trim();
      if (modality) modalityCounts.set(modality, (modalityCounts.get(modality) || 0) + 1);
      else metadataMissingModalities += 1;
    }
    elements.datasetStatus.textContent = `正在檢查影像 ${index + 1}/${images.length}…`;
  }
  if (scanId !== datasetScanId) return;
  const duplicates = [...hashGroups.values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0);
  const repeatPatients = [...patientImages.values()].filter((paths) => paths.size > 1).length;
  const modalitySummary = modalityCounts.size
    ? [...modalityCounts.entries()].map(([modality, count]) => `${escapeHtml(modality)}：${count} 張`).join("；")
    : "";
  if (hashSkipped) results.push(`有 ${hashSkipped} 張影像超過 64 MB 或瀏覽器不支援 SHA-256，略過完全重複檢查。`);
  if (metadataFile && !hasMetadata) results.push(`metadata.csv 缺少必要欄位：${requiredHeaders.filter((header) => !metadata.headers.includes(header)).join(", ")}。`);
  const classes = [...classNames.values()].sort((left, right) => left.name.localeCompare(right.name));
  elements.datasetResults.innerHTML = datasetResultMarkup({
    files: images,
    classes,
    foundClassCount,
    metadataSummary: hasMetadata,
    issues: { rgb, gray, other },
    dimensions,
    dimensionsByModality,
    formatCounts,
    duplicates,
    repeatPatients,
    modalitySummary,
    unsupported,
    inspectionErrors,
    labeledCount,
    metadataMissingRows,
    metadataMissingPatients,
    metadataMissingModalities
  }) + (results.length ? `<ul class="dataset-warnings">${results.map((result) => `<li>${escapeHtml(result)}</li>`).join("")}</ul>` : "");
  elements.datasetResults.hidden = false;
  elements.datasetStatus.textContent = `檢查完成：${images.length} 張影像、${labels.length} 個標籤檔。資料只在此瀏覽器處理。`;
}

function bindEvents() {
  elements.accountButton.addEventListener("click", () => {
    if (activeUser()) {
      sessionStorage.removeItem(SESSION_KEY);
      renderAccount();
      showToast("已登出；本機紀錄仍保留。");
    } else {
      openAuth();
    }
  });
  elements.historyRefresh.addEventListener("click", () => renderHistory().catch((error) => showToast(`無法讀取歷史紀錄：${error.message}`)));
  elements.clinicMapLink.addEventListener("click", openNearbyEyeClinicMap);
  elements.triageClinicLink.addEventListener("click", openNearbyEyeClinicMap);
  elements.datasetInput.addEventListener("change", () => {
    elements.datasetResults.hidden = true;
    const files = elements.datasetInput.files;
    if (!files?.length) {
      datasetScanId += 1;
      elements.datasetStatus.textContent = "尚未選取資料夾。";
      return;
    }
    elements.datasetStatus.textContent = "準備檢查資料夾…";
    validateDataset(files).catch((error) => {
      elements.datasetStatus.textContent = `檢查失敗：${error.message}`;
      elements.datasetResults.hidden = true;
    });
  });
  elements.authClose.addEventListener("click", () => elements.authDialog.close());
  elements.authDialog.addEventListener("click", (event) => {
    if (event.target === elements.authDialog) elements.authDialog.close();
  });
  elements.loginTab.addEventListener("click", () => setAuthMode("login"));
  elements.registerTab.addEventListener("click", () => setAuthMode("register"));
  elements.authForm.addEventListener("submit", submitAuth);
  document.querySelectorAll('.triage-question input[type="radio"]').forEach((input) => {
    input.addEventListener("change", updateTriageStatus);
  });
  updateTriageStatus();
  elements.triageContinue.addEventListener("click", () => {
    if (!ensureTriageAllowsCapture()) return;
    document.getElementById("screening").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.calibrationOpenCamera.addEventListener("click", openCamera);
  elements.imageInput.addEventListener("change", () => selectImage(elements.imageInput.files?.[0]));
  elements.chooseImage.addEventListener("click", () => {
    if (ensureTriageAllowsCapture()) elements.imageInput.click();
  });
  elements.openCamera.addEventListener("click", openCamera);
  elements.cameraClose.addEventListener("click", () => elements.cameraDialog.close());
  elements.takePhoto.addEventListener("click", takePhoto);
  elements.cameraDialog.addEventListener("close", stopCamera);
  elements.cameraDialog.addEventListener("click", (event) => {
    if (event.target === elements.cameraDialog) elements.cameraDialog.close();
  });
  elements.removeImage.addEventListener("click", clearSelectedImage);
  elements.saveRecord.addEventListener("click", saveRecord);
  elements.reportSave.addEventListener("click", saveRecord);
  elements.reportHistory.addEventListener("click", () => {
    elements.historyContent.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.reportNew.addEventListener("click", () => {
    clearSelectedImage();
    document.getElementById("screening").scrollIntoView({ behavior: "smooth" });
  });
  elements.historyContent.addEventListener("click", handleHistoryAction);
  elements.detailClose.addEventListener("click", () => elements.detailDialog.close());
  elements.detailDialog.addEventListener("click", (event) => {
    if (event.target === elements.detailDialog) elements.detailDialog.close();
  });
  elements.uploadZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.uploadZone.classList.add("dragging");
  });
  elements.uploadZone.addEventListener("dragleave", () => elements.uploadZone.classList.remove("dragging"));
  elements.uploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.uploadZone.classList.remove("dragging");
    selectImage(event.dataTransfer.files?.[0]);
  });
}

async function initialize() {
  try {
    if (!("indexedDB" in window)) throw new Error("此瀏覽器不支援 IndexedDB，無法安全保存本機紀錄。");
    db = await openDatabase();
    bindEvents();
    renderAccount();
  } catch (error) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="storage-warning" role="alert">${escapeHtml(error.message || "本機資料庫無法啟動。")} 請使用支援 IndexedDB 的瀏覽器。</div>`);
    elements.accountButton.disabled = true;
    elements.imageInput.disabled = true;
  }
}

initialize();
