const statusText = document.getElementById("status-text");
const progressInner = document.getElementById("progress-inner");
const progressOuter = document.querySelector(".progress-outer");
const grid = document.getElementById("resources-grid");
const modalLayer = document.getElementById("details-modal");
const modalCloseBtn = document.getElementById("modal-close");
const modalTitle = document.getElementById("modal-title");
const detailsContent = document.getElementById("details-content");

const adminOpenBtn = document.getElementById("admin-open");
const adminModal = document.getElementById("admin-modal");
const adminCloseBtn = document.getElementById("admin-close");
const adminLoginSection = document.getElementById("admin-login");
const adminPanelSection = document.getElementById("admin-panel");
const adminPasswordInput = document.getElementById("admin-password");
const adminLoginBtn = document.getElementById("admin-login-btn");
const adminLoginError = document.getElementById("admin-login-error");
const adminForm = document.getElementById("admin-form");
const adminFormStatus = document.getElementById("admin-form-status");
const adminFormMode = document.getElementById("admin-form-mode");
const adminCustomList = document.getElementById("admin-custom-list");
const adminRefreshBtn = document.getElementById("admin-refresh");
const adminSubmitBtn = document.getElementById("admin-submit");
const adminCancelEditBtn = document.getElementById("admin-cancel-edit");
const resourceIdInput = document.getElementById("resource-id");
const resourceEditIdInput = document.getElementById("resource-edit-id");
const resourcePreviewSelect = document.getElementById("resource-preview");

let allResources = [];
let adminLoggedIn = false;
let editingId = "";

function setProgress(value) {
  const safeValue = Math.max(0, Math.min(100, value));
  progressInner.style.width = `${safeValue}%`;
  progressOuter.setAttribute("aria-valuenow", String(safeValue));
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      adminLoggedIn = false;
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function adminFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  return fetch(url, {
    ...options,
    credentials: "include",
    headers,
  });
}

function previewUrl(preview) {
  const value = String(preview || "assets/wiki.svg").trim();
  if (!value) {
    return "/assets/wiki.svg";
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) {
    return value;
  }
  return `/${value.replace(/^\/+/, "")}`;
}

function requiresAuth(resource) {
  return Boolean(resource?.requiresAuth);
}

function createCard(resource) {
  const card = document.createElement("article");
  const needsAuth = requiresAuth(resource);
  card.className = `resource-card ${needsAuth ? "resource-card-auth" : "resource-card-open"}`;
  card.title = needsAuth ? "Требуется авторизация" : "Без авторизации";

  const previewWrap = document.createElement("div");
  previewWrap.className = "preview-wrap";

  const img = document.createElement("img");
  img.src = previewUrl(resource.preview);
  img.alt = `Превью: ${resource.title}`;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    if (!img.dataset.fallback) {
      img.dataset.fallback = "1";
      img.src = "/assets/wiki.svg";
    }
  });
  previewWrap.appendChild(img);

  const title = document.createElement("h2");
  title.className = "resource-title";
  title.textContent = resource.title;

  const desc = document.createElement("p");
  desc.className = "resource-desc";
  desc.textContent = resource.description;

  const actions = document.createElement("div");
  actions.className = "actions";

  const detailsBtn = document.createElement("button");
  detailsBtn.className = "win-btn";
  detailsBtn.type = "button";
  detailsBtn.textContent = "Подробнее";
  detailsBtn.addEventListener("click", () => {
    openDetailsModal(resource);
  });

  const openBtn = document.createElement("button");
  openBtn.className = "win-btn";
  openBtn.type = "button";
  openBtn.textContent = "Открыть";
  openBtn.addEventListener("click", () => {
    window.open(resource.url, "_blank", "noopener,noreferrer");
  });

  actions.append(detailsBtn, openBtn);
  card.append(previewWrap, title, desc, actions);
  return card;
}

function renderResources(resources) {
  allResources = resources;
  grid.textContent = "";
  resources.forEach((resource) => {
    grid.appendChild(createCard(resource));
  });
  statusText.textContent = `Ресурсов загружено: ${resources.length}`;
  renderAdminList();
}

async function openDetailsModal(resource) {
  modalTitle.textContent = `${resource.title} - Подробная информация`;
  detailsContent.textContent = "Загрузка...";
  modalLayer.classList.add("is-open");
  modalLayer.setAttribute("aria-hidden", "false");
  modalCloseBtn.focus();

  if (resource.detailsHtml) {
    detailsContent.innerHTML = resource.detailsHtml;
    return;
  }

  if (!resource.detailsPage) {
    detailsContent.textContent = "Нет данных для отображения.";
    return;
  }

  try {
    const response = await fetch(resource.detailsPage);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const panel = doc.querySelector(".panel");

    if (panel) {
      const clone = panel.cloneNode(true);
      clone
        .querySelectorAll('a[href="../index.html"], a[href="./index.html"], a[href="index.html"]')
        .forEach((link) => link.remove());
      detailsContent.innerHTML = clone.innerHTML;
      return;
    }

    detailsContent.textContent = doc.body?.textContent?.trim() || "Нет данных для отображения.";
  } catch (error) {
    detailsContent.textContent = `Ошибка загрузки подробностей (${error.message}).`;
  }
}

