import { apiClient } from '@/lib/api-client';

export interface ApiKey {
  id: string;
  name: string;
  is_active: boolean;
  kid: string;
  jwt_suffix: string;
  created_at: string;
  updated_at: string;
}

export interface CreateKeyResponse extends ApiKey {
  token: string;
}

export async function listKeys(): Promise<ApiKey[]> {
  return apiClient.get<ApiKey[]>('/api/keys');
}

export async function createKey(name: string): Promise<CreateKeyResponse> {
  return apiClient.post<CreateKeyResponse>('/api/keys', { name });
}

export async function updateKey(id: string, data: Partial<ApiKey>): Promise<ApiKey> {
  return apiClient.patch<ApiKey>(`/api/keys/${id}`, data);
}

export async function deleteKey(id: string): Promise<void> {
  return apiClient.delete<void>(`/api/keys/${id}`);
}
