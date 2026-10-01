# RB ICC — Website Komunitas Sepeda

## Isi paket
- `index.html`  — Website publik (beranda, tentang, kegiatan, kalender, galeri, berita, pengurus, kontak)
- `admin.html`  — Panel admin untuk mengelola seluruh konten
- `schema.sql`  — Skema database Supabase (tabel, RLS, storage bucket, data awal)

## Cara pasang (ringkas)
1. Buat project di https://supabase.com (gratis).
2. Buka **SQL Editor** di project Supabase, tempel isi `schema.sql`, lalu jalankan (Run).
3. Buka **Project Settings > API**, salin **Project URL** dan **anon public key**.
4. Buka `index.html` dan `admin.html` dengan teks editor, cari bagian `CONFIG` di awal tag `<script>`, isi:
   ```js
   const CONFIG = { SUPABASE_URL: "https://xxxxx.supabase.co", SUPABASE_ANON_KEY: "..." };
   ```
   Isi persis sama di kedua file.
5. Buat akun admin: Supabase > **Authentication > Users > Add user** (isi email & password).
6. Jadikan admin: di **SQL Editor**, jalankan (ganti email-nya):
   ```sql
   insert into public.admin_users (user_id, full_name, role)
   select id, 'Admin RB ICC', 'superadmin' from auth.users where email = 'admin@contoh.com';
   ```
7. Upload kedua file (`index.html`, `admin.html`) ke hosting statis pilihan Anda (Cloudflare Pages, Netlify, Vercel, dsb) dalam satu folder yang sama, lalu buka `index.html` sebagai beranda.
8. Masuk ke `admin.html` dengan email & password yang dibuat di langkah 5, lalu mulai isi profil, kegiatan, galeri, berita, dan anggota.

## Catatan
- Tanpa langkah 4 (CONFIG kosong), kedua halaman otomatis berjalan dalam **mode demo** dengan data contoh — berguna untuk pratinjau sebelum data asli disambungkan.
- Tautan "Masuk admin" (di footer situs publik) dan "Lihat website" (di sidebar admin) akan berfungsi begitu kedua file berada di folder/hosting yang sama.
