'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface AuthContextType {
  isAuthenticated: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

  useEffect(() => {
    // Check if user is already authenticated on mount
    checkAuthStatus();

    // Listen for auth failures from API client
    const handleAuthFailed = () => {
      setIsAuthenticated(false);
      setUsername(null);
      sessionStorage.removeItem('auth_credentials');
    };

    window.addEventListener('auth-failed', handleAuthFailed);
    return () => window.removeEventListener('auth-failed', handleAuthFailed);
  }, []);

  const checkAuthStatus = async () => {
    try {
      const savedCredentials = sessionStorage.getItem('auth_credentials');
      if (!savedCredentials) {
        setIsAuthenticated(false);
        setUsername(null);
        setLoading(false);
        return;
      }

      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: {
          'Authorization': `Basic ${savedCredentials}`,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsAuthenticated(true);
        setUsername(data.username);
      } else {
        // Invalid credentials, clear them
        sessionStorage.removeItem('auth_credentials');
        setIsAuthenticated(false);
        setUsername(null);
      }
    } catch (error) {
      console.error('Error checking auth status:', error);
      sessionStorage.removeItem('auth_credentials');
      setIsAuthenticated(false);
      setUsername(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      setLoading(true);
      
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setIsAuthenticated(true);
        setUsername(data.username);
        
        // Store credentials returned from backend for future requests
        sessionStorage.setItem('auth_credentials', data.credentials);
        
        return true;
      } else {
        setIsAuthenticated(false);
        setUsername(null);
        return false;
      }
    } catch (error) {
      console.error('Login error:', error);
      setIsAuthenticated(false);
      setUsername(null);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setIsAuthenticated(false);
    setUsername(null);
    sessionStorage.removeItem('auth_credentials');
    
    // Call logout endpoint
    fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(console.error);
  };

  const value: AuthContextType = {
    isAuthenticated,
    username,
    login,
    logout,
    loading,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
