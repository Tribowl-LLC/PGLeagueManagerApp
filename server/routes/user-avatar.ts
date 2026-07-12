import { Router, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { sendSuccess, sendError } from "../utils/api";
import { singleRouteParam } from '../utils/route-params';
import { createLogger } from '../logger';

const log = createLogger("UserAvatar");

const router = Router();

const AVATARS_DIR = path.join(process.cwd(), "uploads", "avatars");

const MAGIC_BYTES: { ext: string; mime: string; check: (buf: Buffer) => boolean }[] = [
  {
    ext: "jpg",
    mime: "image/jpeg",
    check: (buf) => buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
  },
  {
    ext: "png",
    mime: "image/png",
    check: (buf) =>
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A,
  },
  {
    ext: "gif",
    mime: "image/gif",
    check: (buf) =>
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
  },
  {
    ext: "webp",
    mime: "image/webp",
    check: (buf) =>
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50,
  },
];

// Mirror of MAGIC_BYTES used when serving from disk: extension → MIME.
// Anything not on this list is rejected at upload time, so the GET
// handler can safely treat the on-disk extension as authoritative.
const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// Preferred order when more than one variant exists on disk for a
// given user id (legacy state from older uploads that didn't clear
// siblings). First match wins.
const PREFERRED_EXTS = ["jpg", "png", "webp", "gif"];

function detectImageTypeFromBuffer(buf: Buffer): { ext: string; mime: string } | null {
  for (const entry of MAGIC_BYTES) {
    if (buf.length >= 12 && entry.check(buf)) {
      return { ext: entry.ext, mime: entry.mime };
    }
  }
  return null;
}

function removeOldAvatarFiles(userId: number): void {
  try {
    const files = fs.readdirSync(AVATARS_DIR);
    for (const file of files) {
      if (file.startsWith(`${userId}.`)) {
        fs.unlinkSync(path.join(AVATARS_DIR, file));
      }
    }
  } catch (error) {
    log.warn(`Failed to remove old avatar files for user ${userId}:`, error);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

router.post("/avatar", upload.single("avatar"), async (req: Request, res: Response) => {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  try {
    const userId = req.user.id;

    if (!req.file) {
      return sendError(res, "No file uploaded", 400);
    }

    const detected = detectImageTypeFromBuffer(req.file.buffer);

    if (!detected) {
      return sendError(res, "Invalid file content. The file is not a valid JPEG, PNG, GIF, or WebP image.", 400);
    }

    fs.mkdirSync(AVATARS_DIR, { recursive: true });

    removeOldAvatarFiles(userId);

    const filename = `${userId}.${detected.ext}`;
    const filePath = path.join(AVATARS_DIR, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    // The `?v=<ts>` query string is a per-upload cache buster. The
    // GET handler ignores the value — it's only there so a fresh
    // upload doesn't get masked by a stale browser cache entry
    // keyed off the previous URL.
    const avatarUrl = `/api/user/avatar/${userId}?v=${Date.now()}`;
    const { storage } = await import("../storage");
    await storage.updateUser(userId, { avatar: avatarUrl });

    return sendSuccess(res, { avatarUrl });
  } catch (error) {
    log.error("Upload error:", error);
    return sendError(res, "Upload failed", 500);
  }
});

// Streams the avatar file from disk. Mounted under `requireAuth`
// in `server/routes/index.ts`, so anonymous callers cannot
// enumerate by sweeping integer user ids — which was possible
// when this directory was served statically at `/uploads/avatars`
// (filenames are `${userId}.${ext}`, fully predictable).
router.get("/avatar/:userId", async (req: Request, res: Response) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.userId), 10);
    if (isNaN(userId)) {
      return sendError(res, "Invalid user ID", 400);
    }

    let files: string[];
    try {
      files = fs.readdirSync(AVATARS_DIR).filter(f => f.startsWith(`${userId}.`));
    } catch {
      return sendError(res, "Avatar not found", 404, "NOT_FOUND");
    }
    if (files.length === 0) {
      return sendError(res, "Avatar not found", 404, "NOT_FOUND");
    }

    const sorted = files.sort((a, b) => {
      const extA = a.split('.').pop() || '';
      const extB = b.split('.').pop() || '';
      return PREFERRED_EXTS.indexOf(extA) - PREFERRED_EXTS.indexOf(extB);
    });
    const filename = sorted[0];
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const mime = EXT_TO_MIME[ext];
    if (!mime) {
      return sendError(res, "Avatar not found", 404, "NOT_FOUND");
    }

    const filePath = path.join(AVATARS_DIR, filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return sendError(res, "Avatar not found", 404, "NOT_FOUND");
    }

    // Per-user, no-shared-cache. The URL itself carries a `?v=<ts>`
    // cache buster on every fresh upload, so a 1-hour private cache
    // is safe.
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", stat.size.toString());
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    log.error("Serve avatar error:", error);
    return sendError(res, "Failed to serve avatar", 500);
  }
});

router.get("/avatar", async (req: Request, res: Response) => {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  try {
    const userId = req.user.id;
    const { storage } = await import("../storage");
    const user = await storage.getUser(userId);

    if (!user || !user.avatar) {
      return sendError(res, "Avatar not found", 404, 'NOT_FOUND');
    }

    return sendSuccess(res, { avatarUrl: user.avatar });
  } catch (error) {
    log.error("Get avatar error:", error);
    return sendError(res, "Failed to get avatar", 500);
  }
});

router.delete("/avatar", async (req: Request, res: Response) => {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  try {
    const userId = req.user.id;

    removeOldAvatarFiles(userId);

    const { storage } = await import("../storage");
    await storage.updateUser(userId, { avatar: null });

    return sendSuccess(res, { message: "Avatar deleted successfully" });
  } catch (error) {
    log.error("Delete avatar error:", error);
    return sendError(res, "Failed to delete avatar", 500);
  }
});

export default router;
