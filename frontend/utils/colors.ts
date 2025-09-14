/**
 * Shared color utilities for metrics display
 * Works for both KPI cards and table cells
 */

// Color thresholds
const UPTIME_GREEN = 99.5;
const UPTIME_ORANGE = 95;
const REACHABILITY_GREEN = 95;
const REACHABILITY_ORANGE = 85;
const LATENCY_GREEN = 300;
const LATENCY_ORANGE = 500;

// Helper function to parse numeric values
const parseValue = (value: string, unit: string): number => {
  if (value === 'Error' || value === 'N/A' || value === 'Coming Soon') return -1;
  const numericValue = parseFloat(value.replace(unit, ''));
  return isNaN(numericValue) ? -1 : numericValue;
};

// Color functions that return CSS classes for tables
export const getUptimeColor = (value: string): string => {
  const num = parseValue(value, '%');
  if (num === -1) return 'text-red-500';
  if (num >= UPTIME_GREEN) return 'text-green-500';
  if (num >= UPTIME_ORANGE) return 'text-orange-500';
  return 'text-red-500';
};

export const getReachabilityColor = (value: string): string => {
  const num = parseValue(value, '%');
  if (num === -1) return 'text-red-500';
  if (num >= REACHABILITY_GREEN) return 'text-green-500';
  if (num >= REACHABILITY_ORANGE) return 'text-orange-500';
  return 'text-red-500';
};

export const getLatencyColor = (value: string): string => {
  const num = parseValue(value, 'ms');
  if (num === -1) return 'text-red-500';
  if (num <= LATENCY_GREEN) return 'text-green-500';
  if (num <= LATENCY_ORANGE) return 'text-orange-500';
  return 'text-red-500';
};

// Color functions that return color names for KPI cards
export const getUptimeColorName = (value: string): 'green' | 'orange' | 'red' => {
  const num = parseValue(value, '%');
  if (num === -1) return 'red';
  if (num >= UPTIME_GREEN) return 'green';
  if (num >= UPTIME_ORANGE) return 'orange';
  return 'red';
};

export const getReachabilityColorName = (value: string): 'green' | 'orange' | 'red' => {
  const num = parseValue(value, '%');
  if (num === -1) return 'red';
  if (num >= REACHABILITY_GREEN) return 'green';
  if (num >= REACHABILITY_ORANGE) return 'orange';
  return 'red';
};

export const getLatencyColorName = (value: string): 'green' | 'orange' | 'red' => {
  const num = parseValue(value, 'ms');
  if (num === -1) return 'red';
  if (num <= LATENCY_GREEN) return 'green';
  if (num <= LATENCY_ORANGE) return 'orange';
  return 'red';
};

// Helper function to get inline color style based on CSS class
// Used to override CSS specificity issues in tables
export const getInlineColor = (colorClass: string): string => {
  if (colorClass.includes('green')) return '#22c55e'; // green-500
  if (colorClass.includes('orange')) return '#f97316'; // orange-500
  if (colorClass.includes('red')) return '#ef4444'; // red-500
  return 'inherit';
};
