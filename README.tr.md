# AGZ Memory

[English](README.md) | Türkçe

AGZ Memory, OpenCode V2'ye proje kapsamlı ve bağlantılı kalıcı hafıza kazandırır.
Aynı sürümde ilerleyen, birbirinden bağımsız kullanılabilen iki paket sunar:

- `@vaur94/agz-memory`: SQLite tabanlı dokuz araçlı MCP sunucusu, TypeScript
  çekirdeği ve kurtarma komut satırı aracı.
- `@vaur94/agz-memory-plugin`: sınırlı geri çağırma ve bilinçli olarak aşamalı
  otomatik yakalama için isteğe bağlı OpenCode V2 bağdaştırıcısı.

**0.5.2 durumu:** Bu depo 0.5.2 sürüm yüzeyini ve uyumluluk sözleşmesini
belgeler; npm yayımlama ve Git barındırma durumu ayrı olarak izlenir.

MCP sunucusu normal kullanım için hazırdır. Eklenti hareketsiz başlar: açık bir
eşleme ve devreye alma modu verilene kadar proje oluşturmaz, oturum yakalamaz ve
bağlam eklemez.

## Neden AGZ Memory

- Her okuma ve değişiklik, değişmez proje UUID'si veya benzersiz proje adıyla
  sınırlandırılır.
- Notlar projeler karışmadan sabitlenebilir, bağlanabilir, hükümsüz bırakılabilir,
  sürümlenebilir, aranabilir ve incelenebilir.
- SQLite schema v11 tek yetkili veri kaynağıdır; isteğe bağlı anlamsal indeksler
  yeniden üretilebilir türevlerdir.
- Yıkıcı proje silme işlemi değişmez ID, güncel ad ve sabit onay ifadesi ister.
- Yedek manifestleri geri yüklemeden önce satır sayılarını, SQLite bütünlüğünü,
  boyutu ve SHA-256 değerini doğrular.
- Otomatik yakalama maskelenmiş, sınırlı, yinelenmeye dayanıklı ve varsayılan
  olarak kapalıdır.

## Uyumluluk

| Bileşen | Desteklenen sürüm |
|---|---|
| Çekirdek ve MCP | `0.5.2` |
| OpenCode eklentisi | `0.5.2` |
| OpenCode V2 | `0.0.0-beta-18743` |
| `@opencode-ai/plugin` | `0.0.0-beta-18743` |
| Bun | `>=1.3.14` |
| SQLite schema | `11` |

MCP sunucusu bir OpenCode beta sürümüne bağlı değildir. İsteğe bağlı eklenti,
çalışan OpenCode sürümü desteklenen beta ile tam eşleşmezse kendini kapatır.

## MCP Sunucusunu Kurma

Sunucuyu doğrudan çalıştırın:

```sh
bunx @vaur94/agz-memory@0.5.2
```

Ya da OpenCode V2 içinde `mcp.servers` altına kaydedin:

```jsonc
{
  "skills": [
    "https://raw.githubusercontent.com/ugur-murat-alt/agz-memory/v0.5.2/skills/"
  ],
  "mcp": {
    "servers": {
      "agz-memory": {
        "type": "local",
        "command": ["bunx", "@vaur94/agz-memory@0.5.2"],
        "environment": {
          "OPENCODE_MEMORY_DATABASE_PATH": "{env:OPENCODE_MEMORY_DATABASE_PATH}"
        },
        "codemode": false
      }
    }
  }
}
```

npm paketi, sürümlenmiş `agz-memory` skill kataloğunu taşır. Skill, ajanın
gerektiğinde yüklediği iş akışı talimatıdır; yalnız npm kurulumu onu
keşfedilebilir yapmaz. Yukarıdaki açık `skills` girdisi OpenCode'un aynı iş
akışını indirip ajana tanıtmasını sağlar. MCP bu girdi olmadan da tam
kullanılabilir; sunucu her bağlantıda kısa `initialize` talimatlarını ve eksiksiz
araç şemalarını sunar.

Kurulum `~/.config/opencode/AGENTS.md` dosyasını değiştirmemelidir. Bu dosya
eklenti kurulum yüzeyi değil, kullanıcının tüm projeler için sahip olduğu genel
ajan politikasıdır. Ekipler kendi hafıza politikalarını orada tutabilir, ancak
AGZ Memory buna ihtiyaç duymaz. `codemode: false`, küçük ve sabit katalog için
bilinçli seçimdir; dokuz aracın tümünü doğrudan gösterir. Code Mode açılırsa da
sunucu talimatları, araç açıklamaları ve isteğe bağlı skill aynı iş akışını
tanımlar.

