# Node.js Coverage HTTP

[![E2E Tests](https://github.com/psturc/node-coverage-http/actions/workflows/test-kind.yml/badge.svg)](https://github.com/psturc/node-coverage-http/actions/workflows/test-kind.yml)
[![codecov](https://codecov.io/gh/psturc/node-coverage-http/branch/main/graph/badge.svg)](https://codecov.io/gh/psturc/node-coverage-http)

HTTP-based coverage collection for Node.js applications running in Kubernetes pods with read-only root filesystems.

## Overview

This project provides a **pure wrapper** approach to collect code coverage from Node.js applications running in Kubernetes, even when the filesystem is read-only (a security best practice). It consists of:

1. **Coverage Server Wrapper** (`server/coverage_server.js`): Wraps any Node.js application, collects coverage using V8 Inspector API (purely in-memory), and exposes it via HTTP endpoints
2. **Coverage Client** (`client/coverage_client.js`): Collects coverage data from running pods via Kubernetes port-forwarding and generates reports (text, HTML, XML)
3. **Sample Application** (`app.js`): A simple Express.js app demonstrating the setup

## Key Features

- ✅ **Read-Only Root Filesystem Compatible**: Works with `readOnlyRootFilesystem: true` security context
- ✅ **Purely In-Memory**: No filesystem writes - works in any environment
- ✅ **No Volume Mounts Required**: No persistent volumes or writable directories needed
- ✅ **Application-Agnostic**: Pure wrapper - no modifications to your app code required
- ✅ **ES Module Support**: Full support for ES modules via V8 Inspector API
- ✅ **Real-Time Coverage**: Collects coverage from long-running servers using Inspector API
- ✅ **Kubernetes-Native**: Designed for K8s deployments with port-forwarding support
- ✅ **Multiple Report Formats**: Text, HTML, and XML (Cobertura) reports generated automatically
- ✅ **Non-Root User Compatible**: Runs as UID 65532 (non-root)
- ✅ **Intelligent Path Remapping**: Auto-detects and remaps container paths to local filesystem

## Using in Your Own Application

Want to add coverage collection to your existing Node.js backend? Here's how:

### Step 1: Add Coverage Server to Your Project

Download the coverage server wrapper into your project:

```bash
# Create server directory if it doesn't exist
mkdir -p server

# Download the coverage server
curl -o server/coverage_server.js \
  https://raw.githubusercontent.com/psturc/node-coverage-http/main/server/coverage_server.js
```

### Step 2: Add Dependencies

Add the required devDependencies to your `package.json`:

```bash
yarn add --dev c8 v8-to-istanbul
# or
npm install --save-dev c8 v8-to-istanbul
```

### Step 3: Update Your Dockerfile

Add a `test` stage to your Dockerfile that extends your production image:

```dockerfile
# Your existing production stage
FROM node:20-slim AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "app.js"]

# New test stage - extends production
FROM production AS test

# Switch to root to install dev dependencies
USER root

# Install dev dependencies (c8, v8-to-istanbul)
RUN npm ci

# Environment for coverage
ENV COVERAGE_PORT=9095
ENV NODE_ENV=test

# Switch back to non-root user
USER 65532:65532

# Run your app through the coverage wrapper
CMD ["node", "/app/server/coverage_server.js", "/app/app.js"]
```

**Note**: Replace `/app/app.js` with the path to your application's entry point.

### Step 4: Build and Deploy Test Image

```bash
# Build test image
docker build --target test -t your-app:test .

# Deploy to Kubernetes (update your deployment to use :test tag)
kubectl apply -f your-deployment.yaml
```

### Step 5: Collect Coverage from Your Tests

Install the coverage client in your test project:

```bash
# Option 1: Copy from this repo
curl -o coverage_client.js \
  https://raw.githubusercontent.com/psturc/node-coverage-http/main/client/coverage_client.js

# Option 2: Install dependencies
npm install --save-dev @kubernetes/client-node axios
```

Use the client in your tests:

```javascript
import { CoverageClient } from './coverage_client.js';

// Initialize client
const client = new CoverageClient('your-namespace', './coverage-output');

// Discover your pod
const podName = await CoverageClient.getPodName(
  'your-namespace',
  'app=your-app'  // Your pod label selector
);

// Run your tests here...
// await runYourTests();

// Collect coverage
await client.collectCoverageFromPod(podName, 'e2e_tests', 9095);

// Generate reports
await client.generateCoverageReport('e2e_tests', '.', true);  // Text
await client.generateHtmlReport('e2e_tests', '.', true);      // HTML
await client.generateXmlReport('e2e_tests', '.', true);       // XML
```

### Step 6: View Your Coverage Reports

```bash
# Text report
cat coverage-output/report_e2e_tests.txt

# HTML report (interactive)
open coverage-output/html_e2e_tests/index.html

# XML report (for CI/Codecov)
cat coverage-output/cobertura-coverage.xml
```

### That's It! 🎉

Your application now collects coverage with:
- ✅ No code changes to your app
- ✅ No volume mounts needed
- ✅ Works with read-only filesystems
- ✅ Purely in-memory coverage collection

---

## Quick Start (Demo Application)

Want to try the demo first? Here's how to run the included sample application:

### Prerequisites

- Node.js 18+ 
- Docker
- Kind (Kubernetes in Docker) or access to a Kubernetes cluster
- kubectl

### 1. Install Dependencies

```bash
cd node-coverage-http
yarn install
```

### 2. Build Docker Image

```bash
# Build the test image (includes coverage wrapper)
docker build --target test -t localhost/node-coverage-http:test .
```

### 3. Deploy to Kind

```bash
# Create Kind cluster with port mapping
kind create cluster --config kind-config.yaml

# Load image into Kind
kind load docker-image localhost/node-coverage-http:test

# Deploy to Kubernetes
kubectl apply -f k8s-deployment.yaml

# Wait for pod to be ready
kubectl wait --for=condition=ready pod -l app=coverage-demo-node -n coverage-demo-node --timeout=60s
```

### 4. Run E2E Tests with Coverage Collection

```bash
node test/e2e.js
```

The test will:
1. Run tests against the application (accessible at `http://localhost:9000`)
2. Collect coverage data from the pod via port-forwarding (using Inspector API)
3. Generate reports in `./coverage-output/`:
   - **Text report** with coverage percentages and uncovered lines
   - **HTML report** with interactive line-by-line coverage
   - **XML report** (Cobertura format) for CI/CD integration

### 5. View Coverage Reports

```bash
# View text report
cat coverage-output/report_e2e_tests.txt

# View HTML report (interactive)
open coverage-output/html_e2e_tests/index.html

# View XML report (for CI/Codecov)
cat coverage-output/cobertura-coverage.xml

# Disable HTML report generation (faster for CI)
GENERATE_HTML_REPORTS=false node test/e2e.js
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes Pod                            │
│  ┌────────────────────────────────────────────────────┐     │
│  │  Coverage Server Wrapper (port 9095)               │     │
│  │  - Uses V8 Inspector API for real-time coverage    │     │
│  │  - Converts V8 → Istanbul (purely in-memory)       │     │
│  │  - Exposes HTTP endpoints:                         │     │
│  │    GET /coverage    - Dump coverage data (base64)  │     │
│  │    GET /health      - Health check                 │     │
│  │    GET /coverage/reset - Reset counters            │     │
│  └────────────────────────────────────────────────────┘     │
│                         ↓                                    │
│  ┌────────────────────────────────────────────────────┐     │
│  │  Your Node.js Application (port 9000)              │     │
│  │  - Runs with V8 coverage enabled                   │     │
│  │  - No code changes required                        │     │
│  │  - Full ES module support                          │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                          ↑
                    kubectl port-forward
                          ↓
┌─────────────────────────────────────────────────────────────┐
│              Coverage Client (your test machine)             │
│  1. Port-forward to pod:9095                                │
│  2. GET /coverage → Download coverage data (Istanbul)       │
│  3. Decode base64 JSON                                      │
│  4. Auto-detect and remap paths (/app/ → local/)           │
│  5. Generate reports (text/HTML/XML)                        │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
node-coverage-http/
├── server/
│   └── coverage_server.js      # Coverage wrapper (runs your app with NYC)
├── client/
│   └── coverage_client.js      # Client to collect coverage from pods
├── test/
│   └── e2e.js                  # E2E tests with coverage collection
├── app.js                      # Sample Express.js application
├── Dockerfile                  # Multi-stage: production + test
├── k8s-deployment.yaml         # Kubernetes deployment (readOnlyRootFilesystem)
├── kind-config.yaml            # Kind cluster configuration
├── package.json                # Dependencies
└── README.md
```

## Usage

### Running Locally (Without Kubernetes)

```bash
# Run app normally
node app.js

# Run app with coverage wrapper
node server/coverage_server.js app.js

# In another terminal, collect coverage
curl http://localhost:9095/coverage?name=test1
```

### Using the Coverage Client Programmatically

```javascript
import { CoverageClient } from './client/coverage_client.js';

const client = new CoverageClient('coverage-demo-node', './coverage-output');

// Get pod name dynamically
const podName = await CoverageClient.getPodName(
  'coverage-demo-node', 
  'app=coverage-demo-node'
);

// Collect coverage
const coverageFile = await client.collectCoverageFromPod(
  podName,
  'my_test',
  9095,        // coverage port
  30,          // timeout
  true         // use kubectl (true) or native port-forward (false)
);

// Generate reports
await client.generateCoverageReport('my_test', '.', true);
await client.generateXmlReport('my_test', '.', true);
await client.generateHtmlReport('my_test', '.', true);
```

### Environment Variables

**Coverage Server (`server/coverage_server.js`)**:
- `COVERAGE_PORT` - Port for coverage HTTP server (default: 9095)

**E2E Tests (`test/e2e.js`)**:
- `K8S_NAMESPACE` - Kubernetes namespace (default: coverage-demo-node)
- `APP_URL` - Application URL (default: http://localhost:9000)
- `USE_KUBECTL` - Use kubectl for port-forward (default: true)
- `GENERATE_HTML_REPORTS` - Generate HTML reports (default: true)

## How It Works

### 1. Coverage Wrapper (Server-Side)

The `coverage_server.js` wrapper uses the **Node.js Inspector API** for real-time coverage:
1. Starts a V8 Inspector session with precise coverage enabled
2. Imports and runs your application (full ES module support)
3. On coverage request, uses `Profiler.takePreciseCoverage()` to get V8 coverage data
4. Converts V8 format → Istanbul format using `v8-to-istanbul` (purely in-memory)
5. Returns coverage as base64-encoded Istanbul JSON via HTTP

**Why Inspector API?**
- ✅ Real-time coverage from long-running servers
- ✅ Full ES module support (unlike older nyc versions)
- ✅ Native V8 coverage (accurate and fast)
- ✅ Purely in-memory - no filesystem writes needed
- ✅ Works in any environment (even without `/dev/shm`)

### 2. Coverage Collection (Client-Side)

The `coverage_client.js` client:
- Uses kubectl port-forward (or native Kubernetes API) to connect to the pod
- Fetches coverage data via HTTP (Istanbul format, base64-encoded)
- Decodes and saves coverage JSON files
- **Intelligently remaps paths**: Auto-detects container paths (e.g., `/app/`) and maps to local paths
- Generates reports using nyc (text, HTML, XML/Cobertura)

**Intelligent Path Remapping:**
- Scans coverage data to find files that don't exist locally
- Matches path structures by comparing suffixes (filename backwards)
- Automatically determines path mappings (e.g., `/app/` → `/Users/you/project/`)
- Updates both outer keys and internal `path` fields in coverage data

### 3. Security Features

The deployment uses strict security settings with **NO volume mounts**:
```yaml
securityContext:
  readOnlyRootFilesystem: true    # Root FS is read-only ✓
  runAsNonRoot: true               # Non-root user (65532) ✓
  allowPrivilegeEscalation: false  # No privilege escalation ✓
  capabilities:
    drop: [ALL]                    # Drop all capabilities ✓
# NO volumeMounts needed!
# Coverage data is purely in-memory - no filesystem writes!
```

## Python Version

A similar implementation for Python applications is available at [py-coverage-http](https://github.com/psturc/py-coverage-http).

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run E2E tests with coverage
  run: |
    cd node-coverage-http/test
    node e2e.js

- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
  with:
    files: ./node-coverage-http/test/coverage-output/coverage.xml
```

## Troubleshooting

### Pod not found
```bash
# Check if pod is running
kubectl get pods -n coverage-demo-node

# Check pod logs
kubectl logs -n coverage-demo-node -l app=coverage-demo-node
```

### Port-forward issues
```bash
# Make sure kubectl is configured
kubectl cluster-info

# Try native port-forward instead
USE_KUBECTL=false node test/e2e.js
```

### Coverage data empty
```bash
# Check if coverage server is responding
kubectl port-forward -n coverage-demo-node <pod-name> 9095:9095
curl http://localhost:9095/health
```

## Advanced Usage

### Custom Coverage Configuration

The server uses `v8-to-istanbul` for coverage conversion. You can customize what gets instrumented by modifying the filters in `server/coverage_server.js`:

```javascript
// In convertV8ToIstanbul function - customize these patterns:
if (script.url.includes('/server/') || 
    script.url.includes('/client/') || 
    script.url.includes('/test/')) {
  continue; // Skip these files
}
```

For report generation, configure `.nycrc` in your project:

```json
{
  "all": false,
  "exclude": [
    "coverage/**",
    "test/**",
    "server/**",
    "client/**",
    "**/*.test.js"
  ],
  "reporter": ["html", "text", "cobertura"]
}
```

### Multi-Pod Coverage Collection

```javascript
const pods = await k8sApi.listNamespacedPod(namespace, ...);
for (const pod of pods.items) {
  await client.collectCoverageFromPod(pod.metadata.name, `test-${pod.metadata.name}`);
}
```

## Contributing

Contributions welcome! Please open an issue or PR.

## See Also

- [py-coverage-http](https://github.com/psturc/py-coverage-http) - Similar implementation for Python applications
- [c8 Documentation](https://github.com/bcoe/c8) - Native V8 coverage
- [NYC Documentation](https://github.com/istanbuljs/nyc) - Istanbul coverage
- [Node.js Inspector API](https://nodejs.org/api/inspector.html) - V8 Inspector
- [Kubernetes Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)