function closeDetailsModal() {
  if (!modalLayer.classList.contains("is-open")) {
    return;
  }
  modalLayer.classList.remove("is-open");
  modalLayer.setAttribute("aria-hidden", "true");
  detailsContent.textContent = "";
}

function showAdminLogin() {
  adminLoginSection.hidden = false;
  adminPanelSection.hidden = true;
  adminLoginError.hidden = true;
  adminPasswordInput.value = "";
  adminFormStatus.textContent = "";
}

function showAdminPanel() {
  adminLoginSection.hidden = true;
  adminPanelSection.hidden = false;
  adminLoginError.hidden = true;
  renderAdminList();
  adminForm.querySelector("#resource-id")?.focus();
}

async function refreshAdminSession() {
  try {
    const data = await parseJsonResponse(await adminFetch("/api/admin/session"));
    adminLoggedIn = Boolean(data.ok);
  } catch {
    adminLoggedIn = false;
  }
  return adminLoggedIn;
}

async function openAdminModal() {
  adminModal.classList.add("is-open");
  adminModal.setAttribute("aria-hidden", "false");
  await refreshAdminSession();
  if (adminLoggedIn) {
    showAdminPanel();
  } else {
    showAdminLogin();
    adminPasswordInput.focus();
  }
}

function closeAdminModal() {
  if (!adminModal.classList.contains("is-open")) {
    return;
  }
  adminModal.classList.remove("is-open");
  adminModal.setAttribute("aria-hidden", "true");
}

function detailsHtmlToText(html) {
  if (!html) {
    return "";
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = Array.from(doc.querySelectorAll("p"))
    .map((node) => node.textContent.trim())
    .filter(Boolean);
  if (paragraphs.length) {
    return paragraphs.join("\n");
  }
  return (doc.body?.textContent || "").trim();
}

function ensurePreviewOption(preview) {
  if (!preview || !resourcePreviewSelect) {
    return;
  }
  const exists = Array.from(resourcePreviewSelect.options).some((option) => option.value === preview);
  if (!exists) {
    const option = document.createElement("option");
    option.value = preview;
    option.textContent = preview.startsWith("assets/uploads/") ? "текущая загруженная" : preview;
    resourcePreviewSelect.appendChild(option);
  }
  resourcePreviewSelect.value = preview;
}

function setEditMode(resource) {
  editingId = resource?.id || "";
  if (resourceEditIdInput) {
    resourceEditIdInput.value = editingId;
  }

  if (!editingId) {
    adminSubmitBtn.textContent = "Добавить";
    adminCancelEditBtn.hidden = true;
    adminFormMode.hidden = true;
    resourceIdInput.readOnly = false;
    return;
  }

  adminSubmitBtn.textContent = "Сохранить";
  adminCancelEditBtn.hidden = false;
  adminFormMode.hidden = false;
  adminFormMode.textContent = `Редактирование: ${resource.title} (${resource.id})`;
  resourceIdInput.readOnly = true;
  resourceIdInput.value = resource.id;
  adminForm.elements.title.value = resource.title || "";
  adminForm.elements.description.value = resource.description || "";
  adminForm.elements.url.value = resource.url || "";
  adminForm.elements.details.value = detailsHtmlToText(resource.detailsHtml);
  adminForm.elements.icon.value = "";
  adminForm.elements.requiresAuth.checked = requiresAuth(resource);
  ensurePreviewOption(resource.preview || "assets/wiki.svg");
  adminFormStatus.textContent = "";
  resourceIdInput.focus();
}

function clearEditMode({ resetForm = true } = {}) {
  editingId = "";
  if (resourceEditIdInput) {
    resourceEditIdInput.value = "";
  }
  adminSubmitBtn.textContent = "Добавить";
  adminCancelEditBtn.hidden = true;
  adminFormMode.hidden = true;
  resourceIdInput.readOnly = false;
  if (resetForm) {
    adminForm.reset();
  }
}

function renderAdminList() {
  if (!adminCustomList) {
    return;
  }

  adminCustomList.textContent = "";

  if (!allResources.length) {
    const empty = document.createElement("li");
    empty.className = "admin-list-item";
    empty.textContent = "Список пуст.";
    adminCustomList.appendChild(empty);
    return;
  }

  allResources.forEach((resource) => {
    const item = document.createElement("li");
    item.className = "admin-list-item";
    if (editingId === resource.id) {
      item.classList.add("is-editing");
    }

    const label = document.createElement("span");
    const authMark = requiresAuth(resource) ? " [auth]" : "";
    label.textContent = `${resource.title} (${resource.id})${authMark}`;
    if (requiresAuth(resource)) {
      item.classList.add("admin-list-item-auth");
    } else {
      item.classList.add("admin-list-item-open");
    }

    const actions = document.createElement("div");
    actions.className = "admin-list-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "win-btn";
    editBtn.type = "button";
    editBtn.textContent = "Изменить";
    editBtn.disabled = !adminLoggedIn;
    editBtn.addEventListener("click", () => {
      setEditMode(resource);
      renderAdminList();
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "win-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "Удалить";
    removeBtn.disabled = !adminLoggedIn;
    removeBtn.addEventListener("click", async () => {
      if (!window.confirm(`Удалить ресурс «${resource.title}»?`)) {
        return;
      }
      try {
        await parseJsonResponse(
          await adminFetch(`/api/resources/${encodeURIComponent(resource.id)}`, {
            method: "DELETE",
          }),
        );
        if (editingId === resource.id) {
          clearEditMode();
        }
        adminFormStatus.textContent = `Удалён ресурс: ${resource.id}`;
        await loadResources({ quiet: true });
      } catch (error) {
        if (!adminLoggedIn) {
          showAdminLogin();
        }
        adminFormStatus.textContent = error.message;
      }
    });

    actions.append(editBtn, removeBtn);
    item.append(label, actions);
    adminCustomList.appendChild(item);
  });
}

async function tryAdminLogin() {
  const password = adminPasswordInput.value.trim();
  adminLoginError.hidden = true;

  try {
    await parseJsonResponse(
      await adminFetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    );
    adminLoggedIn = true;
    adminPasswordInput.value = "";
    showAdminPanel();
  } catch {
    adminLoggedIn = false;
    adminLoginError.hidden = false;
    adminPasswordInput.focus();
  }
}

function slugifyId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!adminLoggedIn) {
    adminFormStatus.textContent = "Сначала войдите в админ-меню.";
    return;
  }

  const formData = new FormData(adminForm);
  const id = editingId || slugifyId(formData.get("id"));
  formData.set("id", id);
  formData.set("title", String(formData.get("title") || "").trim());
  formData.set("description", String(formData.get("description") || "").trim());
  formData.set("url", String(formData.get("url") || "").trim());
  formData.set("details", String(formData.get("details") || "").trim());
  formData.set("requiresAuth", adminForm.elements.requiresAuth.checked ? "true" : "false");

  const icon = formData.get("icon");
  if (!(icon instanceof File) || !icon.size) {
    formData.delete("icon");
  }

  adminFormStatus.textContent = "Сохранение...";

  try {
    const endpoint = editingId
      ? `/api/resources/${encodeURIComponent(editingId)}`
      : "/api/resources";
    const method = editingId ? "PUT" : "POST";
    const saved = await parseJsonResponse(
      await adminFetch(endpoint, {
        method,
        body: formData,
      }),
    );
    const wasEdit = method === "PUT";
    clearEditMode();
    adminFormStatus.textContent = wasEdit
      ? `Сохранён ресурс: ${saved.title}`
      : `Добавлен ресурс: ${saved.title}`;
    await loadResources({ quiet: true });
  } catch (error) {
    if (!adminLoggedIn) {
      showAdminLogin();
    }
    adminFormStatus.textContent = error.message;
  }
});

