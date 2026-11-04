# Create More DT

Aplikasi web sederhana untuk membuat dokumen **DT (Delivery/Surat Jalan)** dalam jumlah banyak:
upload Excel → data dibaca & divalidasi → klik **Cetak** → JSON dikirim ke **Asta Document Services**
→ file hasil langsung bisa dibuka/diunduh di halaman yang sama.

Kasus utamanya: barang ABC dikirim ke banyak lokasi, dan Zoho Books tidak bisa memecah info itu.
Di app ini, **1 lokasi kirim = 1 DT**, masing-masing dengan daftar barangnya sendiri (loop `line_items`).

- Node.js 22, **tanpa dependency npm** (hanya modul bawaan Node).
- Excel dibaca di browser (SheetJS dari CDN), jadi server cukup menerima JSON.
- Hasil & riwayat disimpan di volume Docker `dt_storage`.

---

## 1. Format Excel

Unduh contoh lewat tombol **Unduh template Excel** di halaman. File punya 2 sheet:

**Sheet `Header`** — 1 baris = 1 DT

| no_dt | tanggal | customer_name | pic | ref_so | lokasi_tujuan | alamat | penerima | telp_penerima | keterangan |
|---|---|---|---|---|---|---|---|---|---|
| DT/2026/11/001 | 04-11-2026 | PT. Nov Oilfield Service | Chofifah | SO-00123 | Site Balikpapan | … | Budi | … | |
| DT/2026/11/002 | 04-11-2026 | PT. Nov Oilfield Service | Chofifah | SO-00123 | Site Duri | … | Andi | … | |

**Sheet `Items`** — 1 baris = 1 barang dalam sebuah DT

| no_dt | description | aku | qty | satuan | keterangan | image |
|---|---|---|---|---|---|---|
| DT/2026/11/001 | GS ASTRA PREMIUM N150 150 Amper 12 Volt | 01-001-0000037 | 4 | Pcs | | |
| DT/2026/11/001 | Cable Lug M35x12 | 15-033-0001983 | 20 | Pcs | | |
| DT/2026/11/002 | GS ASTRA PREMIUM N150 150 Amper 12 Volt | 01-001-0000037 | 2 | Pcs | | |

Aturan:
- **Nama kolom = nama field di template Asta.** Kolom baru boleh ditambah, otomatis ikut terkirim tanpa ubah kode.
  (Judul kolom dinormalkan: huruf kecil, spasi → `_`. Contoh "Lokasi Tujuan" → `lokasi_tujuan`.)
- Wajib: `no_dt` di Header (tidak boleh dobel), `no_dt` + `description` di Items. `qty` (bila ada) harus > 0.
- `item_order` terisi otomatis 1, 2, 3… kalau tidak ada kolomnya.
- Tanggal dikirim sebagai `DD-MM-YYYY`, semua nilai dikirim sebagai teks.

Payload yang dikirim ke Asta untuk DT/2026/11/001 (bisa dilihat lewat tombol **JSON** di tiap baris):

```json
{
  "template_id": "TPL-007",
  "data": {
    "no_dt": "DT/2026/11/001",
    "tanggal": "04-11-2026",
    "customer_name": "PT. Nov Oilfield Service",
    "lokasi_tujuan": "Site Balikpapan",
    "line_items": [
      { "description": "GS ASTRA PREMIUM N150 150 Amper 12 Volt", "aku": "01-001-0000037", "qty": "4", "satuan": "Pcs", "item_order": "1" },
      { "description": "Cable Lug M35x12", "aku": "15-033-0001983", "qty": "20", "satuan": "Pcs", "item_order": "2" }
    ]
  }
}
```

Di template Asta (gaya Carbone) loop-nya tinggal memakai `line_items`, sama seperti TPL-006.

---

## 2. Bagaimana hasil dari Asta dibaca

App menyesuaikan diri dengan bentuk response Asta:

| Response Asta | Yang dilakukan app |
|---|---|
| File langsung (`application/pdf`, docx, octet-stream) | Disimpan, tombol **Buka/Unduh** muncul |
| JSON berisi URL (`url`, `file_url`, `download_url`, …) | File diunduh & disimpan (atau hanya link bila `ASTA_DOWNLOAD_RESULT=false`) |
| JSON berisi base64 (`file`, `base64`, `content`, …) | Di-decode & disimpan |
| JSON berisi job id (async) | Status "Menunggu Asta…", hasil datang lewat **callback** |
| HTTP error / `success:false` | Status "Gagal" + pesan dari Asta |

**Callback (opsional, hanya untuk Asta mode async).** Isi di `.env`:
```
PUBLIC_BASE_URL=https://dt.domainanda.com
ASTA_CALLBACK_FIELD=callback_url
CALLBACK_SECRET=string-acak-panjang
```
App akan menambahkan `"callback_url": "https://dt.domainanda.com/api/callback/<jobId>?token=..."` di payload.
Asta cukup `POST` ke URL itu dengan body file (PDF) **atau** JSON berisi URL/base64 — format yang sama seperti tabel di atas.
Halaman web otomatis ter-update begitu callback masuk.

---

## 3. Deploy di VPS (Docker)

### 3.1 Prasyarat (sekali saja)

```bash
# Docker + plugin compose (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # logout-login setelah ini
docker compose version
```

**Akses GitHub dari VPS.** Kalau repo ini *private*, VPS perlu kunci sendiri. Cara paling aman: **Deploy Key** (read-only, khusus repo ini).

