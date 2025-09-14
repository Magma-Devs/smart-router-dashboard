# Smart Router Dashboard

A comprehensive dashboard for monitoring and managing Smart Router infrastructure with authentication.

## Features

- **Authentication**: HTTP Basic Authentication with configurable credentials
- **Real-time Metrics**: Prometheus integration for infrastructure monitoring
- **Configuration Management**: Helm values management (and configuration wizard in DEBUG mode)
- **Live Testing**: Test your chain configurations in real-time
- **Responsive UI**: Modern Next.js frontend with Tailwind CSS

## Authentication

The dashboard is protected by HTTP Basic Authentication. All backend endpoints require valid credentials.

### Default Credentials

- **Username**: `admin`
- **Password**: `password`

### Configuration

Credentials are configured via environment variables in the `docker-compose.yml` file:

```yaml
environment:
  - AUTH_USERNAME=admin
  - AUTH_PASSWORD=password
```

### How It Works

1. **Frontend**: Users must log in through the login form before accessing any protected content
2. **Backend**: All API endpoints (except `/api/auth/status`) require authentication
3. **Session Management**: Credentials are stored in sessionStorage and automatically included in API requests
4. **Logout**: Users can log out through the user menu in the navigation bar

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Kubernetes cluster access
- Prometheus instance

### Running the Application

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd modules/dashboard
   ```

2. **Configure credentials** (optional - defaults are set)
   Edit `docker-compose.yml` to change the `AUTH_USERNAME` and `AUTH_PASSWORD` if needed.

3. **Start the services**

   ```bash
   docker-compose up -d
   ```

4. **Access the dashboard**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

### First Login

1. Navigate to the dashboard URL
2. You'll be redirected to the login page
3. Use the default credentials:
   - Username: `admin`
   - Password: `password`
4. After successful authentication, you'll have access to all dashboard features

## API Endpoints

### Public Endpoints

- `GET /api/health` - Health check
- `GET /api` - API information
- `GET /api/auth/status` - Authentication status

### Protected Endpoints (require authentication)

- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Current user info
- `GET /api/metrics/chains` - Chain metrics and KPIs
- `GET /api/metrics/chains-to-providers` - Chain-to-provider mapping with health data
- `GET /api/metrics/providers` - Provider metrics
- `GET /api/components/*` - All component endpoints

## Security Features

- **HTTP Basic Authentication**: Secure credential verification
- **Session Management**: Automatic credential inclusion in requests
- **CORS Configuration**: Proper cross-origin resource sharing setup
- **Input Validation**: Pydantic models for request/response validation
- **Error Handling**: Secure error messages without information leakage

## Customization

### Changing Credentials

To change the default credentials:

1. Update the environment variables in `docker-compose.yml`:

   ```yaml
   environment:
     - AUTH_USERNAME=your_new_username
     - AUTH_PASSWORD=your_new_password
   ```

2. Restart the backend service:
   ```bash
   docker-compose restart backend
   ```

### Adding New Protected Endpoints

To protect new endpoints, add the authentication dependency:

```python
from app.core.auth import get_current_user

@router.get("/your-endpoint")
async def your_endpoint(current_user: str = Depends(get_current_user)):
    # Your endpoint logic here
    pass
```

## Troubleshooting

### Authentication Issues

- **401 Unauthorized**: Check that credentials are correct
- **CORS Errors**: Ensure the frontend URL is properly configured
- **Session Expired**: Clear browser storage and log in again

### Common Problems

1. **Credentials not working**: Verify the environment variables are set correctly
2. **Frontend not loading**: Check that the frontend service is running
3. **API calls failing**: Ensure the backend service is accessible and credentials are valid

## Development

### Backend Development

The backend is built with FastAPI and includes:

- **Authentication middleware**: HTTP Basic Auth with session management
- **Protected route decorators**: Secure endpoint access control
- **Comprehensive error handling**: Detailed error responses and logging
- **Prometheus integration**: Real-time metrics collection and monitoring
- **Type-safe APIs**: Pydantic models for request/response validation
- **Test coverage**: Comprehensive test suite with dataclass validation

### Frontend Development

The frontend is built with Next.js and includes:

- **Authentication context**: Global auth state management
- **Protected route components**: Automatic redirect for unauthorized access
- **Automatic API client**: Auth headers included in all requests
- **Responsive UI components**: Modern design with Tailwind CSS
- **Type safety**: Full TypeScript integration with shared type definitions
- **Flow visualization**: Interactive React Flow diagrams for system monitoring

### Code Quality Improvements

- **Shared Types**: Consolidated API types in `/types/metrics.ts`
- **No Duplication**: Eliminated duplicate type definitions across components
- **Better Testing**: Dataclass-based validation instead of manual assertions
- **Import Organization**: Proper import structure and organization
- **Type Safety**: End-to-end type safety from backend to frontend
