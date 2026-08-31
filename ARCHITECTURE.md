# OpenCode2 Memory v8 - MCP Mimarisi

## Genel bakış

OpenCode2 Memory, OpenCode V2 tarafından başlatılan Bun tabanlı bir stdio MCP
server'dır. `@modelcontextprotocol/server` v2 kullanır, SQLite veritabanını
`bun:sqlite` ile açar ve schema v8 uygular. MCP yüzeyi dokuz araçtan oluşur:
`project_list`, `project_create`, `project_update`, `project_delete`,
`memory_recall`, `memory_update`, `memory_pin`, `memory_link` ve `memory_read`.

OpenCode ayarı `mcp.servers` altında `type: "local"` ve
`command: ["bunx", "@vaur94/opencode2-memory@0.3.0"]` kullanır. `codemode: false`,
araçların Code Mode yerine model sağlayıcısının doğrudan araç listesinde
kalmasını sağlar. Bu paket OpenCode plugin lifecycle'ına veya session hook'una
bağlı değildir.

## Çalışma zamanı ve instructions

Server MCP stdio taşıması üzerinden stdin/stdout ile konuşur. Veritabanı yolu
`OPENCODE_MEMORY_DATABASE_PATH` ile seçilir; değişken yoksa varsayılan yol
`~/.local/share/opencode-memory/memory.sqlite` olur.

Kullanım rehberi MCP server `instructions` alanında yayınlanır. Rehber:

- Önce `project_list` ile proje seçilmesini ve kalıcı referanslarda immutable
  `projectID` kullanılmasını söyler.
- İlk nottan önce `project_create` kullanılmasını ve rename işleminin ID'yi
  değiştirmediğini söyler.
- `memory_recall`, `memory_read`, `memory_update`, `memory_pin` ve
  `memory_link` çağrılarında tam olarak bir `projectID` veya `projectName`
  seçilmesini söyler.
- İlgili proje geçmişi için `memory_recall`, `indexed` not gövdesi ve graph
  komşuları için `memory_read` kullanılmasını söyler.
- Kalıcı doğrulanmış bilgi, karar, prosedür, araştırma, tercih veya tamamlanan
  önemli iş için `memory_update` kullanılmasını söyler.
- Önemli eşleşmeleri proje içinde öne almak için `memory_pin` kullanılmasını
  söyler.
- Transcript, tahmin, secret ve rutin ilerleme bilgisinin kaydedilmemesini
  söyler.
- `project_delete` işleminin geri döndürülemez olduğunu ve yalnızca açıkça
  istenen silme için doğrulama alanlarıyla çağrılmasını söyler.

Notlar otomatik olarak OpenCode context'ine enjekte edilmez. Aracı kullanan
ajan, geçmişe ihtiyaç duyduğunda açıkça `memory_recall` çağırır.

## Proje modeli ve kapsam

`projects` tablosunda `id` immutable UUID'dir; `name` ise rename edilebilir.
`normalized_name`, Unicode NFKC ve küçük harf normalizasyonu ile birlikte
temizlenmiş boşluklar üzerinden case-insensitive unique proje adı sağlar.
`project_update` yalnızca immutable `projectID` ile rename yapar.

Her not ve her graph kenarı tam olarak bir projeye aittir. `notes.project_id`
ve `note_edges.project_id` foreign key'leri `projects(id)` değerine bağlıdır.
Güncel store işlemleri arama, okuma, yazma, pin ve link işlemlerini proje
sınırında filtreler; cross-project veri görünürlüğü veya link yoktur.

## Not modeli

Ana tablolar `projects`, `notes`, `note_edges`, arama projeksiyonu
`notes_fts` ve `schema_state`'dir.

| Alan | Davranış |
|---|---|
| `kind` | `decision`, `fact`, `procedure`, `context`, `research`, `preference`, `task` |
| `size_class` | İçerik 1200 karaktere kadar `inline`, daha büyük içerik `indexed` |
| `pinned` | Her not için bağımsız boolean durum; `memory_pin` ile değiştirilir |
| `status` | Şema değerleri `active`, `superseded`, `archived` |
| `supersedes_id` | Eski sürüme referans alanı; otomatik supersede akışı yoktur |

