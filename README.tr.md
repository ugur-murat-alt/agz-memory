# AGZ Memory

[English](README.md) | Türkçe

OpenCode V2 için proje kapsamlı kalıcı hafıza. Depo, sürümleri birlikte ilerleyen
iki paket yayımlar:

- `@vaur94/agz-memory`: dokuz araçlı stdio MCP sunucusu, yeniden kullanılabilir
  çekirdek ve kurtarma odaklı yönetim komut satırı aracı.
- `@vaur94/agz-memory-plugin`: exact bir OpenCode V2 beta sürümü için isteğe
  bağlı güvenli yakalama ve sınırlı bağlam ekleme eklentisi.

SQLite schema v9, tek yetkili veri kaynağıdır. İsteğe bağlı anlamsal servisler
yeniden üretilebilir türetilmiş indekslerdir; izolasyon, silme, temizleme ve
kalite sözleşmeleri benchmark kapılarından geçmedikçe kapalı kalır.

## Uyumluluk

| Bileşen | Sürüm |
|---|---|
| Core/MCP | `0.4.0-beta.1` |
| Plugin | `0.4.0-beta.1` |
| OpenCode V2 | `0.0.0-beta-18743` |
| `@opencode-ai/plugin` | `0.0.0-beta-18743` |
| Bun | `>=1.3.14` |
| SQLite schema | `9` |

Eklenti, çalışan OpenCode sürümü desteklenen beta ile tam eşleşmediğinde
kendisini devre dışı bırakır. MCP sunucusu bağımsız olarak kullanılabilir.

## MCP Sunucusu

```sh
bunx @vaur94/agz-memory@0.4.0-beta.1
```

OpenCode V2 yapılandırması `mcp.servers` alanını kullanır:

```jsonc
{
  "mcp": {
    "servers": {
      "agz-memory": {
        "type": "local",
        "command": ["bunx", "@vaur94/agz-memory@0.4.0-beta.1"],
        "environment": {
          "OPENCODE_MEMORY_DATABASE_PATH": "{env:OPENCODE_MEMORY_DATABASE_PATH}"
        },
        "codemode": false
      }
    }
  }
}
```

Varsayılan veritabanı yolu `~/.local/share/opencode-memory/memory.sqlite` olur.
OpenCode başlamadan önce `OPENCODE_MEMORY_DATABASE_PATH` ile değiştirilebilir.

### Araçlar

Dış MCP sözleşmesi tam olarak dokuz araçtan oluşur:

| Araç | Amaç |
|---|---|
| `project_list` | Değişmez proje kimliklerini ve güncel adları listeler |
| `project_create` | Boş bir proje oluşturur |
| `project_update` | Kimliği değiştirmeden projeyi yeniden adlandırır |
| `project_delete` | Onaylanmış tek bir projeyi kalıcı olarak siler |
| `memory_recall` | Proje filtreli FTS5 ve tek adımlı grafik araması yapar |
| `memory_update` | Not oluşturur, günceller veya kalıcı olarak siler |
| `memory_pin` | Proje içindeki not önceliğini ayarlar |
| `memory_link` | Aynı proje içinde grafik bağlantısı ekler |
| `memory_read` | Tam not içeriklerini ve grafik bağlantılarını okur |

Her `memory_*` isteği tam olarak bir `projectID` veya `projectName` seçer.
Projeler arası okuma, güncelleme, silme, bağlantı ve arama reddedilir. Sıralı
toplu işlemler kasıtlı olarak atomik değildir; her öğenin sonucu incelenmelidir.

Proje silmek için üç değerin de sağlanması gerekir:

```json
{
  "projectID": "<immutable UUID>",
  "confirmProjectName": "<exact current case-sensitive name>",
  "confirmation": "DELETE_PROJECT_AND_ALL_MEMORY"
}
```

## İsteğe Bağlı OpenCode Eklentisi