Varsayılan veritabanı
`~/.local/share/opencode-memory/memory.sqlite` konumundadır. Başka bir yol için
OpenCode başlamadan önce `OPENCODE_MEMORY_DATABASE_PATH` ayarlayın. Veritabanı
dosyası yalnız kullanıcı erişimine açık izinlerle oluşturulur.

## Dokuz Aracı Kullanma

OpenCode araçları yapılandırılan sunucu önekiyle gösterir; örneğin
`agz-memory_project_list`. MCP protokolündeki adlar şunlardır:

| Araç | Amaç |
|---|---|
| `project_list` | Proje kimliklerini ve not sayılarını listeler. |
| `project_create` | Benzersiz adla boş proje oluşturur. |
| `project_update` | UUID'yi değiştirmeden projeyi yeniden adlandırır. |
| `project_delete` | Onaylanan tek projeyi ve sahip olduğu tüm veriyi kalıcı siler. |
| `memory_recall` | Bir projeyi bir veya en fazla on sorguyla arar. |
| `memory_update` | Bir projede not oluşturur, değiştirir veya açıkça siler. |
| `memory_pin` | Etkin bir notun önceliğini açar veya kapatır. |
| `memory_link` | Aynı projedeki notlar arasında türü belirli bağ kurar. |
| `memory_read` | Tam notları, sabitleme durumunu, proje kimliğini ve komşuları okur. |

Önerilen sıra:

1. `project_list` çağırın ve aynı kalıcı çalışma alanını temsil eden mevcut
   projeyi yeniden kullanın. Git bağlantılı çalışma ağaçları bu çalışma alanının
   ayrı kod kopyalarıdır ve aynı `projectID` değerini kullanmalıdır.
2. Yalnız eşleşen proje yoksa `project_create` çağırın.
3. Dönen `projectID` değerini saklayın; ad değişebilir, UUID değişmez.
4. Geçmiş kararlara dayanmadan önce `memory_recall` çağırın.
5. Yalnız kalıcı ve doğrulanmış olguları, kararları, prosedürleri, tercihleri,
   araştırmaları, bağlamı veya görevleri saklayın. Konuşma dökümü, sır ya da
   tahmin saklamayın.

Çok öğeli değişiklikler sıralıdır ve topluca geri alınmaz. Her sonucu inceleyin:
sonraki öğe başarısız olsa da önceki öğeler uygulanmış kalır.

## İsteğe Bağlı Eklentiyi Ekleme

MCP sunucusunu yapılandırılmış tutun ve tam sürümlü eklenti paketini hareketsiz
ayarlarla ekleyin:

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.5.2",
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

Eklenti MCP sunucusuyla aynı veritabanı yolunu açar. Bilinmeyen ayar alanlarını,
otomatik proje oluşturmayı, desteklenmeyen anlamsal servisleri, sınır dışı
değerleri ve çakışan eşlemeleri reddeder.

## Projeleri Açıkça Eşleme

Eklenti, tam bir eşleşen eşleme olmadan hiçbir şey yapmaz. Her eşleme bir
OpenCode proje/çalışma alanı/konumunu mevcut AGZ Memory projesine bağlar:

```jsonc
{
  "memoryProjectID": "11111111-1111-4111-8111-111111111111",
  "opencodeProjectID": "your-opencode-project-id",
  "canonicalDirectory": "/absolute/canonical/project/path",
  "workspaceID": ""
}
```

`memoryProjectID`, `project_list` sonucundan gelmelidir. Dizin gerçek dosya
sistemi yoluna çözülür ve etkin OpenCode konumuyla karşılaştırılır. Ana kod
kopyası ile bağlantılı Git çalışma ağacı, yalnız Git metadata'sı ortak dizini
doğruladığında aynı depo kabul edilir. Her farklı OpenCode proje/çalışma alanı
kimliğini açıkça eşleyin, fakat aynı `memoryProjectID` değerini yeniden kullanın;
yapılandırılmış kanonik yol ve veritabanındaki özeti değişmez. İlişkisiz veya
doğrulanamayan konum ya da çift eşleme, sezgisel proje seçmek yerine eklentiyi
kapatır.

## Güvenli Devreye Alma

Modlar bilinçli olarak tek yönlü aşamalardır:

| Mod | Yakalama | Geri çağırma | Bağlam ekleme | Not yazma |
|---|---|---|---|---|
| `off` | Hayır | Hayır | Hayır | Hayır |
| `shadow-capture` | Yalnız maskelenmiş denetim | Hayır | Hayır | Hayır |
| `shadow-retrieval` | İsteğe bağlı maskelenmiş denetim | Yalnız ölçüm | Hayır | Hayır |
| `inject` | İsteğe bağlı maskelenmiş denetim | Sözcüksel ve grafik | Sınırlı, güvenilmeyen | Hayır |
| `auto-write` | İlke denetimli | Sözcüksel ve grafik | Sınırlı, güvenilmeyen | Yalnız yüksek güvenli adaylar |

