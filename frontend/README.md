# Smart Router Dashboard Frontend

A modern React/Next.js frontend application for monitoring and managing Smart Router infrastructure with real-time metrics, system flow visualization, and comprehensive KPI tracking.

## 🚀 Features

### **Real-Time Monitoring**

- **KPI Dashboard**: Live monitoring of Uptime, Latency, and Reachability
- **System Flow Visualization**: Interactive visualization of consumer-provider relationships
- **Multi-Chain Support**: Monitor individual chains or all chains simultaneously
- **Time Window Selection**: View metrics for 5 minutes to 24 hours

### **Advanced Analytics**

- **Prometheus Integration**: Real-time data from Prometheus metrics
- **Color-Coded KPIs**: Visual indicators for performance status (Green/Orange/Red)
- **Mock Data Mode**: Development and testing with simulated data
- **Auto-refresh**: Configurable refresh intervals

### **User Experience**

- **Responsive Design**: Works seamlessly on desktop and mobile
- **Dark/Light Theme**: Modern UI with theme support
- **Keyboard Shortcuts**: Quick access to features (Ctrl+Shift+M for mock toggle)
- **Loading States**: Smooth user experience with loading indicators

## 🏗️ Architecture

### **Technology Stack**

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI + shadcn/ui
- **State Management**: React Hooks (useState, useEffect, useCallback)
- **HTTP Client**: Custom API client with error handling
- **Icons**: Lucide React

### **Project Structure**

```
frontend/
├── app/                          # Next.js App Router
│   ├── config/                   # Configuration files
│   │   └── chains.ts            # Chain definitions and metadata
│   ├── dashboard/                # Main dashboard page
│   ├── configuration/           # Settings and configuration
│   ├── live-test/               # Live testing interface
│   ├── wizard/                  # Setup wizard
│   └── layout.tsx               # Root layout
├── components/                   # Reusable UI components
│   ├── ui/                      # Base UI components (shadcn/ui)
│   ├── summary-section.tsx      # KPI dashboard section
│   ├── flow-visualization.tsx   # System flow visualization
│   ├── nav-bar.tsx             # Navigation bar
│   └── nav.tsx                 # Navigation component
├── hooks/                        # Custom React hooks
│   ├── use-config.ts            # Configuration management
│   ├── use-debug.ts             # Debug utilities
│   └── use-local-storage.ts     # Local storage utilities
├── lib/                          # Utility libraries
│   └── api-client.ts            # HTTP client configuration
└── public/                       # Static assets
    └── images/                   # Images and icons
```

## 📊 KPI Metrics

### **Uptime**

- **Metric**: `smartrouter_overall_health_breakdown`
- **Calculation**: Percentage of healthy router timestamps
- **Thresholds**:
  - 🟢 Green: ≥99.5%
  - 🟠 Orange: 95-99.4%
  - 🔴 Red: <95%

### **Latency**

- **Metric**: `smartrouter_end_to_end_latency_milliseconds`
- **Calculation**: Average response time across the router
- **Thresholds**:
  - 🟢 Green: ≤200ms
  - 🟠 Orange: 201-500ms
  - 🔴 Red: >500ms

### **Reachability**

- **Metrics**: `smartrouter_overall_health_breakdown` + `rpc_endpoint_overall_health`
- **Calculation**: Average percentage of healthy endpoints per router
- **Thresholds**:
  - 🟢 Green: ≥95%
  - 🟠 Orange: 85-94.9%
  - 🔴 Red: <85%

## 🛠️ Development

### **Prerequisites**

- Node.js 18+
- npm or yarn
- Backend API running (see backend README)

### **Installation**

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API endpoint
```

### **Environment Variables**

```env
# API Configuration
NEXT_PUBLIC_API_URL=https://your-api-endpoint.com

# Development
NODE_ENV=development
```

### **Development Commands**

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run linting
npm run lint

# Run type checking
npm run type-check
```

## 🔧 Configuration

### **API Endpoint Configuration**

The frontend connects to the backend API for real-time data. Configure the endpoint in:

1. **Environment Variable**: `NEXT_PUBLIC_API_URL`
2. **UI Configuration**: Settings page (`/configuration`)
3. **Local Storage**: Persisted user preferences

### **Chain Configuration**

Chains are defined in `app/config/chains.ts`:

```typescript
export const chains = [
  { value: 'ETH1', label: 'Ethereum Mainnet', icon: '/images/ethereum.svg' },
  { value: 'COSMOS', label: 'Cosmos Hub', icon: '/images/cosmos.svg' },
  // ... more chains
];
```

### **Time Windows**

Available time windows for metrics:

- 5 minutes
- 15 minutes
- 30 minutes
- 1 hour
- 4 hours
- 24 hours

## 🎨 UI Components

### **KPICard Component**

Reusable card component for displaying metrics:

```typescript
<KPICard
  title="Uptime"
  value="98.5%"
  color="green"
  isLoading={false}
/>
```

### **Summary Section**

Main dashboard component with:

- Chain selection dropdown
- Time window selector
- Mock data toggle
- Refresh button
- KPI cards grid

### **Flow Visualization**

Interactive system flow diagram showing:

- Consumer health status
- Provider health status
- Connection lines
- Real-time updates

## 🔌 API Integration

### **Prometheus Queries**

The frontend makes the following Prometheus queries:

1. **Router Health**: `smartrouter_overall_health_breakdown`
2. **Endpoint Health**: `rpc_endpoint_overall_health`
3. **Latency**: `avg_over_time(smartrouter_end_to_end_latency_milliseconds[1m])`

### **API Endpoints**

- `GET /api/metrics/last_minutes` - Fetch Prometheus metrics
- `GET /api/components/` - Get available chains
- `GET /api/auth/debug-status` - Authentication status

## 🚀 Deployment

### **Build Process**

```bash
# Install dependencies
npm install

# Build application
npm run build

# Start production server
npm start
```

### **Docker Deployment**

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### **Environment Configuration**

Ensure the following environment variables are set:

- `NEXT_PUBLIC_API_URL` - Backend API endpoint
- `NODE_ENV` - Environment (production/development)

## 🐛 Troubleshooting

### **Common Issues**

**CORS Errors**

- Ensure backend CORS is configured for frontend domain
- Check API endpoint configuration

**No Data Loading**

- Verify API endpoint is accessible
- Check network connectivity
- Enable mock data mode for testing

**Build Errors**

- Clear `.next` cache: `rm -rf .next`
- Reinstall dependencies: `rm -rf node_modules && npm install`

### **Debug Mode**

Enable debug logging by setting `NODE_ENV=development` and checking browser console for detailed error messages.

## 🤝 Contributing

### **Code Style**

- Use TypeScript for all new code
- Follow ESLint configuration
- Use Prettier for formatting
- Write meaningful commit messages

### **Component Guidelines**

- Use functional components with hooks
- Implement proper TypeScript interfaces
- Add loading and error states
- Make components reusable

### **Testing**

- Test components in isolation
- Verify API integration
- Test responsive design
- Validate accessibility

## 📝 License

This project is part of the Smart Router infrastructure monitoring system.

---

For backend documentation, see the [backend README](../backend/README.md).
