# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `0.4.x` | Yes |
| Prerelease and older versions | No |

## Report A Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory flow:

<https://github.com/ugur-murat-alt/agz-memory/security/advisories/new>

Include the affected package/version, impact, prerequisites, minimal
reproduction, and any proposed mitigation. Remove credentials, private database
content, session transcripts, and personal paths. You should receive an initial
response within seven days.

## Scope

Security-sensitive areas include project isolation, cross-project retrieval,
destructive confirmation, SQLite migration/restore, symlink and path handling,
capture redaction, prompt-injection boundaries, plugin binding, retention,
derived-index deletion/purge, and package provenance.

## Güvenlik Bildirimi

Şüpheli güvenlik açıkları için herkese açık issue açmayın. Yukarıdaki GitHub
özel güvenlik bildirimi bağlantısını kullanın. Paket ve sürümü, etkiyi, ön
koşulları ve en küçük yeniden üretim adımlarını ekleyin; kimlik bilgilerini,
özel veritabanı içeriğini, oturum dökümlerini ve kişisel yolları çıkarın.