`memory_update` yeni notları `active` olarak oluşturur, mevcut aktif notu yerinde
patch eder ve `delete: true` ile notu fiziksel olarak siler. Not silinirken
ona bağlı aynı proje kenarları ve FTS kaydı da silinir. `memory_pin` dışında
hiçbir araç pin durumunu değiştirmez.

## Graph ve arama

`note_edges(source_id, target_id, predicate)` yönlü kenarları tutar ve her
kenarın proje ID'si vardır. Geçerli predicate kümesi:

`SUPPORTS`, `DERIVED_FROM`, `PART_OF`, `ABOUT`, `PRECEDES`, `SUPERSEDES`.

`memory_link` tek kenar veya en fazla 10 kenar oluşturabilir. İki uç aynı
seçilen projedeki aktif notlar olmalıdır; cross-project link ve self-link
reddedilir.

`memory_recall` yalnız seçilen projede FTS5 BM25 araması yapar. Eşleşmeler
`pinned DESC, rank` sırasıyla döner; dolayısıyla pinned eşleşmeler önceliklidir.
İlk eşleşmelerin aktif, aynı proje içindeki bir-hop komşuları graph genişletmesi
olarak eklenir ve komşular da pinned durumuna göre sıralanır. `inline` kartlarda
içerik bulunur; `indexed` kartların tam gövdesi için `memory_read` gerekir.

Vektör araması, shared-path otomatik kenar önerisi ve `onnxruntime` bağımlılığı
yoktur. Arama FTS5 ve aynı-proje graph genişletmesiyle sınırlıdır.

## Tool yüzeyi

`memory_recall`, `memory_update`, `memory_pin`, `memory_link` ve `memory_read`
şemaları tam olarak bir project selector kabul eder: `projectID` veya
`projectName`. İkisi birden veya hiçbiri geçerli değildir. `projectName` mevcut
adı case-insensitive olarak çözer; rename sonrası eski ad geçersiz olur.

1. `project_list` - Tüm projeleri immutable ID, mevcut ad, not sayısı ve pinned
   not sayısıyla listeler. Proje seçmeden önce kullanılmalıdır.
2. `project_create(projectName)` - Boş proje oluşturur ve immutable UUID döner.
   İsim daha sonra `project_update` ile değiştirilebilir.
3. `project_update(projectID, projectName)` - Projeyi ID'si üzerinden rename
   eder; notların proje bağı değişmez.
4. `project_delete(projectID, confirmProjectName, confirmation)` - Projeyi,
   bütün notlarını, pinned durumlarını, graph kenarlarını ve FTS kayıtlarını
   kalıcı olarak siler. `confirmProjectName`, güncel case-sensitive proje adıyla
   tam eşleşmeli; `confirmation` tam olarak
   `DELETE_PROJECT_AND_ALL_MEMORY` olmalıdır.
5. `memory_recall(query)` veya `memory_recall(queries)` - Seçilen projede tek
   sorgu veya en fazla 10 sorgu için FTS5 BM25 ve graph genişletmesi yapar.
6. `memory_update(...)` - Seçilen projede not oluşturur, `id` ile alan bazlı
   patch yapar veya `delete: true` ile kalıcı siler. Tek çağrıda en fazla 10
   update kabul eder. Batch sıralı ve non-atomic çalışır; önceki başarılı
   işlemler sonraki hata durumunda geri alınmaz.
7. `memory_pin(id, pinned)` - Seçilen projedeki tek aktif notun pin durumunu
   değiştirir. Pin not bazındadır, içeriği taşımaz veya silmez.
8. `memory_link(sourceID, targetID, predicate)` veya `links` - Seçilen
   projedeki aktif notlar arasında tek veya en fazla 10 graph kenarı oluşturur.
   Link batch'i de sıralı ve non-atomic çalışır.