adminCancelEditBtn.addEventListener("click", () => {
  clearEditMode();
  adminFormStatus.textContent = "Редактирование отменено.";
  renderAdminList();
});

adminRefreshBtn.addEventListener("click", async () => {
  adminFormStatus.textContent = "Обновление...";
  try {
    await loadResources({ quiet: true });
    adminFormStatus.textContent = "Список обновлён.";
  } catch (error) {
    adminFormStatus.textContent = error.message;
  }
});

adminOpenBtn.addEventListener("click", openAdminModal);
adminCloseBtn.addEventListener("click", closeAdminModal);
adminLoginBtn.addEventListener("click", tryAdminLogin);
adminPasswordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    tryAdminLogin();
  }
});

adminModal.addEventListener("click", (event) => {
  if (event.target === adminModal) {
    closeAdminModal();
  }
});

modalCloseBtn.addEventListener("click", closeDetailsModal);

modalLayer.addEventListener("click", (event) => {
  if (event.target === modalLayer) {
    closeDetailsModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (adminModal.classList.contains("is-open")) {
    closeAdminModal();
    return;
  }
  closeDetailsModal();
});

async function loadResources({ quiet = false } = {}) {
  try {
    if (!quiet) {
      setProgress(20);
    }

    const response = await fetch("/api/resources");
    if (!quiet) {
      setProgress(55);
    }

    const resources = await parseJsonResponse(response);
    if (!quiet) {
      setProgress(80);
    }

    renderResources(resources);

    if (!quiet) {
      setProgress(100);
    }
  } catch (error) {
    if (!quiet) {
      setProgress(100);
    }
    statusText.textContent = "Ошибка загрузки ресурсов.";
    grid.textContent = "";

    const errorText = document.createElement("p");
    errorText.className = "resource-desc";
    errorText.textContent = `Проверьте, что сервер запущен (${error.message}).`;
    grid.appendChild(errorText);
    throw error;
  }
}

loadResources().catch(() => {});
refreshAdminSession().catch(() => {});
