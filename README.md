# KasKelas — Starter Firebase

Starter project dashboard kas kelas: HTML/CSS/JavaScript + Firebase Authentication, Firestore, Cloud Functions, Hosting.

## Fitur yang sudah disiapkan
- Dashboard publik untuk data pada koleksi `public*` yang sudah disaring.
- Login bendahara Email/Password (akun dibuat manual; tidak ada pendaftaran publik).
- Callable Cloud Functions untuk mencatat pembayaran dan transaksi.
- Firestore Rules menolak penulisan browser langsung.
- Arsip laporan dan scheduler tanggal 1.
- Ekspor CSV yang dapat dibuka di Excel, dan cetak browser ke PDF.

## Penting sebelum produksi
Ini starter untuk pengembangan, bukan aplikasi yang langsung aman dipakai dengan uang sungguhan. Perlu menambahkan alur admin untuk mengelola siswa, menguji seluruh Rules dan Functions, mengaktifkan App Check, menambahkan pengujian otomatis, dan meninjau konsistensi transaksi/public projection. Jangan masukkan data asli sebelum diuji di Firebase Emulator.

## 1. Prasyarat
- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- Akun Google dan project Firebase

## 2. Setup Firebase
1. Buat project di Firebase Console.
2. Buat Web App dan salin konfigurasi.
3. Aktifkan Authentication > Sign-in method > Email/Password.
4. Buat Firestore Database.
5. Ganti placeholder `firebaseConfig` di `public/app.js`.
6. Pastikan billing/Blaze tersedia untuk Cloud Functions dan Scheduler.

## 3. Instal dan deploy
Di folder proyek:
```bash
firebase login
firebase use --add
cd functions
npm install
cd ..
firebase deploy --only firestore:rules,functions,hosting
```
Jika deploy function gagal karena project belum menggunakan Blaze atau API terkait belum aktif, ikuti petunjuk Firebase Console. Jangan mengaktifkan billing tanpa memahami tagihan.

## 4. Membuat akun editor
Buat user Email/Password melalui Firebase Console > Authentication > Users. Setelah itu set custom claim role `editor` menggunakan Admin SDK dari lingkungan tepercaya, BUKAN dari browser.

Contoh skrip admin satu kali (jalankan lokal dengan Application Default Credentials yang sudah diotorisasi; jangan commit kredensial):
```js
// set-editor.js — jalankan dari lingkungan admin yang tepercaya
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
initializeApp({ credential: applicationDefault(), projectId: "PROJECT_ID_ANDA" });
(async () => {
  await getAuth().setCustomUserClaims("UID_USER_BENDAHARA", { role: "editor" });
  console.log("Role editor disetel. Login ulang untuk refresh token.");
})();
```
Instal `firebase-admin` di lingkungan admin dan jalankan hanya oleh pemilik/admin project. Ganti UID dengan UID user dari Firebase Console. Jangan pernah memberikan kemampuan ini kepada user publik.

## 5. Inisialisasi data awal
Buat dokumen berikut lewat Firebase Console atau skrip Admin SDK tepercaya:
- `settings/class`: `{ "feeAmount": 10000 }`
- `periods/YYYY-MM`: `{ "feeAmount": 10000, "openingBalance": 0, "status": "open" }`
- `students/{studentId}`: `{ "name": "Nama Siswa", "active": true }`
- `publicStudents/{studentId}`: `{ "name": "Nama Siswa", "active": true, "feeAmount": 10000 }`
- `publicPeriods/YYYY-MM`: `{ "status": "open" }`
- Untuk periode awal, buat `payments/{YYYY-MM_studentId}` dan `publicPayments/{YYYY-MM_studentId}` dengan `status: "unpaid"`.

Nama koleksi public harus hanya berisi field yang aman dibaca semua orang. Untuk kelas sungguhan, tambahkan alat admin yang aman untuk memasukkan siswa secara batch.

## 6. Catatan tentang jadwal
Function `openNewMonth` dijadwalkan pada pukul 00:00 tanggal 1, zona waktu Asia/Jakarta. Scheduler pertama kali berjalan pada bulan berikutnya; buat periode awal secara manual. Periksa juga laporan penutupan, kuota batch, dan perilaku jika function gagal di tengah jalan sebelum dipakai sungguhan.

## 7. Pengujian wajib
- Buka link sebagai publik: read data `public*` berhasil.
- Coba menulis ke koleksi `public*`: harus ditolak.
- Coba membaca `students`, `payments`, `transactions` sebagai publik: harus ditolak.
- Login viewer biasa: callable harus menolak.
- Login editor: transaksi sah berhasil; nominal negatif, siswa tidak aktif, periode tutup, dan pembayaran ganda ditolak.
- Jalankan Firebase Emulator dan uji reset bulan di staging sebelum production.

## Data publik
Link publik berarti siapa pun yang memiliki URL dapat melihat nama dan status pembayaran yang dipublikasikan. Dapatkan persetujuan kelas dan minimalkan data yang dibuka. Security Rules tidak menyamarkan field dari dokumen publik: jangan taruh email, nomor telepon, bukti transfer, atau catatan privat di dokumen `public*`.

## Versi tampilan preview

- `public/index.html` adalah tampilan demo yang disamakan dengan preview KasKelas (Dashboard, Pembayaran, Transaksi, Laporan, ekspor CSV/PDF, QRIS dan tunai). Data di halaman ini hanya contoh dan perubahan tidak tersimpan permanen.
- `public/firebase-connected.html` adalah halaman lama yang terhubung ke kode Firebase melalui `public/app.js`. Untuk menggunakannya, konfigurasi Firebase dan deploy backend harus sudah disiapkan.
- `public/qris.jpg` adalah gambar penanda, bukan QRIS pembayaran. Ganti file itu dengan QRIS asli bendahara dan pertahankan nama `qris.jpg`.

## Email bendahara

Email bendahara belum ditentukan di project ini. Gunakan email milik bendahara yang benar-benar bisa diakses, lalu buat akun di Firebase Authentication (Email/Password) dan berikan role editor melalui langkah Admin SDK di panduan. Jangan gunakan email contoh atau memasukkan kata sandi ke source code.
