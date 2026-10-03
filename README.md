# RB ICC — Website Komunitas Sepeda (Cloudflare D1 + Worker + GitHub untuk foto)

## Isi paket
- `index.html`      — Website publik
- `admin.html`       — Panel admin
- `worker.js`        — API backend (jembatan ke D1 & GitHub) — satu file, tanpa build step
- `wrangler.toml`    — Konfigurasi deploy (sudah terisi binding ke database Anda)

## Kenapa foto disimpan di GitHub, bukan R2?
Supaya **tidak perlu kartu kredit sama sekali**. R2 (penyimpanan file Cloudflare) mewajibkan kartu pembayaran saat diaktifkan pertama kali — murni verifikasi anti-penyalahgunaan, tapi tetap langkah yang mau dihindari. Database (D1), API (Worker), dan hosting situs tetap 100% gratis tanpa kartu. Foto disimpan di repo GitHub publik dan dilayani langsung lewat `raw.githubusercontent.com` — gratis selamanya, tanpa kartu, tanpa batas waktu percobaan.
Trade-off: repo GitHub publik berarti foto bisa diakses siapa pun lewat URL langsung (wajar untuk galeri komunitas yang memang publik) dan sebaiknya jangan dipakai untuk menyimpan ribuan foto resolusi penuh — makanya admin panel otomatis mengecilkan foto ke maks 1920px sebelum diunggah.

## Sudah saya siapkan dari sini
- Database D1 **`rbicc-db`** sudah dibuat beserta 7 tabel (`settings`, `events`, `albums`, `photos`, `posts`, `members`, `admin_users`) dan data awal profil.

## Yang perlu Anda lakukan

### 1. Repo GitHub untuk foto — sudah siap ✅
Repo **`Remi-ai-git/rbicc`** sudah Anda buat dan sudah Public — tidak perlu buat repo baru. Foto akan disimpan di folder `photos/` di dalam repo ini.

### 2. Buat token akses GitHub (khusus repo ini saja)
GitHub → foto profil (kanan atas) → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
- **Repository access**: pilih **Only select repositories** → pilih `rbicc`.
- **Permissions** → **Repository permissions** → **Contents** → ubah ke **Read and write**.
- **Generate token** → **salin tokennya sekarang** (hanya tampil sekali).

### 3. Deploy Worker (`worker.js`)
**Opsi A — lewat dashboard (paling mudah, tanpa install apa pun):**
1. Dashboard Cloudflare → **Workers & Pages** → **Create** → **Workers** → beri nama `rbicc` (sudah dibuat) → **Deploy** (pakai kode contoh dulu, nanti ditimpa).
2. Buka Worker yang baru dibuat → tab **Edit code** → hapus semua isi → tempel seluruh isi `worker.js` → **Deploy**.
3. Kembali ke halaman Worker → tab **Settings > Variables** →
   - **D1 Database Bindings** → tambah: Variable name = `DB`, Database = `rbicc-db`.
   - **Environment Variables** → **Add** →
     - Tipe **Text** (biasa): `GITHUB_REPO` = `Remi-ai-git/rbicc` (sudah pasti, tinggal salin)
     - Tipe **Secret** (terenkripsi), tiga ini persis:
       ```
       ADMIN_SECRET = <isi string acak panjang — JANGAN ditulis di repo>
       SETUP_KEY    = <isi string acak — JANGAN ditulis di repo>
       GITHUB_TOKEN = <token dari Langkah 2>
       ```
       (Nilai rahasia ini hanya disimpan di Cloudflare, tidak pernah di repo karena repo ini publik.)
4. **Save and deploy**.

**Opsi B — lewat CLI (`wrangler`), kalau Anda terbiasa:**
```bash
npm install -g wrangler
wrangler login
cd rbicc
# wrangler.toml sudah berisi GITHUB_REPO = "Remi-ai-git/rbicc", tidak perlu diubah
wrangler secret put ADMIN_SECRET   # tempel: <isi string acak panjang — JANGAN ditulis di repo>
wrangler secret put SETUP_KEY      # tempel: <isi string acak — JANGAN ditulis di repo>
wrangler secret put GITHUB_TOKEN   # tempel token dari Langkah 2
wrangler deploy
```

### 4. Catat URL Worker Anda
Setelah deploy, Cloudflare memberi URL seperti:
```
https://rbicc.<nama-subdomain-anda>.workers.dev
```

### 5. Isi `API_BASE` di kedua file
Buka `index.html` dan `admin.html`, cari `API_BASE` di awal `<script>`, isi persis sama di kedua file:
```js
const API_BASE = "https://rbicc.<nama-subdomain-anda>.workers.dev";
```

### 6. Buat akun admin pertama
Upload `index.html` & `admin.html` ke hosting (boleh Cloudflare Pages, Netlify, dll — bebas, karena semua data lewat Worker). Buka `admin.html` — karena belum ada admin, akan muncul form **"Buat akun admin pertama"**: isi nama, email, kata sandi, dan **Kunci setup** (nilai `SETUP_KEY` dari Langkah 3). Setelah berhasil, form berganti ke halaman masuk biasa.

## Catatan
- Tanpa Langkah 5 (`API_BASE` kosong), kedua halaman tetap berjalan dalam **mode demo** dengan data contoh — aman dicoba kapan saja.
- Foto otomatis dikecilkan (maks 1920px, JPEG ~85%) di browser sebelum diunggah — lebih cepat dan hemat kuota repo GitHub.
- Form "Buat akun admin pertama" otomatis terkunci begitu admin pertama dibuat (dicegah di sisi server).
- Butuh admin tambahan nanti? Minta saya jalankan `INSERT` langsung ke tabel `admin_users` lewat koneksi D1 ini.

## Deploy otomatis dari repo ini
Di Cloudflare: Workers & Pages → `rbicc` → Settings → Build → **Connect** → pilih repo `Remi-ai-git/rbicc`, branch `main`. Setelah tersambung, setiap perubahan di repo ini otomatis di-deploy ulang ke Worker `rbicc` (memakai `wrangler.toml`). Binding `DB` dan secret tetap diatur di dashboard Cloudflare.
