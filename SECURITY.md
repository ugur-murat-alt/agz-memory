# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `0.5.x` | Yes |
| `0.4.x` | Yes |
| Prerelease and older versions | No |

## Report A Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory flow:

<https://github.com/ugur-murat-alt/agz-memory/security/advisories/new>

For abuse or conduct concerns that should not go to the maintainers, use GitHub's
independent abuse report: <https://support.github.com/contact/report-abuse>.

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
Bakım ekibine iletilmemesi gereken kötüye kullanım veya davranış sorunları için
GitHub'ın bağımsız bildirim yolunu kullanın: <https://support.github.com/contact/report-abuse>.
