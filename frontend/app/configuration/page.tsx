'use client';

import type React from 'react';

import { useState, useEffect } from 'react';
import { useConfig } from '@/hooks/use-config';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { Toaster } from '@/components/ui/toaster';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import { ProtectedRoute } from '@/components/protected-route';

export default function ConfigurationPage() {
  const { config, updateApiEndpoint, updatePrometheusUrl, updateEndpointDomain, updateEndpointPort, resetConfig } = useConfig();
  const [inputValue, setInputValue] = useState(config.apiEndpoint || '');
  const [prometheusInputValue, setPrometheusInputValue] = useState(config.prometheusUrl || '');
  const [domainInputValue, setDomainInputValue] = useState(config.endpointDomain || '');
  const [portInputValue, setPortInputValue] = useState(config.endpointPort || '');
  const [isPreviewEnvironment, setIsPreviewEnvironment] = useState(false);

  useEffect(() => {
    setInputValue(config.apiEndpoint);
    setPrometheusInputValue(config.prometheusUrl);
    setDomainInputValue(config.endpointDomain);
    setPortInputValue(config.endpointPort);
    // Check if we're in a preview environment
    if (typeof window !== 'undefined') {
      setIsPreviewEnvironment(window.location.hostname !== 'localhost');
    }
  }, [config.apiEndpoint, config.prometheusUrl, config.endpointDomain, config.endpointPort]);

  const handleApiSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Basic validation
    if (!inputValue.trim()) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'API host cannot be empty',
      });
      return;
    }

    // Ensure the endpoint has a protocol
    let endpoint = inputValue.trim();
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      endpoint = `http://${endpoint}`;
    }

    updateApiEndpoint(endpoint);
    toast({
      title: 'API Host saved',
      description: 'Your API host has been updated successfully',
    });
  };

  const handlePrometheusSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Basic validation
    if (!prometheusInputValue.trim()) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Prometheus URL cannot be empty',
      });
      return;
    }

    // Handle Prometheus URL - add protocol if provided without one
    let prometheusUrl = prometheusInputValue.trim();
    if (!prometheusUrl.startsWith('http://') && !prometheusUrl.startsWith('https://')) {
      prometheusUrl = `http://${prometheusUrl}`;
    }

    updatePrometheusUrl(prometheusUrl);
    toast({
      title: 'Prometheus URL saved',
      description: 'Your Prometheus URL has been updated successfully',
    });
  };

  const handleEndpointSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const domain = (domainInputValue || '').trim();
    const port = (portInputValue || '').trim();

    // Basic validation
    if (!domain) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Domain cannot be empty',
      });
      return;
    }

    if (!port) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Port cannot be empty',
      });
      return;
    }

    updateEndpointDomain(domain);
    updateEndpointPort(port);
    toast({
      title: 'Endpoint configuration saved',
      description: 'Your endpoint domain and port have been updated successfully',
    });
  };

  const handleResetAll = () => {
    resetConfig();
    toast({
      title: 'Configuration reset',
      description: 'All settings have been reset to defaults',
    });
  };

  return (
    <ProtectedRoute>
      <div className='container mx-auto px-4 py-6 max-w-7xl'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold'>Settings</h1>
          <p className='text-muted-foreground'>
            Configure your dashboard settings and preferences.
          </p>
        </div>

        {isPreviewEnvironment && (
          <Alert className='mb-6'>
            <Info className='h-4 w-4' />
            <AlertTitle>Preview Environment Detected</AlertTitle>
            <AlertDescription>
              You are running in a preview environment. Localhost URLs may not work here. For
              production use, configure a publicly accessible API host.
            </AlertDescription>
          </Alert>
        )}

        <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
          {/* API Host Card */}
          <Card>
            <CardHeader>
              <CardTitle>API Host</CardTitle>
              <CardDescription>
                Backend API endpoint for dashboard data
              </CardDescription>
            </CardHeader>
            <form onSubmit={handleApiSubmit}>
              <CardContent>
                <div className='flex flex-col space-y-1.5'>
                  <Label htmlFor='apiHost'>Backend URL</Label>
                  <Input
                    id='apiHost'
                    placeholder='http://localhost:8000'
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                  />
                  <p className='text-sm text-muted-foreground'>
                    Provides metrics, configuration, and authentication
                  </p>
                  {isPreviewEnvironment && inputValue.includes('localhost') && (
                    <p className='text-sm text-amber-500'>
                      Localhost may not be accessible here.
                    </p>
                  )}
                </div>
              </CardContent>
              <CardFooter>
                <Button type='submit'>Save</Button>
              </CardFooter>
            </form>
          </Card>

          {/* Prometheus URL Card */}
          <Card>
            <CardHeader>
              <CardTitle>Prometheus</CardTitle>
              <CardDescription>
                Prometheus endpoint for metrics collection
              </CardDescription>
            </CardHeader>
            <form onSubmit={handlePrometheusSubmit}>
              <CardContent>
                <div className='flex flex-col space-y-1.5'>
                  <Label htmlFor='prometheusUrl'>Prometheus URL</Label>
                  <Input
                    id='prometheusUrl'
                    placeholder='http://prometheus.example.com'
                    value={prometheusInputValue}
                    onChange={e => setPrometheusInputValue(e.target.value)}
                  />
                  <p className='text-sm text-muted-foreground'>
                    Used by backend for querying metrics
                  </p>
                  {isPreviewEnvironment && prometheusInputValue.includes('localhost') && (
                    <p className='text-sm text-amber-500'>
                      Localhost may not be accessible here.
                    </p>
                  )}
                </div>
              </CardContent>
              <CardFooter>
                <Button type='submit'>Save</Button>
              </CardFooter>
            </form>
          </Card>

          {/* Endpoint Configuration Card */}
          <Card>
            <CardHeader>
              <CardTitle>Endpoint Configuration</CardTitle>
              <CardDescription>
                Domain and port for endpoint URL calculation
              </CardDescription>
            </CardHeader>
            <form onSubmit={handleEndpointSubmit}>
              <CardContent>
                <div className='flex flex-col space-y-4'>
                  <div className='flex flex-col space-y-1.5'>
                    <Label htmlFor='endpointDomain'>Domain</Label>
                    <Input
                      id='endpointDomain'
                      placeholder='lava.lavapro.xyz'
                      value={domainInputValue || ''}
                      onChange={e => setDomainInputValue(e.target.value)}
                    />
                  </div>
                  <div className='flex flex-col space-y-1.5'>
                    <Label htmlFor='endpointPort'>Port</Label>
                    <Input
                      id='endpointPort'
                      placeholder='443'
                      value={portInputValue || ''}
                      onChange={e => setPortInputValue(e.target.value)}
                    />
                  </div>
                  <p className='text-sm text-muted-foreground'>
                    Used to construct endpoint URLs: <code className='text-xs bg-muted px-1 py-0.5 rounded'>{`{chain}-{interface}.${domainInputValue || 'domain'}:${portInputValue || 'port'}`}</code>
                  </p>
                </div>
              </CardContent>
              <CardFooter>
                <Button type='submit'>Save</Button>
              </CardFooter>
            </form>
          </Card>

          {/* Reset Card */}
          <Card>
            <CardHeader>
              <CardTitle>Reset Configuration</CardTitle>
              <CardDescription>
                Reset all settings to defaults
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className='text-sm text-muted-foreground'>
                Restore all settings to their original default values from the environment configuration.
              </p>
            </CardContent>
            <CardFooter>
              <Button variant='outline' onClick={handleResetAll}>
                Reset All to Defaults
              </Button>
            </CardFooter>
          </Card>
        </div>
        <Toaster />
      </div>
    </ProtectedRoute>
  );
}
