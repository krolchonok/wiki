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
app.use(express.static(ROOT));

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

function requireAdmin(req, res, next) {
  const password = req.get("x-admin-password") || "";
  if (password !== ADMIN_PASSWORD) {
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
  return data;
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

app.get("/api/resources", async (_req, res) => {
  try {
    const resources = await readResources();
    res.json(resources);
  } catch (error) {
    res.status(500).json({ error: `Не удалось прочитать ресурсы: ${error.message}` });
  }
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Неверный пароль." });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/resources", requireAdmin, (req, res) => {
  upload.single("icon")(req, res, async (uploadError) => {
    if (uploadError) {
      res.status(400).json({ error: uploadError.message });
      return;
    }

    try {
      const id = slugifyId(req.body?.id);
      const title = String(req.body?.title || "").trim();
      const description = String(req.body?.description || "").trim();
      const url = String(req.body?.url || "").trim();
      let preview = String(req.body?.preview || "assets/wiki.svg").trim();
      const details = String(req.body?.details || "").trim();

      if (!id || !title || !description || !url) {
        res.status(400).json({ error: "Заполните id, title, description и url." });
        return;
      }

      if (!/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: "URL должен начинаться с http:// или https://." });
        return;
      }

      const resources = await readResources();
      if (resources.some((resource) => resource.id === id)) {
        res.status(409).json({ error: `Ресурс с id "${id}" уже существует.` });
        return;
      }

      if (req.file) {
        const ext = resolveImageExt(req.file);
        if (!ext) {
          res.status(400).json({ error: "Неподдерживаемый формат иконки." });
          return;
        }
        await ensureUploadsDir();
        const filename = `${id}${ext}`;
        await fsp.writeFile(path.join(UPLOADS_DIR, filename), req.file.buffer);
        preview = `assets/uploads/${filename}`;
      } else if (!isSafePreview(preview)) {
        res.status(400).json({ error: "Некорректный путь превью." });
        return;
      }

      const resource = {
        id,
        title,
        description,
        url,
        preview,
        detailsPage: "",
        detailsHtml: buildDetailsHtml(details),
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

    if (target?.preview && target.preview.startsWith("assets/uploads/")) {
      const iconPath = path.join(ROOT, target.preview);
      await fsp.unlink(iconPath).catch(() => {});
    }

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: `Не удалось удалить ресурс: ${error.message}` });
  }
});

ensureUploadsDir()
  .then(() => ensureResourcesFile())
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Wiki: http://${HOST}:${PORT}`);
      console.log(`Админ-пароль задаётся через ADMIN_PASSWORD (сейчас длина: ${ADMIN_PASSWORD.length})`);
    });
  })
  .catch((error) => {
    console.error("Не удалось подготовить данные:", error);
    process.exit(1);
  });
