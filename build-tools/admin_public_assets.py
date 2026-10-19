"""Verify unchanged origin bytes while allowing only the reviewed Cloudflare insertion."""
import hashlib
import re

# Audited 2026-10-08: one Web Analytics module plus one exact JS Detections template.
# Only the public ray ID and timestamp literals vary. Unknown additions are rejected.
CF_TEMPLATE_SHA256 = '459db7935726af1fd752f78936f6dccba819c240c7660a1848ecedd2fc107bef'
CF_PARAMETERS = re.compile(rb"r:'[0-9a-f]{16}',t:'[A-Za-z0-9+/=]{8,128}'")

def verify_public_asset(name, source, live, status, headers):
    if status != 200:
        raise ValueError('PublicAssetHttpStatus')
    if 'no-store' not in headers.get('Cache-Control', '').lower():
        raise ValueError('PublicAssetCachePolicy')
    result = {'status': status, 'source_unchanged': True, 'no_store': True, 'exact_public_bytes': source == live}
    if source == live:
        return result
    if name != 'index.html' or source.count(b'</body>') != 1 or 'text/html' not in headers.get('Content-Type', '').lower():
        raise ValueError('PublicAssetDigestMismatch')
    prefix, suffix = source.split(b'</body>', 1)
    ending = b'</body>' + suffix
    if not live.startswith(prefix) or not live.endswith(ending):
        raise ValueError('PublicHtmlOriginChanged')
    insertion = live[len(prefix):-len(ending)]
    if not (0 < len(insertion) <= 4096) or insertion.count(b'<script') != 2 or insertion.count(b'</script>') != 2:
        raise ValueError('UnexpectedPublicHtmlInsertion')
    canonical, count = CF_PARAMETERS.subn(b'__VERIFIED_CF_META__', insertion)
    if count != 1 or hashlib.sha256(canonical).hexdigest() != CF_TEMPLATE_SHA256:
        raise ValueError('UnreviewedCloudflareTemplate')
    result.update({'cloudflare_insertion_verified': True, 'insertion_bytes': len(insertion),
                   'template_sha256': CF_TEMPLATE_SHA256, 'recognized_insertions': ['cloudflare_web_analytics', 'cloudflare_js_detections']})
    return result
