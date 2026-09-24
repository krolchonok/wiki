const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");

const ROOT = __dirname;

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env optional if vars already set
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RESOURCES_PATH = path.join(ROOT, "data", "resources.json");
const RESOURCES_EXAMPLE_PATH = path.join(ROOT, "data", "resources.example.json");
const UPLOADS_DIR = path.join(ROOT, "assets", "uploads");
const ADMIN_SESSION_COOKIE = "wiki_admin_session";
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

if (!ADMIN_PASSWORD) {
  console.error("Задайте ADMIN_PASSWORD в файле .env (см. .env.example).");
  process.exit(1);
}

const ALLOWED_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

const app = express();
app.use(express.json({ limit: "256kb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mimeOk = Boolean(MIME_TO_EXT[file.mimetype]);
    const extOk = ALLOWED_IMAGE_EXT.has(ext);
    if (mimeOk || extOk) {
      cb(null, true);
      return;
    }
    cb(new Error("Можно загружать только изображения (png, jpg, svg, webp, gif)."));
  },
});

function parseCookies(req) {
  const header = req.get("cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function createAdminSessionToken() {
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  const payload = `admin.${expiresAt}`;
  const signature = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function isValidAdminSessionToken(token) {
  if (!token || typeof token !== "string") {
    return false;
  }
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== "admin") {
      return false;
    }
    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return false;
    }
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("hex");
    const actual = parts[2];
    if (expected.length !== actual.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch {
    return false;
  }
}

function setAdminSessionCookie(res, token) {
  const maxAgeSec = Math.floor(ADMIN_SESSION_MS / 1000);
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`,
  );
}

function clearAdminSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function isAdminAuthorized(req) {
  const cookies = parseCookies(req);
  if (isValidAdminSessionToken(cookies[ADMIN_SESSION_COOKIE])) {
    return true;
  }
  const password = req.get("x-admin-password") || "";
  return password === ADMIN_PASSWORD;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthorized(req)) {
    res.status(401).json({ error: "Неверный пароль администратора." });
    return;
  }
  next();
}

async function ensureUploadsDir() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

async function ensureResourcesFile() {
  try {
    await fsp.access(RESOURCES_PATH);
  } catch {
    let initial = "[]\n";
    try {
      initial = await fsp.readFile(RESOURCES_EXAMPLE_PATH, "utf8");
    } catch {
      // keep empty array
    }
    await fsp.mkdir(path.dirname(RESOURCES_PATH), { recursive: true });
    await fsp.writeFile(RESOURCES_PATH, initial, "utf8");
  }
}

async function readResources() {
  const raw = await fsp.readFile(RESOURCES_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error("resources.json must be an array");
  }
  return data.map(normalizeResource);
}

async function writeResources(resources) {
  const payload = `${JSON.stringify(resources, null, 2)}\n`;
  await fsp.writeFile(RESOURCES_PATH, payload, "utf8");
}

function slugifyId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildDetailsHtml(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return "<p>Подробная информация пока не добавлена.</p>";
  }

  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function isSafePreview(preview) {
  return (
    typeof preview === "string" &&
    /^assets\/(?:uploads\/)?[a-z0-9._-]+\.(svg|png|jpe?g|gif|webp)$/i.test(preview)
  );
}

function resolveImageExt(file) {
  const fromMime = MIME_TO_EXT[file.mimetype];
  if (fromMime) {
    return fromMime;
  }
  const fromName = path.extname(file.originalname || "").toLowerCase();
  if (ALLOWED_IMAGE_EXT.has(fromName)) {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }
  return null;
}

function parseRequiresAuth(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value == null || value === "") {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function normalizeResource(resource) {
  if (!resource || typeof resource !== "object") {
    return resource;
  }
  return {
    ...resource,
    requiresAuth: parseRequiresAuth(resource.requiresAuth),
  };
}

function readResourceFields(body) {
  const id = slugifyId(body?.id);
  const title = String(body?.title || "").trim();
  const description = String(body?.description || "").trim();
  const url = String(body?.url || "").trim();
  const preview = String(body?.preview || "assets/wiki.svg").trim();
  const details = String(body?.details || "").trim();
  const requiresAuth = parseRequiresAuth(body?.requiresAuth);
  return { id, title, description, url, preview, details, requiresAuth };
}

function validateResourceFields({ id, title, description, url }) {
  if (!id || !title || !description || !url) {
    return "Заполните id, title, description и url.";
  }
  if (!/^https?:\/\//i.test(url)) {
    return "URL должен начинаться с http:// или https://.";
  }
  return null;
}

async function saveUploadedIcon(id, file) {
  const ext = resolveImageExt(file);
  if (!ext) {
    throw new Error("Неподдерживаемый формат иконки.");
  }
  await ensureUploadsDir();
  const filename = `${id}${ext}`;
  await fsp.writeFile(path.join(UPLOADS_DIR, filename), file.buffer);
  return `assets/uploads/${filename}`;
}

async function removeUploadIfNeeded(preview) {
  if (preview && preview.startsWith("assets/uploads/")) {
    await fsp.unlink(path.join(ROOT, preview)).catch(() => {});
  }
}

app.get("/api/resources", async (_req, res) => {
  try {
    const resources = await readResources();
    res.json(resources);
  } catch (error) {
    res.status(500).json({ error: `Не удалось прочитать ресурсы: ${error.message}` });
  }
});

app.get("/api/admin/session", (req, res) => {
  res.json({ ok: isAdminAuthorized(req) });
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) {
    clearAdminSessionCookie(res);
    res.status(401).json({ error: "Неверный пароль." });
    return;
  }
  setAdminSessionCookie(res, createAdminSessionToken());
  res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/resources", requireAdmin, (req, res) => {
  upload.single("icon")(req, res, async (uploadError) => {
    if (uploadError) {
      res.status(400).json({ error: uploadError.message });
      return;
    }

    try {
      const fields = readResourceFields(req.body);
      const validationError = validateResourceFields(fields);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const resources = await readResources();
      if (resources.some((resource) => resource.id === fields.id)) {
        res.status(409).json({ error: `Ресурс с id "${fields.id}" уже существует.` });
        return;
      }

      let preview = fields.preview;
      if (req.file) {
        preview = await saveUploadedIcon(fields.id, req.file);
      } else if (!isSafePreview(preview)) {
        res.status(400).json({ error: "Некорректный путь превью." });
        return;
      }

      const resource = {
        id: fields.id,
        title: fields.title,
        description: fields.description,
        url: fields.url,
        preview,
        detailsPage: "",
        detailsHtml: buildDetailsHtml(fields.details),
        requiresAuth: fields.requiresAuth,
        custom: true,
      };

      resources.push(resource);
      await writeResources(resources);
      res.status(201).json(resource);
    } catch (error) {
      res.status(500).json({ error: `Не удалось сохранить ресурс: ${error.message}` });
    }
  });
});

app.put("/api/resources/:id", requireAdmin, (req, res) => {
  upload.single("icon")(req, res, async (uploadError) => {
    if (uploadError) {
      res.status(400).json({ error: uploadError.message });
      return;
    }

    try {
      const currentId = slugifyId(req.params.id);
      if (!currentId) {
        res.status(400).json({ error: "Некорректный id." });
        return;
      }

      const fields = readResourceFields({ ...req.body, id: currentId });
      const validationError = validateResourceFields(fields);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const resources = await readResources();
      const index = resources.findIndex((resource) => resource.id === currentId);
      if (index < 0) {
        res.status(404).json({ error: `Ресурс "${currentId}" не найден.` });
        return;
      }

      const existing = resources[index];
      let preview = existing.preview || "assets/wiki.svg";

      if (req.file) {
        const nextPreview = await saveUploadedIcon(currentId, req.file);
        if (existing.preview !== nextPreview) {
          await removeUploadIfNeeded(existing.preview);
        }
        preview = nextPreview;
      } else if (Object.prototype.hasOwnProperty.call(req.body, "preview")) {
        const nextPreview = String(req.body.preview || "").trim();
        if (!isSafePreview(nextPreview)) {
          res.status(400).json({ error: "Некорректный путь превью." });
          return;
        }
        if (nextPreview !== existing.preview) {
          await removeUploadIfNeeded(existing.preview);
        }
        preview = nextPreview;
      }

      const resource = {
        ...existing,
        id: currentId,
        title: fields.title,
        description: fields.description,
        url: fields.url,
        preview,
        detailsHtml: buildDetailsHtml(fields.details),
        requiresAuth: fields.requiresAuth,
      };

      resources[index] = resource;
      await writeResources(resources);
      res.json(resource);
    } catch (error) {
      res.status(500).json({ error: `Не удалось обновить ресурс: ${error.message}` });
    }
  });
});

app.delete("/api/resources/:id", requireAdmin, async (req, res) => {
  try {
    const id = slugifyId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Некорректный id." });
      return;
    }

    const resources = await readResources();
    const target = resources.find((resource) => resource.id === id);
    const next = resources.filter((resource) => resource.id !== id);
    if (next.length === resources.length) {
      res.status(404).json({ error: `Ресурс "${id}" не найден.` });
      return;
    }

    await writeResources(next);
    await removeUploadIfNeeded(target?.preview);

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: `Не удалось удалить ресурс: ${error.message}` });
  }
});

app.use(
  "/assets",
  express.static(path.join(ROOT, "assets"), {
    fallthrough: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".svg")) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      }
    },
  }),
);
app.use("/details", express.static(path.join(ROOT, "details")));
app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});
app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(ROOT, "styles.css"));
});
app.get("/app.js", (_req, res) => {
  res.sendFile(path.join(ROOT, "app.js"));
});

ensureUploadsDir()
  .then(() => ensureResourcesFile())
  .then(() => {
    const server = app.listen(PORT, HOST, () => {
      console.log(`Сервер запущен`);
      console.log(`  локально:  http://127.0.0.1:${PORT}`);
      console.log(`  по сети:   http://<IP-машины>:${PORT}`);
      console.log(`  слушает:   ${HOST}:${PORT}`);
    });

    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        console.error(`Порт ${PORT} уже занят. Остановите другой процесс или задайте PORT в .env`);
      } else {
        console.error("Ошибка запуска сервера:", error);
      }
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error("Не удалось подготовить данные:", error);
    process.exit(1);
  });
