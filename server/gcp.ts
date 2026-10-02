/**
 * The instance's own Google Cloud credentials, for the buckets the server
 * talks to over plain REST (hot-loaded brains, player feedback): no SDK.
 */

/** `gs://bucket/some/prefix/` → `{ bucket, prefix: 'some/prefix' }`; anything else → null. */
export function parseGsUrl(url: string): { bucket: string; prefix: string } | null {
  const gs = /^gs:\/\/([^/]+)\/?(.*)$/.exec(url);
  return gs ? { bucket: gs[1], prefix: gs[2].replace(/\/+$/, '') } : null;
}

/**
 * A source of access tokens for the instance's service account, from the
 * metadata server (Cloud Run, GCE), each kept until a minute before it
 * expires. Off GCP it yields null from then on; the caller decides what that
 * means (brains read a public bucket anonymously, feedback can't be kept).
 */
export function metadataTokens(): () => Promise<string | null> {
  let token: { value: string; until: number } | null = null;
  let none = false;
  return async () => {
    if (none) return null;
    if (!token || Date.now() > token.until) {
      try {
        const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(2000),
        });
        if (!r.ok) throw new Error(`metadata server: ${r.status}`);
        const j = (await r.json()) as { access_token: string; expires_in: number };
        token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
      } catch {
        none = true;
        return null;
      }
    }
    return token.value;
  };
}
