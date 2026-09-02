# @vaur94/agz-memory-plugin

[English](README.md) | Türkçe

`@vaur94/agz-memory@0.5.0` için isteğe bağlı OpenCode V2 bağdaştırıcısıdır.
OpenCode `0.0.0-beta-18743` sürümüne açık proje eşleme, maskelenmiş yakalama,
sınırlı geri çağırma ve aşamalı bağlam ekleme kazandırır.

Paket yalnız kurulduğunda güvenlidir. Varsayılanlar `mode: "off"`, boş eşleme,
kapalı yakalama, yasak otomatik proje oluşturma, `none` anlamsal servis, en fazla
sekiz kart, en fazla 4.800 karakter ve 300 ms geri çağırma süresidir.

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.5.0",
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

MCP sunucusu ve veritabanı sağlıklı olana kadar `off` durumunu koruyun. Tek açık
eşleme ekleyin; her aşamayı inceleyerek `shadow-capture`, `shadow-retrieval`,
`inject` ve son olarak `auto-write` moduna ilerleyin. Sürüm uyuşmazlığı, eksik
veya çakışan eşleme, veritabanı hatası ya da desteklenmeyen anlamsal servis,
tahmin yürütmek yerine eklentiyi kapatır.

Bu eklentiyi kurmak, `agz-memory` skill kataloğunu taşıyan tam sürümlü çekirdek
bağımlılığını da kurar. OpenCode npm bağımlılıklarının içindeki skill'leri
otomatik keşfetmez; depo README'sindeki açık ve sürümlenmiş `skills` kaynağını
kullanın. Eklenti kullanıcının genel `AGENTS.md` dosyasını hiçbir zaman
değiştirmez.

Eşleme alanları, mod davranışı, kurtarma komutları ve güvenlik modeli için depo
[README'sine](https://github.com/ugur-murat-alt/agz-memory/blob/main/README.tr.md)
bakın.

## Lisans

[MIT](https://github.com/ugur-murat-alt/agz-memory/blob/main/LICENSE)
