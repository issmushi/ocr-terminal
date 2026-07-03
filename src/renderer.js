(async () => {
  const fallbackConfig = {
    apiBaseUrl: "http://192.168.3.113:8000",
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

  const genericRecognitionError = "Не удалось распознать, попробуйте ещё раз.";
  const terminalStatuses = new Set(["done", "failed", "timeout", "cancelled"]);

  const fieldLabels = [
    ["surname", "Фамилия"],
    ["name", "Имя"],
    ["patronymic", "Отчество"],
    ["sex", "Пол"],
    ["date_of_birth", "Дата рождения"],
    ["passport_series", "Серия"],
    ["passport_number", "Номер"],
    ["mrz_line1", "MRZ строка 1", true],
    ["mrz_line2", "MRZ строка 2", true]
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
    const task = getTask(payload);

    resultFields.innerHTML = "";
    fieldLabels.forEach(([key, label, wide]) => {
      const card = document.createElement("div");
      card.className = `field-card${wide ? " wide" : ""}`;
      const value = data[key] || "Не распознано";
      card.innerHTML = `
        <div class="field-name">${label}</div>
        <div class="field-value${data[key] ? "" : " empty"}">${escapeHtml(value)}</div>
      `;
      resultFields.append(card);
    });

    confidenceBadge.textContent = confidenceText(data.confidence);
    confidenceBadge.className = `status-pill ${confidenceClass(data.confidence)}`;

    resultMeta.innerHTML = "";
    addMetaRow("Время", meta.processing_time_ms ? `${Math.round(meta.processing_time_ms / 1000)} сек.` : "нет данных");
    addMetaRow("Источник", meta.source || "нет данных");
    addMetaRow("Качество", imageQualityText(meta.image_quality));
    addMetaRow("Задача", (task?.job_id || getJobId(payload)).slice(0, 8));
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
    clearJobPolling();
    showScreen("scan");
    try {
      await startCamera();
    } catch (error) {
      console.warn(error);
    }
  }

  async function resetSession() {
    activeJobId = null;
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
  confirmButton.addEventListener("click", resetSession);

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    window.addEventListener(eventName, (event) => {
      if (idleModal.contains(event.target)) {
        return;
      }
      resetIdleTimers();
    }, { passive: true });
  });
})();
