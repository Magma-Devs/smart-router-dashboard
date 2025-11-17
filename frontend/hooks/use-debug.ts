import { useState, useEffect } from 'react';
import { useConfig } from './use-config';

interface DebugStatus {
  debug_mode: boolean;
  message: string;
}

export function useDebug() {
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const { config } = useConfig();

  useEffect(() => {
    const checkDebugStatus = async () => {
      // Don't make request if API endpoint is not configured
      if (!config.apiEndpoint || config.apiEndpoint.trim() === '') {
        console.warn('[Debug] Skipping debug status check: API endpoint not configured');
        setDebugMode(false);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        const debugUrl = `${config.apiEndpoint}/api/auth/debug-status`;
        console.log('[Debug] Checking debug status at:', debugUrl);

        const response = await fetch(debugUrl);

        if (!response.ok) {
          // 404 is acceptable - endpoint might not exist in all environments
          if (response.status === 404) {
            console.log('[Debug] Debug status endpoint not found (404) - debug mode disabled');
            setDebugMode(false);
            setIsLoading(false);
            return;
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data: DebugStatus = await response.json();
        console.log('[Debug] Debug status received:', data);
        setDebugMode(data.debug_mode);
      } catch (err) {
        // Only log errors that aren't 404s (which are handled above)
        if (err instanceof Error && !err.message.includes('404')) {
          console.error('[Debug] Error checking debug status:', err);
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
        setDebugMode(false); // Default to false on error
      } finally {
        setIsLoading(false);
      }
    };

    checkDebugStatus();
  }, [config.apiEndpoint]);

  return {
    debugMode,
    isLoading,
    error,
  };
}
