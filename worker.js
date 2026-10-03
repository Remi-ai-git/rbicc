/**
 * RB ICC — Worker API
 * Jembatan antara index.html/admin.html dan D1 (database) + GitHub (penyimpanan foto — gratis tanpa kartu kredit).
 * Deploy apa adanya (tanpa build step) lewat dashboard Cloudflare atau `wrangler deploy`.
 *
 * Binding yang dibutuhkan (lihat wrangler.toml):
 *   DB     -> D1 database "rbicc-db"
 * Variabel yang dibutuhkan (lihat wrangler.toml [vars]):
 *   GITHUB_REPO   -> "namapengguna/rbicc-media" (repo PUBLIC, sudah ada 1 commit/README)
 * Secret yang dibutuhkan (wrangler secret put <nama>):
 *   ADMIN_SECRET  -> string acak panjang, untuk menandatangani sesi login admin
 *   SETUP_KEY     -> string acak, dipakai SEKALI SAJA untuk membuat akun admin pertama
 *   GITHUB_TOKEN  -> GitHub fine-grained Personal Access Token, izin "Contents: Read and write" pada repo di atas saja
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Setup-Key",
    "Access-Control-Max-Age": "86400",
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { ...JSON_HEADERS, ...corsHeaders(origin) } });
}
function err(message, status, origin) { return json({ ok: false, error: message }, status || 400, origin); }

/* ---------- util ---------- */
const enc = new TextEncoder();
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlToBytes(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }
function newId() { return crypto.randomUUID(); }
function slugify(s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80); }
function b(v) { return v ? 1 : 0; }           // bool -> 0/1 for D1
function ub(v) { return !!v; }                 // 0/1 -> bool for client

/* ---------- password hashing (PBKDF2-SHA256) ---------- */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10), salt = b64urlToBytes(parts[2]), expected = b64urlToBytes(parts[3]);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256));
  return timingSafeEqual(bits, expected);
}