Hareketli OpenCode beta bağımlılığının yalnız MCP kullanan çalışma ortamına
girmemesi için eklenti ayrı bir pakettir. Güvenli varsayılanı `off` değeridir.

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.4.0-beta.1",
      "options": {
        "mode": "off",
        "autoCreateProjects": false,
        "bindings": [],
        "capture": {
          "enabled": false,
          "allowedKinds": ["preference", "decision"],
          "minConfidence": 0.95
        },
        "retrieval": {
          "semanticBackend": "none",
          "timeoutMs": 300,
          "maxCards": 8,
          "maxCharacters": 4800
        }
      }
    }
  ]
}
```

Bağlamalar açık izin listesi girdileridir. Eklenti bir hafıza projesini hiçbir
zaman klasör adına göre seçmez ve otomatik proje oluşturmaz:

```jsonc
{
  "memoryProjectID": "<UUID from project_list>",
  "opencodeProjectID": "<ctx.location.project.id>",
  "canonicalDirectory": "/absolute/canonical/project/path",
  "workspaceID": "<optional workspace ID>"
}
```

Rollout modları birikimli olarak ilerler:

| Mod | Yakalama | Getirme | Ekleme | Otomatik yazma |
|---|---:|---:|---:|---:|
| `off` | Hayır | Hayır | Hayır | Hayır |
| `shadow-capture` | Yalnız maskelenmiş denetim | Hayır | Hayır | Hayır |
| `shadow-retrieval` | Evet | Yalnız ölçüm | Hayır | Hayır |
| `inject` | Evet | Evet | Sınırlı | Hayır |
| `auto-write` | Evet | Evet | Sınırlı | Yalnız açık ve yüksek güvenli karar/tercihler |

Bağlam ekleme fail-open çalışır; yani hafıza hatası ana isteği engellemez. Yalnız
özetleri kullanır, sekiz kart ve 4.800 karakterle sınırlıdır ve
`trust="untrusted"` olarak sarılır. Hafıza zaman aşımı veya bağlama hatası ana
OpenCode isteğini durdurmaz.

## Yakalama Güvenliği

Veritabanı ve önceki sürümlerin olay uyumluluğu için yetkili olay sözleşmesi
`opencode2-memory.capture/1` olarak korunur.

- Yerel session/message/ordinal/tool kimlikleri belirlenebilir SHA-256 tekilleştirme
  anahtarları üretir. SQLite benzersizliği son tekrar korumasıdır.
- Projeksiyon; reasoning, araç girdisi/çıktısı, ekler, dosyalar, sistem parçaları,
  diff, ortam verileri ve sağlayıcı durumunu atar.
- Metin, çıkarımdan önce ve veritabanına yazılmadan önce çekirdek içinde tekrar
  maskelenir.
- Özel anahtarlar, kimlik bilgisi URI'ları, birden çok yüksek riskli sır ve
  canary değerleri metin yükü olmadan karantinaya alınır.
- Olay JSON'u 16 KiB, otomatik içerik 4.800 karakter ile sınırlıdır.
- `[memory:off]`, ilgili kullanıcı mesajı için yakalamayı kapatır.
- Otomatik yazma başlangıçta yalnız güveni `>= 0.95` olan açık `preference` ve
  `decision` adaylarını kabul eder.

## Schema V9

Schema v9; proje, not, bağlantı, zaman damgası, durum ve pin kimliklerini korur.
Eklenen tablolar:

- `project_bindings`
- `capture_checkpoints`
- `capture_events`
- `note_provenance`
- `note_revisions`
- `index_outbox`

Kaydedilen her not durumunda kaynak bilgisi ve tam revision görüntüsü bulunur.
Not oluşturma, güncelleme, pin, supersession, FTS trigger ve türetilmiş indeks
outbox yazımları aynı transaction içinde yapılır. Normal arama yalnız `active`
notları döndürür.

FTS5 artık elle eşitleme yerine dış içerik ile insert/update/delete trigger'larını
kullanır.

## Yedekleme, Yükseltme Ve Geri Yükleme

Yönetim binary'si JSON çıktısını stdout'a, temizlenmiş hataları stderr'e yazar:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin upgrade --to 9
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin outbox status
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin capture status
```

Her schema yükseltmesi atomik bir migration lock alır ve DDL çalışmadan önce
SHA-256 manifest içeren doğrulanmış bir `VACUUM INTO` snapshot oluşturur.
Bütünlük, foreign key, tablo sayıları, revision kuralları ve FTS sayıları kontrol
edilir.

Manifest hash'i ve onay sağlanmadıkça geri yükleme yalnız kuru çalışır:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  /path/to/memory.sqlite.backup/<manifest>.manifest.json

bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  /path/to/memory.sqlite.backup/<manifest>.manifest.json \
  --sha256 <manifest-database-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP
```

Yükseltme veya geri yükleme öncesinde tüm MCP/plugin yazıcılarını durdurun. Güncel
veritabanı `failed-restore-source-*` olarak korunur; WAL/SHM yan dosyaları
karantinaya alınır. Ayrıntılar için
[`docs/backup-restore-runbook.md`](docs/backup-restore-runbook.md) belgesine bakın.

## Anlamsal Backend Kararı

Üretim `semanticBackend: "none"` olarak kalır. Tam vendor sözleşmesi incelemesi,
zorunlu sunucu tarafı proje filtresi, belirlenebilir silme, purge, sızıntı ve
gecikme kapılarının tümü için eksiksiz canlı A/B kanıtı üretmedi. Bu nedenle
üretim yolu SQLite metin+grafik aramasıdır. Ayrıntılar:
[`benchmark/baselines/vendor-decision.json`](benchmark/baselines/vendor-decision.json).

## Geliştirme

```sh
bun install
bun test
bun run check
bun run build
npm pack --dry-run --json
```

Test paketi; MCP snapshot'ları, eski sürüm ve v8-to-v9 migration fixture'ları,
yedekleme/geri yükleme, revision'lar, outbox FIFO, capture tekilleştirme, sır
karantinası, retrieval izolasyonu, sınırlı formatter ve exact-beta plugin hook
smoke testlerini içerir.
