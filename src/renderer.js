(async () => {
  const fallbackConfig = {
    apiBaseUrl: "http://192.168.3.113:8000",
    asbp: {
      mainUrl: "http://192.168.3.113:8000",
      externalPassPath: "/api/v1/external_pass",
      rfidPathTemplate: "/api/v1/pass/{pass_id}/rfid",
      terminalToken: ""
    },
    dispenser: {
      cardUrl: "http://192.168.3.159:8082/card"
    },
    pollIntervalMs: 1500,
    maxFileSizeMb: 75,
    sessionTimeoutMs: 120000,
    idleWarningMs: 90000,
    camera: {
      preferredFacingMode: "environment",
      width: 1280,
      height: 720
    }
  };

  const config = window.ocrTerminal?.getConfig
    ? { ...fallbackConfig, ...(await window.ocrTerminal.getConfig()) }
    : fallbackConfig;

  const screens = [...document.querySelectorAll("[data-screen]")];
  const consentInput = document.querySelector("#consentInput");
  const continueButton = document.querySelector("#continueButton");
  const backToStartButton = document.querySelector("#backToStartButton");
  const cameraVideo = document.querySelector("#cameraVideo");
  const stillPreview = document.querySelector("#stillPreview");
  const cameraMessage = document.querySelector("#cameraMessage");
  const scanButton = document.querySelector("#scanButton");
  const captureCanvas = document.querySelector("#captureCanvas");
  const processingText = document.querySelector("#processingText");
  const jobIdLabel = document.querySelector("#jobIdLabel");
  const cancelButton = document.querySelector("#cancelButton");
  const resultFields = document.querySelector("#resultFields");
  const resultMeta = document.querySelector("#resultMeta");
  const confidenceBadge = document.querySelector("#confidenceBadge");
  const confirmButton = document.querySelector("#confirmButton");
  const passStatusMessage = document.querySelector("#passStatusMessage");
  const retakeButton = document.querySelector("#retakeButton");
  const errorText = document.querySelector("#errorText");
  const errorRetakeButton = document.querySelector("#errorRetakeButton");
  const errorHomeButton = document.querySelector("#errorHomeButton");
  const idleModal = document.querySelector("#idleModal");
  const stayButton = document.querySelector("#stayButton");

  let stream = null;
  let activeJobId = null;
  let pollTimer = null;
  let idleWarningTimer = null;
  let idleResetTimer = null;
  let lastPassportData = null;

  const genericRecognitionError = "Не удалось распознать, попробуйте ещё раз.";
  const terminalStatuses = new Set(["done", "failed", "timeout", "cancelled"]);

  const resultCards = [
    { fields: [["surname", "Фамилия"]] },
    { fields: [["name", "Имя"]] },
    { fields: [["patronymic", "Отчество"]] },
    { fields: [["sex", "Пол"], ["date_of_birth", "Дата рождения"]], split: true },
    { fields: [["passport_series", "Серия"], ["passport_number", "Номер"]], split: true },
    { fields: [["mrz_line1", "MRZ строка 1"]], wide: true },
    { fields: [["mrz_line2", "MRZ строка 2"]], wide: true }
  ];

  function showScreen(name) {
    screens.forEach((screen) => {
      screen.classList.toggle("is-active", screen.dataset.screen === name);
    });
    resetIdleTimers();
  }

  function resetIdleTimers() {
    clearTimeout(idleWarningTimer);
    clearTimeout(idleResetTimer);
    idleModal.hidden = true;

    if (getActiveScreenName() === "start") {
      return;
    }

    idleWarningTimer = setTimeout(() => {
      idleModal.hidden = false;
    }, config.idleWarningMs);

    idleResetTimer = setTimeout(() => {
      resetSession();
    }, config.sessionTimeoutMs);
  }

  function getActiveScreenName() {
    return document.querySelector(".screen.is-active")?.dataset.screen;
  }

  function clearJobPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    cameraVideo.srcObject = null;
  }

  async function startCamera() {
    await stopCamera();
    stillPreview.classList.remove("is-visible");
    cameraMessage.textContent = "Запрашиваем доступ к камере";

    const constraints = {
      video: {
        width: { ideal: config.camera.width },
        height: { ideal: config.camera.height },
        facingMode: config.camera.preferredFacingMode
      },
      audio: false
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraVideo.srcObject = stream;
      cameraMessage.textContent = "Камера готова";
    } catch (error) {
      cameraMessage.textContent = "Камера недоступна.";
      throw error;
    }
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
  }

  async function captureFromCamera() {
    if (!stream || !cameraVideo.videoWidth) {
      throw new Error("Камера ещё не готова");
    }

    captureCanvas.width = cameraVideo.videoWidth;
    captureCanvas.height = cameraVideo.videoHeight;
    const context = captureCanvas.getContext("2d");
    context.drawImage(cameraVideo, 0, 0, captureCanvas.width, captureCanvas.height);
    stillPreview.src = captureCanvas.toDataURL("image/jpeg", 0.92);
    stillPreview.classList.add("is-visible");

    const blob = await canvasToBlob(captureCanvas);
    return new File([blob], "passport-capture.jpg", { type: "image/jpeg" });
  }

  async function submitFile(file) {
    if (!file) {
      return;
    }

    const maxBytes = config.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      showError(`Файл больше лимита ${config.maxFileSizeMb} МБ.`);
      return;
    }

    scanButton.disabled = true;
    processingText.textContent = "Обрабатываем изображение.";
    jobIdLabel.textContent = "";
    showScreen("processing");

    try {
      const formData = new FormData();
      formData.append("image", file);

      const response = await fetch(`${config.apiBaseUrl}/passprot`, {
        method: "POST",
        body: formData
      });

      const payload = await readApiResponse(response);
      const task = payload.data?.meta?.task;

      if (!task?.job_id) {
        throw new Error("OCR API не вернул идентификатор задачи.");
      }

      activeJobId = task.job_id;
      jobIdLabel.textContent = `ID задачи: ${activeJobId}`;
      processingText.textContent = "Задача в очереди. Ожидаем результат.";
      pollJob();
    } catch (error) {
      showError(error.message || "Не удалось отправить изображение.");
    } finally {
      scanButton.disabled = false;
    }
  }

  async function readApiResponse(response) {
    let payload = null;

    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Ошибка OCR API: HTTP ${response.status}`);
    }

    if (!response.ok || payload?.success === false) {
      throw new Error(formatApiError(payload, `Ошибка OCR API: HTTP ${response.status}`));
    }

    return payload;
  }

  function formatApiError(payload, fallback) {
    const error = payload?.error;

    if (!error) {
      return fallback;
    }

    if (typeof error === "string") {
      return error;
    }

    if (error.code && error.message) {
      return `${error.message} (${error.code})`;
    }

    return error.message || error.code || fallback;
  }

  function getTask(payload) {
    return payload?.data?.meta?.task || null;
  }

  function getJobStatus(payload) {
    return getTask(payload)?.status || null;
  }

  function getPassport(payload) {
    return payload?.data?.passport || null;
  }

  function getResponseMeta(payload) {
    return payload?.data?.meta || {};
  }

  function getJobId(payload) {
    return getTask(payload)?.job_id || "";
  }

  function getJobError(payload, status) {
    return formatApiError(payload, statusText(status));
  }

  function hasPassportResult(payload) {
    return Boolean(getPassport(payload));
  }

  function isTerminalStatus(status) {
    return terminalStatuses.has(status);
  }

  function ensureJobStatus(payload) {
    const status = getJobStatus(payload);

    if (!status) {
      throw new Error("OCR API не вернул статус задачи.");
    }

    return status;
  }

  async function pollJob() {
    clearJobPolling();
    if (!activeJobId) {
      return;
    }

    try {
      const response = await fetch(`${config.apiBaseUrl}/jobs/${activeJobId}`);
      const payload = await readApiResponse(response);
      const status = ensureJobStatus(payload);

      processingText.textContent = statusText(status);

      if (!isTerminalStatus(status)) {
        pollTimer = setTimeout(pollJob, config.pollIntervalMs);
        return;
      }

      if (status === "done" && hasPassportResult(payload)) {
        renderResult(payload);
        showScreen("result");
        return;
      }

      if (status === "done") {
        showError("OCR API завершил задачу, но не вернул данные паспорта.");
        return;
      }

      showError(getJobError(payload, status));
    } catch (error) {
      showError(error.message || "Не удалось получить статус задачи.");
    }
  }

  function statusText(status) {
    const messages = {
      queued: "Задача ожидает обработки.",
      processing: "OCR распознаёт данные паспорта.",
      done: "Распознавание завершено.",
      failed: "OCR API вернул ошибку.",
      timeout: "Истекло время обработки.",
      cancelled: "Задача отменена."
    };
    return messages[status] || "Ожидаем ответ OCR API.";
  }

  function renderResult(payload) {
    const data = getPassport(payload);
    const meta = getResponseMeta(payload);
    lastPassportData = data;
    resetPassStatus();

    resultFields.innerHTML = "";
    resultCards.forEach((cardConfig) => {
      const card = document.createElement("div");
      card.className = `field-card${cardConfig.wide ? " wide" : ""}${cardConfig.split ? " split" : ""}`;
      card.innerHTML = cardConfig.fields.map(([key, label]) => renderField(data, key, label)).join("");
      resultFields.append(card);
    });

    confidenceBadge.textContent = confidenceText(data.confidence);
    confidenceBadge.className = `status-pill ${confidenceClass(data.confidence)}`;

    resultMeta.innerHTML = "";
    addMetaRow("Время", meta.processing_time_ms ? `${Math.round(meta.processing_time_ms / 1000)} сек.` : "нет данных");
  }

  function renderField(data, key, label) {
    const value = data[key] || "Не распознано";

    return `
      <div class="field-pair">
        <div class="field-name">${label}</div>
        <div class="field-value${data[key] ? "" : " empty"}">${escapeHtml(value)}</div>
      </div>
    `;
  }

  async function receivePass() {
    if (!lastPassportData) {
      setPassStatus("Сначала распознайте паспорт.", "danger");
      return;
    }

    const series = onlyDigits(lastPassportData.passport_series);
    const number = onlyDigits(lastPassportData.passport_number);

    if (!series || !number) {
      setPassStatus("Не удалось получить серию и номер паспорта. Выполните пересъёмку.", "danger");
      return;
    }

    const previousText = confirmButton.textContent;
    confirmButton.disabled = true;
    confirmButton.textContent = "Ищем пропуск";
    setPassStatus("Ищем пропуск по данным паспорта.", "");

    try {
      const pass = await findExternalPass({ series, number });

      if (!pass) {
        setPassStatus("Действующий пропуск не найден.", "danger");
        return;
      }

      if (getPassRfid(pass)) {
        setPassStatus("Пропуск уже выдан.", "warning");
        return;
      }

      setPassStatus("Пропуск найден. Получаем карту.", "");
      confirmButton.textContent = "Получаем карту";
      const rfid = await getCardFromDispenser();

      confirmButton.textContent = "Привязываем карту";
      await assignRfidToPass(pass, rfid);

      setPassStatus("Пропуск выдан.", "");
      await resetSession();
    } catch (error) {
      setPassStatus("Не удалось получить пропуск. Попробуйте ещё раз.", "danger");
    } finally {
      confirmButton.disabled = false;
      confirmButton.textContent = previousText;
    }
  }

  async function findExternalPass({ series, number }) {
    const passApi = getPassApiConfig();

    if (!passApi.token) {
      throw new Error("Terminal token is not configured.");
    }

    const url = new URL(passApi.externalPassPath, ensureTrailingSlash(passApi.mainUrl));
    url.searchParams.set("order_by", "-id");
    url.searchParams.set("pass_info__series", series);
    url.searchParams.set("pass_info__number", number);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${passApi.token}`,
        Accept: "application/json"
      }
    });

    const payload = await readJsonResponse(response, "Поиск пропуска");
    const passes = extractPasses(payload);
    const availablePasses = passes.filter((pass) => {
      const status = getPassStatus(pass);
      return status !== "expired" && status !== "registered";
    });

    return pickPreferredPass(availablePasses);
  }

  function getPassApiConfig() {
    return {
      mainUrl: config.asbp?.mainUrl || config.asbpApiBaseUrl || config.mainURL || config.apiBaseUrl,
      externalPassPath: config.asbp?.externalPassPath || "/api/v1/external_pass",
      rfidPathTemplate: config.asbp?.rfidPathTemplate || "/api/v1/pass/{pass_id}/rfid",
      token: config.asbp?.terminalToken || config.terminalToken || ""
    };
  }

  function getDispenserConfig() {
    return {
      cardUrl: config.dispenser?.cardUrl || ""
    };
  }

  async function getCardFromDispenser() {
    const { cardUrl } = getDispenserConfig();

    if (!cardUrl) {
      throw new Error("Dispenser card URL is not configured.");
    }

    const token = getPassApiConfig().token;

    const response = await fetch(cardUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/plain"
      }
    });

    if (!response.ok) {
      throw new Error("Dispenser request failed.");
    }

    const rfid = normalizeRfid(await response.text());

    if (!rfid) {
      throw new Error("Dispenser returned an empty RFID.");
    }

    return rfid;
  }

  async function assignRfidToPass(pass, rfid) {
    const passId = getPassId(pass);
    const passApi = getPassApiConfig();

    if (!passId) {
      throw new Error("Pass ID was not found.");
    }

    if (!passApi.token) {
      throw new Error("Terminal token is not configured.");
    }

    const path = passApi.rfidPathTemplate.replace("{pass_id}", encodeURIComponent(passId));
    const url = new URL(path, ensureTrailingSlash(passApi.mainUrl));
    const body = JSON.stringify({ rfid });

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${passApi.token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body
    });

    if (!response.ok) {
      throw new Error("RFID assignment request failed.");
    }
  }

  function ensureTrailingSlash(value) {
    return String(value || "").replace(/\/?$/, "/");
  }

  async function readJsonResponse(response, label) {
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${label} request failed.`);
    }

    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`${label} JSON parse failed.`);
    }
  }

  function extractPasses(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.results)) return payload.data.results;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
  }

  function pickPreferredPass(passes) {
    const preferredStatuses = new Set(["new", "active"]);
    return passes.find((pass) => preferredStatuses.has(getPassStatus(pass))) || passes[0] || null;
  }

  function getPassStatus(pass) {
    return String(pass?.status || "").toLowerCase();
  }

  function getPassRfid(pass) {
    return pass?.rfid || pass?.rfid_code || pass?.card?.rfid || pass?.pass_info?.rfid || "";
  }

  function getPassId(pass) {
    return pass?.id || pass?.pass_id || pass?.external_pass_id || pass?.data?.id || "";
  }

  function normalizeRfid(value) {
    return String(value || "").trim().replace(/^"+|"+$/g, "");
  }

  function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function setPassStatus(message, tone) {
    passStatusMessage.hidden = false;
    passStatusMessage.textContent = message;
    passStatusMessage.className = `pass-status${tone ? ` is-${tone}` : ""}`;
  }

  function resetPassStatus() {
    passStatusMessage.hidden = true;
    passStatusMessage.textContent = "";
    passStatusMessage.className = "pass-status";
  }

  function addMetaRow(label, value) {
    const row = document.createElement("div");
    row.className = "meta-row";
    row.innerHTML = `<span>${label}</span><strong>${escapeHtml(value)}</strong>`;
    resultMeta.append(row);
  }

  function confidenceText(confidence) {
    const map = {
      high: "Высокая уверенность",
      medium: "Средняя уверенность",
      low: "Низкая уверенность"
    };
    return map[confidence] || "Уверенность неизвестна";
  }

  function confidenceClass(confidence) {
    if (confidence === "high") return "";
    if (confidence === "medium") return "status-warning";
    return "status-danger";
  }

  function imageQualityText(quality) {
    const map = {
      good: "хорошее",
      medium: "среднее",
      poor: "плохое",
      unknown: "неизвестно"
    };
    return map[quality] || "неизвестно";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function cancelJob() {
    if (!activeJobId) {
      resetToScan();
      return;
    }

    try {
      await fetch(`${config.apiBaseUrl}/passprot/${activeJobId}/cancel`, { method: "POST" });
    } finally {
      activeJobId = null;
      clearJobPolling();
      resetToScan();
    }
  }

  function showError(_message) {
    clearJobPolling();
    errorText.textContent = genericRecognitionError;
    showScreen("error");
  }

  async function resetToScan() {
    activeJobId = null;
    lastPassportData = null;
    clearJobPolling();
    resetPassStatus();
    showScreen("scan");
    try {
      await startCamera();
    } catch (error) {
      console.warn(error);
    }
  }

  async function resetSession() {
    activeJobId = null;
    lastPassportData = null;
    clearJobPolling();
    await stopCamera();
    consentInput.checked = false;
    syncConsentState();
    stillPreview.src = "";
    stillPreview.classList.remove("is-visible");
    idleModal.hidden = true;
    showScreen("start");
  }

  function syncConsentState() {
    continueButton.disabled = !consentInput.checked;
    continueButton.setAttribute(
      "aria-label",
      consentInput.checked ? "Продолжить" : "Принять согласие и продолжить"
    );
  }

  consentInput.addEventListener("change", syncConsentState);

  continueButton.addEventListener("click", async () => {
    if (!consentInput.checked) {
      return;
    }
    syncConsentState();
    showScreen("scan");
    try {
      await startCamera();
    } catch (error) {
      console.warn(error);
    }
  });

  backToStartButton.addEventListener("click", resetSession);
  stayButton.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  stayButton.addEventListener("click", (event) => {
    event.stopPropagation();
    idleModal.hidden = true;
    resetIdleTimers();
  });

  scanButton.addEventListener("click", async () => {
    try {
      const file = await captureFromCamera();
      await submitFile(file);
    } catch (error) {
      showError(error.message || "Не удалось сделать снимок.");
    }
  });

  cancelButton.addEventListener("click", cancelJob);
  retakeButton.addEventListener("click", resetToScan);
  errorRetakeButton.addEventListener("click", resetToScan);
  errorHomeButton.addEventListener("click", resetSession);
  confirmButton.addEventListener("click", receivePass);

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    window.addEventListener(eventName, (event) => {
      if (idleModal.contains(event.target)) {
        return;
      }
      resetIdleTimers();
    }, { passive: true });
  });
})();
