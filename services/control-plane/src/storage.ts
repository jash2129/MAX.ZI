import { createHash, createHmac } from "node:crypto";

/**
 * Object storage for call recordings: any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2,
 * MinIO), path-style addressing, AWS Signature Version 4. No SDK: three operations are all we need.
 *
 * Environment (the same names in the voice worker, the portal and the maintenance job):
 *   S3_ENDPOINT          e.g. https://<account>.r2.cloudflarestorage.com, https://s3.us-east-2.amazonaws.com
 *   S3_BUCKET
 *   S3_REGION            default "auto" (R2); the bucket's region on AWS
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 */
export interface ObjectStore {
  /** null when the object does not exist */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Succeeds when the object is already gone */
  delete(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return { endpoint: S3_ENDPOINT.replace(/\/+$/, ""), bucket: S3_BUCKET, region: env.S3_REGION || "auto", accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY };
}

const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (S3: each path segment once, "/" kept) */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request (SigV4, header auth). `headers` must not yet contain authorization; host,
 * x-amz-date and x-amz-content-sha256 are added. Exported for the test against AWS's published example.
 */
export function signV4(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}): Record<string, string> {
  const service = opts.service ?? "s3";
  const amzDate = opts.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: opts.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": opts.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...opts.url.searchParams.entries()]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [opts.method, opts.url.pathname, query, canonicalHeaders, signedHeaders, opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export class S3Store implements ObjectStore {
  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private url(key: string): URL {
    if (!key || key.startsWith("/") || key.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error("invalid storage key");
    return new URL(`${this.cfg.endpoint}/${encodeSegment(this.cfg.bucket)}/${key.split("/").map(encodeSegment).join("/")}`);
  }

  private async send(method: string, key: string, body?: Uint8Array, contentType?: string): Promise<Response> {
    const url = this.url(key);
    const extra: Record<string, string> = contentType ? { "content-type": contentType } : {};
    const headers = signV4({
      method,
      url,
      headers: extra,
      payloadHash: sha256hex(body ?? ""),
      region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      date: new Date(),
    });
    delete headers.host; // fetch sets it
    return this.fetchImpl(url, { method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(60_000) });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage GET failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const res = await this.send("PUT", key, body, contentType);
    if (!res.ok) throw new Error(`storage PUT failed: HTTP ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`storage DELETE failed: HTTP ${res.status}`);
  }
}

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore | null {
  const cfg = s3ConfigFromEnv(env);
  return cfg ? new S3Store(cfg) : null;
}

/** For tests: objects in memory */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