Her seferinde tek aşama ilerleyin. Devam etmeden önce
`agz-memory-admin capture status`, veritabanı büyümesi, geri çağırma gecikmesi ve
yanlış eşleşmeleri inceleyin. Bir turun geri çağırma, bağlam ekleme ve tüm
yakalama kanallarını kapatmak için o isteme `[memory:off]` ekleyin. Uzlaştırma,
yeniden başlatma sonrasında bu sınırı oturum geçmişinden tekrar kurar. `off`
moduna dönmek her zaman güvenlidir ve kayıtlı veriyi silmez.

Anlamsal geri çağırma kod tarafından kapalı tutulur. Bir sağlayıcı proje
izolasyonu, silme, proje temizleme, yeniden kurma, sızıntı, kalite ve gecikme
kapılarından geçene kadar `semanticBackend` değeri `none` olmalıdır.

## İşletme Ve Kurtarma

Yönetim aracı aynı `OPENCODE_MEMORY_DATABASE_PATH` değerini okur:

```sh
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin upgrade --to 11
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin capture status
bunx --package @vaur94/agz-memory@0.5.2 agz-memory-admin outbox status
```

Yükseltmeler özel bir geçiş kilidi alır ve veritabanını değiştirmeden önce
doğrulanmış yedek oluşturur. Başarısız geçiş otomatik doğrulanmış geri yükleme
dener. Geri yükleme ve yedek silme işlemleri önce deneme çıktısı, sonra açık
onay değerleri ister; bu değerleri tahmin etmeyin.

Tam prova için [yedekleme ve geri yükleme runbook'unu](docs/backup-restore-runbook.tr.md)
kullanın. `0.5.2` yedek manifestleri `agz-memory-backup/1` kullanır;
ön sürüm manifestleri onları oluşturan ön sürümle işlenmelidir.

## Güvenlik Modeli

- Geri çağrılan notlar `<agz-memory-context trust="untrusted">` içine alınır ve
  eklenmeden önce kaçışlanır. Saklanan metin sistem kuralına dönüşmez.
- Yakalama yalnız son kullanıcı/asistan metnini ve son araç durumunu alır;
  muhakeme, araç girdisi ve araç çıktı yükleri dışarıda bırakılır.
- Kimlik bilgisi desenleri kalıcılaştırmadan önce ve not oluşturmadan önce tekrar
  maskelenir. Özel anahtar malzemesi yük saklanmadan karantinaya alınır.
- Yakalama olayları sabit kaynak kimliğiyle yinelenmeye dayanıklıdır ve yükleri
  sınırlı süre tutulur.
- Her not ve ilişki sorgusunda proje sahipliği uygulanır. Projeler arası bağlar
  ve dış indeks sonuçları reddedilir.
- SQLite tek yetkili kaynaktır. Türetilmiş indeks kuyruğu not yükü yerine kimlik
  ve özet değerleri taşır.

Güvenlik açıklarını [SECURITY.md](SECURITY.md) içindeki özel kanaldan bildirin.

## Geliştirme Ve Doğrulama

```sh
bun install --frozen-lockfile
bun run release:verify
bun run check
bun test
bun run test:property
bun run test:stress
bun run test:restore
bun run benchmark:gate
bun run build
npm pack --dry-run --json
```

`release:verify`; paket sürümü sapmasını, iki dildeki bölüm uyuşmazlığını, eski
sürüm pinlerini, eksik AGZ-001 ile AGZ-068 çözüm tablosunu ve kullanımdan
kaldırılan proje adının tracked dosyalara yeniden girmesini reddeder. Testler proje izolasyonu, yıkıcı onay, schema geçişi,
yedekleme/geri yükleme, yakalama güvenliği, revision, provenance, FTS, geri
çağırma, outbox ve tam dokuz araçlı MCP yüzeyini kapsar.

## Proje Kaynakları

- [Mimari](ARCHITECTURE.md)
- [Değişiklik günlüğü](CHANGELOG.md)
- [Yedekleme ve geri yükleme runbook'u](docs/backup-restore-runbook.tr.md)
- [Schema 11 sözleşmesi](docs/schema-v11.md)
- [İnceleme çözümleri](docs/review-resolution.md)
- [Katkı rehberi](CONTRIBUTING.md)
- [Güvenlik politikası](SECURITY.md)
- [GitHub deposu](https://github.com/ugur-murat-alt/agz-memory)
- [npm çekirdek paketi](https://www.npmjs.com/package/@vaur94/agz-memory)
- [npm eklenti paketi](https://www.npmjs.com/package/@vaur94/agz-memory-plugin)

## Lisans

[MIT](LICENSE)