/* ---------- session token (HMAC-SHA256, bukan library JWT) ---------- */
async function hmacKey(secret) { return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${sig}`;
}
async function verifyToken(token, secret) {
  if (!token) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), enc.encode(body));
  if (!ok) return null;
  let payload; try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verifyToken(token, env.ADMIN_SECRET);
  return payload; // {sub,email,exp} atau null
}

/* ---------- mapping baris D1 <-> JSON klien ---------- */
function mapEvent(r) { return r; } // semua field sudah TEXT/REAL/INTEGER apa adanya
function mapAlbum(r) { return { ...r, published: ub(r.published) }; }
function mapMember(r) { return { ...r, is_board: ub(r.is_board), is_active: ub(r.is_active) }; }

/* ================= Handler utama ================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });

    try {
      // ---------- Data publik (satu panggilan untuk seluruh situs) ----------
      if (method === "GET" && path === "/api/public") {
        const [gen, con, events, albumsRaw, photosRaw, posts, members] = await Promise.all([
          env.DB.prepare("SELECT value FROM settings WHERE key='general'").first(),
          env.DB.prepare("SELECT value FROM settings WHERE key='contact'").first(),
          env.DB.prepare("SELECT * FROM events WHERE status IN ('published','cancelled') ORDER BY start_at").all(),
          env.DB.prepare("SELECT * FROM albums WHERE published=1 ORDER BY taken_on DESC").all(),
          env.DB.prepare("SELECT p.* FROM photos p JOIN albums a ON a.id=p.album_id WHERE a.published=1 ORDER BY p.sort_order").all(),
          env.DB.prepare("SELECT * FROM posts WHERE status='published' ORDER BY published_at DESC").all(),
          env.DB.prepare("SELECT * FROM members WHERE is_active=1 ORDER BY sort_order").all(),
        ]);
        const photosByAlbum = {};
        for (const p of photosRaw.results) (photosByAlbum[p.album_id] ||= []).push(p);
        const albums = albumsRaw.results.map(a => ({ ...mapAlbum(a), photos: photosByAlbum[a.id] || [] }));
        return json({
          general: gen ? JSON.parse(gen.value) : {}, contact: con ? JSON.parse(con.value) : {},
          events: events.results.map(mapEvent), albums, posts: posts.results, members: members.results.map(mapMember),
          memberCount: members.results.length,
        }, 200, origin);
      }

      // ---------- Status & setup admin pertama ----------
      if (method === "GET" && path === "/api/setup/status") {
        const row = await env.DB.prepare("SELECT COUNT(*) c FROM admin_users").first();
        return json({ hasAdmin: row.c > 0 }, 200, origin);
      }
      if (method === "POST" && path === "/api/setup") {
        const row = await env.DB.prepare("SELECT COUNT(*) c FROM admin_users").first();
        if (row.c > 0) return err("Admin sudah ada. Gunakan halaman masuk biasa.", 403, origin);
        if ((request.headers.get("X-Setup-Key") || "") !== env.SETUP_KEY) return err("Kunci setup salah.", 403, origin);
        const body = await request.json().catch(() => ({}));
        if (!body.email || !body.password || body.password.length < 8) return err("Email dan kata sandi (min. 8 karakter) wajib diisi.", 400, origin);
        const hash = await hashPassword(body.password);
        await env.DB.prepare("INSERT INTO admin_users (id,email,password_hash,full_name,role) VALUES (?,?,?,?,?)")
          .bind(newId(), body.email.trim().toLowerCase(), hash, body.full_name || "Admin", "superadmin").run();
        return json({ ok: true }, 200, origin);
      }

      // ---------- Login ----------
      if (method === "POST" && path === "/api/login") {
        const body = await request.json().catch(() => ({}));
        const row = await env.DB.prepare("SELECT * FROM admin_users WHERE email=?").bind(String(body.email || "").trim().toLowerCase()).first();
        if (!row || !(await verifyPassword(body.password || "", row.password_hash))) return err("Email atau kata sandi salah.", 401, origin);
        const token = await signToken({ sub: row.id, email: row.email, exp: Date.now() + 7 * 86400000 }, env.ADMIN_SECRET);
        return json({ ok: true, token, email: row.email }, 200, origin);
      }

      // ---------- Mulai sini: semua butuh admin ----------
      if (path.startsWith("/api/admin/")) {
        const session = await requireAdmin(request, env);
        if (!session) return err("Sesi tidak valid atau kedaluwarsa. Silakan masuk lagi.", 401, origin);
        const rest = path.slice("/api/admin/".length).split("/").filter(Boolean);

        // GET /api/admin/session
        if (method === "GET" && rest[0] === "session") return json({ email: session.email }, 200, origin);

        // /api/admin/settings/:key
        if (rest[0] === "settings" && rest[1]) {
          const key = rest[1];
          if (method === "GET") { const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first(); return json(row ? JSON.parse(row.value) : {}, 200, origin); }
          if (method === "PUT") { const body = await request.json().catch(() => ({})); await env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(key, JSON.stringify(body)).run(); return json(body, 200, origin); }
        }

        // /api/admin/events[/:id]
        if (rest[0] === "events") {
          if (method === "GET" && !rest[1]) { const r = await env.DB.prepare("SELECT * FROM events ORDER BY start_at DESC").all(); return json(r.results, 200, origin); }
          if (method === "PUT" && rest[1]) {
            const v = await request.json().catch(() => ({})); const id = rest[1]; v.slug = v.slug || slugify(v.title);
            await env.DB.prepare(`INSERT INTO events (id,title,slug,category,level,description,start_at,end_at,meeting_point,meeting_map_url,route_name,distance_km,elevation_m,cover_url,registration_url,status,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(id) DO UPDATE SET title=excluded.title,slug=excluded.slug,category=excluded.category,level=excluded.level,description=excluded.description,start_at=excluded.start_at,end_at=excluded.end_at,meeting_point=excluded.meeting_point,meeting_map_url=excluded.meeting_map_url,route_name=excluded.route_name,distance_km=excluded.distance_km,elevation_m=excluded.elevation_m,cover_url=excluded.cover_url,registration_url=excluded.registration_url,status=excluded.status,updated_at=excluded.updated_at`)
              .bind(id, v.title, v.slug, v.category, v.level, v.description || null, v.start_at, v.end_at || null, v.meeting_point || null, v.meeting_map_url || null, v.route_name || null, v.distance_km ?? null, v.elevation_m ?? null, v.cover_url || null, v.registration_url || null, v.status).run();
            return json({ ...v, id }, 200, origin);
          }
          if (method === "DELETE" && rest[1]) { await env.DB.prepare("DELETE FROM events WHERE id=?").bind(rest[1]).run(); return json({ ok: true }, 200, origin); }
        }

        // /api/admin/albums[/:id][/photos[/:photoId]]
        if (rest[0] === "albums") {
          if (method === "GET" && !rest[1]) {
            const albums = await env.DB.prepare("SELECT * FROM albums ORDER BY taken_on DESC").all();
            const photos = await env.DB.prepare("SELECT * FROM photos ORDER BY sort_order").all();
            const byAlbum = {}; for (const p of photos.results) (byAlbum[p.album_id] ||= []).push(p);
            return json(albums.results.map(a => ({ ...mapAlbum(a), photos: byAlbum[a.id] || [] })), 200, origin);
          }
          if (method === "PUT" && rest[1] && !rest[2]) {
            const v = await request.json().catch(() => ({})); const id = rest[1];
            await env.DB.prepare(`INSERT INTO albums (id,title,description,event_id,cover_url,taken_on,published,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,event_id=excluded.event_id,cover_url=excluded.cover_url,taken_on=excluded.taken_on,published=excluded.published,updated_at=excluded.updated_at`)
              .bind(id, v.title, v.description || null, v.event_id || null, v.cover_url || null, v.taken_on || null, b(v.published)).run();
            return json({ ...v, id }, 200, origin);
          }
          if (method === "DELETE" && rest[1] && !rest[2]) {
            await env.DB.batch([env.DB.prepare("DELETE FROM photos WHERE album_id=?").bind(rest[1]), env.DB.prepare("DELETE FROM albums WHERE id=?").bind(rest[1])]);
            return json({ ok: true }, 200, origin);
          }
          if (method === "POST" && rest[1] && rest[2] === "photos") {
            const v = await request.json().catch(() => ({})); const id = newId();
            await env.DB.prepare("INSERT INTO photos (id,album_id,url,caption,sort_order) VALUES (?,?,?,?,?)").bind(id, rest[1], v.url, v.caption || "", Date.now()).run();
            return json({ id, album_id: rest[1], url: v.url, caption: v.caption || "", sort_order: Date.now() }, 200, origin);
          }
          if (method === "DELETE" && rest[1] && rest[2] === "photos" && rest[3]) {
            await env.DB.prepare("DELETE FROM photos WHERE id=? AND album_id=?").bind(rest[3], rest[1]).run();
            return json({ ok: true }, 200, origin);
          }
        }

        // /api/admin/posts[/:id]
        if (rest[0] === "posts") {
          if (method === "GET" && !rest[1]) { const r = await env.DB.prepare("SELECT * FROM posts ORDER BY published_at DESC").all(); return json(r.results, 200, origin); }
          if (method === "PUT" && rest[1]) {
            const v = await request.json().catch(() => ({})); const id = rest[1]; v.slug = v.slug || slugify(v.title);
            if (v.status === "published" && !v.published_at) v.published_at = new Date().toISOString();
            await env.DB.prepare(`INSERT INTO posts (id,title,slug,category,excerpt,content,cover_url,author_name,status,published_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(id) DO UPDATE SET title=excluded.title,slug=excluded.slug,category=excluded.category,excerpt=excluded.excerpt,content=excluded.content,cover_url=excluded.cover_url,author_name=excluded.author_name,status=excluded.status,published_at=COALESCE(posts.published_at,excluded.published_at),updated_at=excluded.updated_at`)
              .bind(id, v.title, v.slug, v.category, v.excerpt || null, v.content || null, v.cover_url || null, v.author_name || null, v.status, v.published_at || null).run();
            return json({ ...v, id }, 200, origin);
          }
          if (method === "DELETE" && rest[1]) { await env.DB.prepare("DELETE FROM posts WHERE id=?").bind(rest[1]).run(); return json({ ok: true }, 200, origin); }
        }

        // /api/admin/members[/:id]
        if (rest[0] === "members") {
          if (method === "GET" && !rest[1]) { const r = await env.DB.prepare("SELECT * FROM members ORDER BY sort_order").all(); return json(r.results.map(mapMember), 200, origin); }
          if (method === "PUT" && rest[1]) {
            const v = await request.json().catch(() => ({})); const id = rest[1];
            await env.DB.prepare(`INSERT INTO members (id,name,position,division,is_board,photo_url,bio,instagram,joined_year,is_active,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position,division=excluded.division,is_board=excluded.is_board,photo_url=excluded.photo_url,bio=excluded.bio,instagram=excluded.instagram,joined_year=excluded.joined_year,is_active=excluded.is_active,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
              .bind(id, v.name, v.position || null, v.division || null, b(v.is_board), v.photo_url || null, v.bio || null, v.instagram || null, v.joined_year ?? null, b(v.is_active), v.sort_order ?? 0).run();
            return json({ ...v, id }, 200, origin);
          }
          if (method === "DELETE" && rest[1]) { await env.DB.prepare("DELETE FROM members WHERE id=?").bind(rest[1]).run(); return json({ ok: true }, 200, origin); }
        }

        // POST /api/admin/upload  (multipart/form-data, field "file") -> disimpan ke repo GitHub, dilayani via raw.githubusercontent.com
        if (method === "POST" && rest[0] === "upload") {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") return err("Tidak ada file.", 400, origin);
          if (file.size > 9 * 1024 * 1024) return err("Ukuran file terlalu besar (maks 9MB).", 413, origin);
          const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "");
          const path2 = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;
          const bytes = new Uint8Array(await file.arrayBuffer());
          let bin = ""; const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          const base64 = btoa(bin);
          const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path2}`, {
            method: "PUT",
            headers: { "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "rbicc-worker", "Accept": "application/vnd.github+json" },
            body: JSON.stringify({ message: `upload: ${path2}`, content: base64 }),
          });
          if (!ghRes.ok) { const t = await ghRes.text(); return err("Gagal unggah ke GitHub: " + t.slice(0, 200), 502, origin); }
          return json({ url: `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/${path2}` }, 200, origin);
        }

        return err("Rute tidak ditemukan.", 404, origin);
      }

      return err("Rute tidak ditemukan.", 404, origin);
    } catch (e) {
      return err("Kesalahan server: " + (e.message || String(e)), 500, origin);
    }
  },
};
