# Infrastructure Health Dashboard

A modern, responsive web application for visualizing infrastructure health and uptime.

## Features

- Real-time monitoring of provider health
- Interactive time series graph
- Visual flow representation of system components
- Configurable refresh intervals
- Dark/light theme support

## Getting Started with Docker

### Prerequisites

- Docker
- Docker Compose

### Running the Application

1. Clone this repository
2. Build and start the containers:

\`\`\`bash
docker-compose up -d
\`\`\`

3. Access the dashboard at http://localhost:3000

### Using the Mock API

The docker-compose setup includes a mock API service that provides sample data for testing. The mock API is accessible at:

\`\`\`
http://localhost:8000/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown
\`\`\`

To configure the dashboard to use this mock API:

1. Go to the Configuration page
2. Set the API Endpoint URL to: `http://mock-api:8000/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown`
3. Save the configuration

## Development

### Running Locally

1. Install dependencies:

\`\`\`bash
npm install
\`\`\`

2. Start the development server:

\`\`\`bash
npm run dev
\`\`\`

3. Access the dashboard at http://localhost:3000

### Building for Production

\`\`\`bash
npm run build
\`\`\`

## Configuration

The dashboard can be configured through the Configuration page:

- API Endpoint URL: Set the backend endpoint for fetching metrics data
- Refresh Interval: Configure how frequently the dashboard refreshes data (1 second to 5 minutes)

## License

MIT
