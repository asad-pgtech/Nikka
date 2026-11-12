/** Thin fetch wrapper for the REST API (docs/PROTOCOL.md). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TokenProvider = () => Promise<string>;

let tokenProvider: TokenProvider | null = null;

/** Installed while unlocked; cleared on lock. */
export function setTokenProvider(p: TokenProvider | null): void {
  tokenProvider = p;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  raw?: BodyInit;
  auth?: boolean;
  signal?: AbortSignal;
  expect?: 'json' | 'bytes' | 'none';
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, raw, auth = true, signal, expect = 'json' } = opts;
  const headers: Record<string, string> = {};
  if (auth) {
    if (!tokenProvider) throw new ApiError(401, 'locked', 'Not signed in');
    headers.Authorization = `Bearer ${await tokenProvider()}`;
  }
  let payload: BodyInit | undefined = raw;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
  }

  const res = await fetch(`/api${path}`, { method, headers, body: payload, signal, cache: 'no-store' });
  if (!res.ok) {
    let code = 'http_error';
    let message = res.statusText;
    try {
      const data = await res.json();
      const d = data?.detail;
      if (d && typeof d === 'object' && 'code' in d) {
        code = String(d.code);
        message = String(d.message ?? code);
      } else if (typeof d === 'string') {
        message = d;
      }
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, code, message);
  }
  if (expect === 'none' || res.status === 204) return undefined as T;
  if (expect === 'bytes') return new Uint8Array(await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}
