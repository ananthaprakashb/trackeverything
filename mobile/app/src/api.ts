import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const API_URL = String(Constants.expoConfig?.extra?.apiUrl || '').replace(/\/$/, '');
const ACCESS_TOKEN_KEY = 'trackEverythingAccessToken';

export type User = {
  id: string;
  name: string;
  email: string;
  picture?: string | null;
  role: 'admin' | 'member';
  groupId: string;
  groupName: string;
  spreadsheetUrl?: string;
};

export type Dashboard = {
  members: Array<{ memberId: string; name: string; goal: number; steps: number; syncedAt?: string | null }>;
  projects: Array<{ projectId: string; name: string; type: string; sheetTitle: string }>;
  trend: Array<{ date: string; steps: number }>;
};

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) await clearToken();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload.data as T;
}

export const getMe = () => apiRequest<User>('/api/me');
export const getDashboard = () => apiRequest<Dashboard>('/api/dashboard');
export const addSteps = (steps: number, date: string, source = 'mobile-manual') =>
  apiRequest('/api/steps', {
    method: 'POST',
    body: JSON.stringify({
      eventId: `${source}:${date}:${steps}`,
      steps,
      date,
      source,
    }),
  });
