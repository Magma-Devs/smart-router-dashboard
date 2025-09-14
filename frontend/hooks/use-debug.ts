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
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetch(`${config.apiEndpoint}/api/auth/debug-status`);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data: DebugStatus = await response.json();
        setDebugMode(data.debug_mode);
      } catch (err) {
        console.error('Error checking debug status:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
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
