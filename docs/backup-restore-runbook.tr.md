# AGZ Memory Yedekleme Ve Geri Yükleme Runbook'u

[English](backup-restore-runbook.md) | Türkçe

Bu runbook `@vaur94/agz-memory@0.5.2` ve SQLite schema v11 için geçerlidir.

## Ön Koşullar

1. Üretim veritabanının tam yolunu dışa aktarın.
2. Eklentiyi `mode: "off"` ve `capture.enabled: false` durumuna getirin.
3. Veritabanına yazabilen tüm MCP, eklenti ve yönetim süreçlerini durdurun.
4. Veritabanı ve yedek dizinlerinin güncel kullanıcıya ait olduğunu ve sembolik
   bağ olmadığını doğrulayın.
5. Veritabanı, WAL kontrol noktası, bir doğrulanmış yedek ve bir korunmuş geri
   yükleme kaynağı için yeterli boş alan bırakın.

```sh
export OPENCODE_MEMORY_DATABASE_PATH="$HOME/.local/share/opencode-memory/memory.sqlite"
```

Tahmin edilmiş veya boş bir yolla devam etmeyin.

## Sağlık Kontrolü Ve Yükseltme

Önce salt-okunur sağlık raporu alın:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin doctor
```

`ok` değeri `true` olmalıdır. `schemaVersion`, satır sayıları ve değişmez kural
sayılarını kaydedin. Sonra bağımsız doğrulanmış yedek oluşturup yükseltin:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin upgrade --to 11
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin doctor
```

Veritabanı v11'den eskiyse yükseltme ayrıca değişiklikten önce doğrulanmış yedek
oluşturur. Yazdırılan her manifest yolunu ve SHA-256 değerini saklayın. Son rapor
`ok: false` ise yazıcı başlatmayın.

## Yedeği Doğrulama

Yedek çifti `<database>.backup/` altında bulunur:

```text
schema-vN-<timestamp>-<uuid>.sqlite
schema-vN-<timestamp>-<uuid>.manifest.json
```

Manifest formatı `agz-memory-backup/1` olur. `agz-memory-admin restore`, manifest
ile veritabanının aynı yedek dizinindeki normal dosyalar olduğunu doğrular;
ardından boyut, SHA-256, SQLite bütünlüğü, foreign key ve satır sayılarını denetler.

`0.5.2` ön sürüm manifest formatlarını kabul etmez. Böyle bir yedeği onu
oluşturan ön sürümle geri yükleyin, o sürümün doctor kontrolünü çalıştırın ve
yalnız bundan sonra geri yüklenen veritabanını `0.5.2` ile yükseltin.

## Geri Yükleme Provası

Tüm yazıcıları kapalı tutun. Önce onay vermeden deneme yapın:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json"
```

`targetPath`, `sourceSchema`, `targetSchema`, satır sayıları, boyut ve SHA-256
değerlerini kaydedilen yedekle karşılaştırın. Sonra tam manifest özetini kullanın:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json" \
  --sha256 <manifest-database-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP
```

Geri yükleme kopyalanmış ve doğrulanmış veritabanını atomik olarak kurar.
Değiştirilen kaynak `failed-restore-source-*` adıyla korunur; geri yüklenen
veritabanı tüm kontrollerden geçmeden bunu silmeyin.

## Geri Yükleme Sonrası Doğrulama

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin capture status
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin outbox status
```

Yalnız MCP sunucusunu başlatın ve salt-okunur `project_list`, `memory_recall` ve
`memory_read` denemeleri yapın. Proje/not sayılarını manifestle karşılaştırın.
OpenCode'u ancak bu kontroller geçince yeniden başlatın. Ayrı devreye alma kararı
verilene kadar eklentiyi `off` tutun.

## Korunan Bakım Kapısı

`<database>.maintenance/owner.json` içindeki `state: recovery-required`, önceki
bir geri yüklemenin geri alma sonucunu doğrulayamadığını gösterir. Bu kapı
otomatik kaldırılmaz. Tüm MCP/eklenti süreçlerini durdurun; veritabanını, yan
dosyaları, kapıyı ve geri yükleme kalıntılarını koruyun; ardından doğrulanmış bir
yedek seçin. Kayıtlı tam sahip kimliğini yalnız geri yükleme komutunda verin:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin restore <manifest> \
  --sha256 <manifest-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP \
  --maintenance-owner <owner-id> \
  --maintenance-confirm RECOVER_RETAINED_MAINTENANCE_GATE
```

Uzak, canlı, bozuk veya başka biçimde doğrulanamayan sahipler engelli kalır.
Kapıyı elle silmeyin; kurtarma geri yüklemesi kapı dizini kesintisiz yerindeyken
sahipliği atomik olarak devralır.

## Eski Geçiş Kilidi

Kilit `<database>.migration.lock/owner.json` konumundadır. Kayıtlı süreç yaşıyor
olabilirken veya bir yazıcı veritabanını tutarken kilidi kaldırmayın.

Sahip dosyasındaki PID, makine ve başlangıç zamanını doğrulayın. Yalnız eskidiği
kanıtlanan kilidi tam sahip ID'si ve onayla kırın:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin unlock \
  --owner <owner-id> \
  --confirm BREAK_STALE_MIGRATION_LOCK
```

Hemen ardından `doctor` çalıştırın. Eski kilit kesintiye uğramış işlemin
kanıtıdır; veritabanı doğrulamasını atlama izni değildir.

## Doğrulanmış Yedekleri Temizleme

İlk komut silme yapmaz ve tam yedek kümesinin özetini döndürür:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin backup prune
```

Listelenen her manifest/veritabanı çiftini inceleyin. Yalnız değişmemiş kümeyi
silin:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin backup prune \
  --digest <dry-run-digest> \
  --confirm DELETE_VERIFIED_BACKUPS
```

Manifest, veritabanı, özet, boyut veya küme üyeliği denemeden sonra değişirse
komut silmeyi reddeder. Saklama politikanıza göre ayrıca korunan, yakın tarihli
ve geri yüklemesi denenmiş en az bir yedek tutun.

## İptal Koşulları

Şunlardan biri olursa durun ve inceleyin:

- `doctor` sonucu `ok: false` olur.
- SQLite bütünlük veya foreign key kontrolü başarısız olur.
- Yedek satır sayıları kaynakla uyuşmaz.
- Geçiş kilidi sahibi hâlâ yaşıyor olabilir.
- Manifest yapılandırılan yedek kökü dışındadır veya sembolik bağdır.
- Geri yükleme SHA-256 değeri deneme çıktısından farklıdır.
- Son proje/not sayıları seçilen yedekle uyuşmaz.

Tek kopyayı yerinde onarmayın. İleri incelemeden önce veritabanını, WAL/SHM yan
dosyalarını, kilit dizinini, manifestleri ve komut çıktısını koruyun.
