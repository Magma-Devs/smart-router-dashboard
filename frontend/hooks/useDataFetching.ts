import { useState, useCallback } from 'react';

interface UseDataFetchingOptions<T> {
  initialData?: T | null;
  onSuccess?: (data: T) => void;
  onError?: (error: string) => void;
}

interface UseDataFetchingReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  fetchData: (fetcher: () => Promise<T>) => Promise<void>;
  setData: (data: T | null) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export function useDataFetching<T>({
  initialData = null,
  onSuccess,
  onError,
}: UseDataFetchingOptions<T> = {}): UseDataFetchingReturn<T> {
  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (fetcher: () => Promise<T>) => {
      setLoading(true);
      setError(null);

      try {
        const result = await fetcher();
        setData(result);
        onSuccess?.(result);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        setError(errorMessage);
        onError?.(errorMessage);
        console.error('Data fetching error:', err);
      } finally {
        setLoading(false);
      }
    },
    [onSuccess, onError],
  );

  return {
    data,
    loading,
    error,
    fetchData,
    setData,
    setError,
    setLoading,
  };
}