```bash
ssh-keygen -t ed25519 -C "vps-create-more-dt" -f ~/.ssh/create_more_dt -N ""
cat ~/.ssh/create_more_dt.pub
```
Tempel isi `.pub` di GitHub → repo **Apps-Create-More-DT** → *Settings → Deploy keys → Add deploy key* (biarkan "Allow write access" tidak dicentang). Lalu:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-create-more-dt
  HostName github.com
  User git
  IdentityFile ~/.ssh/create_more_dt
  IdentitiesOnly yes
EOF
ssh -T github-create-more-dt   # harus muncul "successfully authenticated"
```

### 3.2 Siapkan folder, remote, dan pull pertama

**Cara A — clone (paling simpel, folder & remote langsung jadi):**
```bash
sudo mkdir -p /opt/apps && sudo chown $USER:$USER /opt/apps
cd /opt/apps
git clone github-create-more-dt:webasta/Apps-Create-More-DT.git create-more-dt
# repo public? cukup: git clone https://github.com/webasta/Apps-Create-More-DT.git create-more-dt
cd create-more-dt
```

**Cara B — folder sudah ada, set remote manual:**
```bash
mkdir -p /opt/apps/create-more-dt && cd /opt/apps/create-more-dt
git init -b main
git remote add origin github-create-more-dt:webasta/Apps-Create-More-DT.git
git fetch origin
git checkout -t origin/main
git remote -v    # cek remote sudah benar
```

### 3.3 Konfigurasi & jalankan

```bash
cp .env.example .env
nano .env                         # isi APP_PASSWORD, ASTA_TEMPLATE_ID, ASTA_API_KEY (bila perlu), dll.
docker compose up -d --build
docker compose ps                 # STATUS harus "healthy"
docker compose logs -f            # lihat log, Ctrl+C untuk keluar
curl http://127.0.0.1:3000/healthz
```

Secara default port hanya terbuka untuk `127.0.0.1` (aman, diakses lewat Nginx).
Mau tes cepat langsung via `http://IP-VPS:3000`? Ubah baris ports di `docker-compose.yml` menjadi `"3000:3000"`
lalu `docker compose up -d` — tapi untuk pemakaian rutin sebaiknya lewat HTTPS.

### 3.4 Nginx + HTTPS (disarankan, wajib bila pakai callback)

```nginx
server {
    server_name dt.domainanda.com;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/create-more-dt /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dt.domainanda.com
```

### 3.5 Update ke versi terbaru

```bash
cd /opt/apps/create-more-dt
./deploy.sh        # = git pull + docker compose up -d --build + bersihkan image lama
```
(Pertama kali: `chmod +x deploy.sh`.) Data riwayat & file hasil tetap aman di volume `dt_storage`.

---

## 4. Konfigurasi `.env`

| Variabel | Default | Keterangan |
|---|---|---|
| `HOST_PORT` | 3000 | Port di VPS |
| `APP_USERNAME` / `APP_PASSWORD` | – | Login halaman (Basic Auth). **Isi kalau app bisa diakses dari internet.** |
| `ASTA_API_URL` | `https://temp.astakorpora.com/api/v1/generate` | Endpoint generate |
| `ASTA_TEMPLATE_ID` | – | Template default (bisa diganti di halaman) |
| `ASTA_AUTH_HEADER` / `ASTA_API_KEY` | `Authorization` / – | Header auth ke Asta, mis. `Bearer xxx` |
| `ASTA_TIMEOUT_MS` | 60000 | Batas waktu per DT |
| `ASTA_CONCURRENCY` | 2 | Jumlah DT yang dikirim bersamaan |
| `ASTA_DOWNLOAD_RESULT` | true | Unduh & simpan file bila Asta membalas URL |
| `PUBLIC_BASE_URL`, `ASTA_CALLBACK_FIELD`, `CALLBACK_SECRET` | – | Untuk mode callback (lihat bagian 2) |
| `JOB_RETENTION_DAYS` | 30 | Riwayat & file hasil lebih lama dari ini dihapus otomatis |

---

## 5. Jalan lokal (tanpa Docker)

```bash
cp .env.example .env   # isi seperlunya
npm start              # http://localhost:3000
npm test               # tes unit builder JSON
```

## 6. API (untuk integrasi lain, mis. Zoho Books)

Sumber data lain cukup memanggil endpoint yang sama dengan halaman web:

```
POST /api/generate
{ "template_id": "TPL-007",
  "dts": [ { "no_dt": "DT/001", "header": { "no_dt": "DT/001", "lokasi_tujuan": "..." },
             "items": [ { "description": "...", "qty": "4" } ] } ] }
→ 202 { "ok": true, "jobs": [ { "id": "...", "no_dt": "DT/001", "status": "queued" } ] }

GET  /api/jobs?ids=<id1>,<id2>   → status & file_url tiap job
GET  /files/<nama-file>          → file hasil (?download=1 untuk unduh)
POST /api/callback/<jobId>?token= → dipanggil Asta (mode async)
GET  /healthz
```
Endpoint selain callback & healthz memakai Basic Auth yang sama.

## Struktur

```
src/server.js            HTTP server & routing
src/asta.js              kirim ke Asta, baca response / callback
src/store.js             penyimpanan job & file (storage/)
src/config.js            baca .env
src/shared/dt-builder.js Excel rows → DT → payload (dipakai browser & server)
public/                  halaman web
```
