export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Emitted when the server says the session is gone, so the shell can show the sign-in screen.
export const SESSION_EXPIRED = 'lms:session-expired';

export async function api<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'lms',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED));
    }
    throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? res.statusText), data);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});

// Reads a local file as a data URL (for logos, backgrounds, attachments).
export function fileToDataUrl(file: File, maxMb: number): Promise<string> {
  if (file.size > maxMb * 1024 * 1024) return Promise.reject(new Error(`File is larger than ${maxMb} MB`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export const pkr = (n: number | null | undefined) =>
  n == null ? '-' : new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }) : '-';

export const dateOnly = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '-';

export const todayPk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