9. `memory_read(id)` veya `memory_read(ids)` - Seçilen projeden tek veya en
   fazla 10 notun tam içeriğini, pin durumunu, proje kimliğini ve aynı-proje
   graph kenarlarını döndürür.

`project_delete` destructive bir işlemdir. Önce `project_list` çağrılmalı,
immutable ID ve güncel ad doğrulanmalı, sonra üç zorunlu alan tam değerleriyle
gönderilmelidir. `memory_update` içindeki `delete: true` de kalıcıdır ve not ID'si
doğrulanmadan kullanılmamalıdır.

## Migration

### Schema v8 yükseltmesi

`schema_state` v8'i gösterir. Daha yeni bir schema version ile oluşturulmuş
veritabanı reddedilir. Eski bir güncel-schema veritabanı açıldığında migration
tek yönlü transaction içinde çalışır:

- Mevcut global veya v5 notlarının `project_id` değerleri mevcut `projects`
  satırlarında yoksa her legacy ID için yeni bir UUID proje oluşturulur.
  `global` için `Legacy Global`, `legacy` için `Legacy`, diğer ID'ler için
  `Legacy <ID prefix>` taban adı kullanılır; çakışmada suffix eklenir. Notlar
  ve kenarlar yeni UUID'ye taşınır.
- `notes` tablosunda pre-v8 `pinned` kolonu varsa değeri yeni tabloya kopyalanır.
  Böylece pre-v5 pinned kolonu mevcutsa pin durumu korunur. v5'te kaybedilmiş
  pin verisi yeniden oluşturulamaz ve not unpinned kalır.
- `note_edges` yeniden oluşturulurken yalnız source ve target aynı proje ise
  kenar alınır. Cross-project legacy kenarlar ve eksik uçlar düşürülür.
- `notes_fts` temizlenir ve mevcut notlardan yeniden doldurulur.
- Aktif `memory_associations` satırları aynı proje içindeki mevcut iki nota
  bağlanıyorsa graph kenarı olarak eklenir; bilinmeyen ilişki türleri `ABOUT`
  olur.

### Legacy v2 -> schema v8

Legacy v2 tabloları bulunduğunda migration otomatik ve tek yönlü çalışır.
Mevcut değilse `<db>.v2-backup` yedeği oluşturulur; var olan yedeğin üzerine
yazılmaz.

- Yalnızca aktif `memory_items` satırları, geçerli sürümündeki summary/content
  ile `notes` tablosuna taşınır.
- Tür eşlemesi şöyledir:
  - `decision` -> `decision`
  - `fact`, `observation`, `experiment`, `hypothesis`, `open_question`,
    `rule`, `direction`, `constraint` -> `fact`
  - `procedure`, `failure_remedy`, `agent_behavior` -> `procedure`
  - `context` -> `context`
  - `preference` -> `preference`
- `document_sources` ve `document_chunks` verileri, her belge için parçaları
  birleştiren tek bir `research` ve `indexed` nota dönüşür.
- Aktif `memory_edges` satırları, iki uç da taşınmış ve aynı projeye ait ise
  `note_edges` içine alınır; desteklenen predicate'ler korunur, bilinmeyenler
  `ABOUT` olarak eşlenir. Daha eski aktif `memory_links` satırları da `ABOUT`
  predicate'iyle taşınır.
- Cross-project legacy kenarlar, eksik uçlar ve self-link'ler alınmaz.
- Aktif same-project `memory_associations` graph'a eklenir; bilinmeyen türler
  `ABOUT` olarak eşlenir.
- v2 pin durumu bu migration tarafından yeniden oluşturulmaz.

Migration tamamlandıktan sonra schema version v8 olarak kaydedilir. Unutulmuş
veya düşürülmüş veri geri getirilemez.

## Paket ve bağımlılıklar

- Runtime: Bun ve `bun:sqlite`.
- MCP SDK: `@modelcontextprotocol/server` v2.
- Taşıma: stdio; HTTP veya OpenCode plugin transport'u yoktur.
- Kalıcı depolama: tek SQLite dosyası, project tabloları ve FTS5 sanal tablosu.
