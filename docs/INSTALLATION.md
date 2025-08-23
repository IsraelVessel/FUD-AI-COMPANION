# FUD AI Companion - Installation Guide

This guide will help you set up the FUD AI Companion application for development and production environments.

## Prerequisites

### Required Software
- **Node.js**: Version 18.0.0 or higher
- **PostgreSQL**: Version 14.0 or higher
- **Redis**: Version 6.0 or higher (for caching and sessions)
- **Git**: For version control

### Required Accounts/Services
- **OpenAI API Key**: For AI companion functionality
- **Paystack Account**: For payment processing (Nigerian payments)
- **Email Service**: Gmail/SMTP for notifications

## Installation Steps

### 1. Install Node.js

**Windows:**
1. Visit [nodejs.org](https://nodejs.org/)
2. Download the LTS version for Windows
3. Run the installer and follow the setup wizard
4. Verify installation: Open PowerShell and run:
   ```powershell
   node --version
   npm --version
   ```

**Alternative - Using Chocolatey:**
```powershell
choco install nodejs
```

### 2. Install PostgreSQL

**Windows:**
1. Download from [postgresql.org](https://www.postgresql.org/download/windows/)
2. Run the installer
3. Remember the superuser password you set
4. Add PostgreSQL bin directory to your PATH

**Alternative - Using Chocolatey:**
```powershell
choco install postgresql
```

### 3. Install Redis

**Windows:**
1. Download Redis for Windows from [GitHub releases](https://github.com/microsoftarchive/redis/releases)
2. Extract and run `redis-server.exe`

**Alternative - Using Docker:**
```powershell
docker run -d -p 6379:6379 --name fud-redis redis:latest
```

### 4. Clone and Setup the Project

```bash
# Clone the repository
git clone <repository-url>
cd FUD-AI-Companion

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Install mobile app dependencies
cd ../mobile
npm install
```

### 5. Database Setup

1. **Create Database:**
   ```sql
   -- Connect to PostgreSQL as superuser
   psql -U postgres
   
   -- Create database and user
   CREATE DATABASE fud_ai_companion;
   CREATE USER fud_user WITH PASSWORD 'your_secure_password';
   GRANT ALL PRIVILEGES ON DATABASE fud_ai_companion TO fud_user;
   
   -- Connect to the new database
   \c fud_ai_companion
   
   -- Grant schema permissions
   GRANT ALL ON SCHEMA public TO fud_user;
   ```

2. **Run Database Migrations:**
   ```bash
   cd backend
   # Copy environment file
   cp .env.example .env
   
   # Edit .env with your database credentials
   # Then run migrations
   npm run migrate
   ```

### 6. Environment Configuration

Create and configure environment files:

**Backend (.env):**
```env
NODE_ENV=development
PORT=3000

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=fud_ai_companion
DB_USER=fud_user
DB_PASSWORD=your_secure_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT Secrets (generate secure random strings)
JWT_SECRET=your_super_secret_jwt_key_here_minimum_32_chars
JWT_REFRESH_SECRET=your_refresh_token_secret_here_minimum_32_chars

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Paystack
PAYSTACK_SECRET_KEY=your_paystack_secret_key
PAYSTACK_PUBLIC_KEY=your_paystack_public_key

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
```

**Frontend (.env):**
```env
REACT_APP_API_URL=http://localhost:3000/api/v1
REACT_APP_PAYSTACK_PUBLIC_KEY=your_paystack_public_key
```

**Mobile (.env):**
```env
API_URL=http://localhost:3000/api/v1
PAYSTACK_PUBLIC_KEY=your_paystack_public_key
```

### 7. Initial Data Setup

```bash
cd backend
# Seed initial data (faculties, departments, courses, etc.)
npm run seed
```

### 8. Start Development Servers

**Terminal 1 - Backend API:**
```bash
cd backend
npm run dev
```

**Terminal 2 - Frontend Dashboard:**
```bash
cd frontend
npm start
```

**Terminal 3 - Mobile App (if developing):**
```bash
cd mobile
npm start
```

## Verification

1. **Backend API**: Visit http://localhost:3000/health
   - Should return: `{"status":"OK",...}`

2. **Database Connection**: 
   ```bash
   cd backend
   npm run test:db
   ```

3. **Redis Connection**: Check Redis logs for connections

4. **Frontend**: Visit http://localhost:3001
   - Should load the admin dashboard

## Production Deployment

### Environment Setup
- Use production-grade PostgreSQL instance
- Configure Redis cluster for high availability
- Set up proper SSL certificates
- Use environment-specific secrets

### Recommended Infrastructure
- **Cloud Provider**: AWS, Azure, or Google Cloud
- **Database**: Managed PostgreSQL (RDS, Azure Database, etc.)
- **Caching**: Managed Redis (ElastiCache, Azure Cache, etc.)
- **Container**: Docker with orchestration (ECS, AKS, GKE)
- **Load Balancer**: Application Load Balancer with SSL termination

### Security Considerations
- Generate strong, unique JWT secrets
- Use SSL/TLS for all connections
- Enable database encryption
- Configure proper CORS origins
- Set up rate limiting and DDoS protection
- Regular security updates

## Troubleshooting

### Common Issues

**Port Already in Use:**
```bash
# Find process using port 3000
netstat -ano | findstr :3000
# Kill the process (replace PID)
taskkill /PID <PID> /F
```

**Database Connection Failed:**
- Check PostgreSQL service is running
- Verify credentials in .env file
- Ensure database exists
- Check firewall settings

**Redis Connection Failed:**
- Check Redis server is running
- Verify Redis host/port configuration
- Test connection: `redis-cli ping`

**NPM Install Issues:**
```bash
# Clear npm cache
npm cache clean --force
# Delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Getting Help

1. Check application logs
2. Review error messages carefully
3. Verify all services are running
4. Check environment configuration
5. Consult the documentation

## Next Steps

After successful installation:
1. Read the [API Documentation](./API.md)
2. Review [Architecture Overview](./ARCHITECTURE.md)
3. Set up [Development Workflow](./DEVELOPMENT.md)
4. Configure [Monitoring and Analytics](./MONITORING.md)

## Support

For installation issues:
- Create an issue in the repository
- Include error messages and system information
- Specify which step failed during installation
