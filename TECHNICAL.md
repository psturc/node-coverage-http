# Technical Documentation

## Architecture Overview

This project implements HTTP-based coverage collection for Node.js applications running in Kubernetes pods with strict security constraints (read-only root filesystem).

### Components

#### 1. Coverage Server Wrapper (`server/coverage_server.js`)

**Purpose**: Pure wrapper that runs any Node.js application with V8 Inspector API + c8 for coverage collection.

**How it works**:
1. Creates a V8 Inspector Session (`inspector.Session`)
2. Enables Profiler and starts precise coverage (`Profiler.startPreciseCoverage`)
3. Imports and runs your application (native ES module support via `import()`)
4. On coverage request:
   - Calls `Profiler.takePreciseCoverage()` to get real-time V8 coverage
   - Writes V8 coverage to temporary file
   - Uses `npx c8 report` to convert V8 → Istanbul format
   - Reads the generated Istanbul JSON
5. Returns coverage as base64-encoded Istanbul JSON via HTTP

**Why Inspector API over NYC child process?**
- ✅ **ES Module Support**: Full support for ES modules (nyc v15-v17 had issues)
- ✅ **Real-Time Coverage**: Can collect from long-running servers without restart
- ✅ **Accurate**: Uses native V8 coverage (no source transformation)
- ✅ **No Process Spawning**: App runs in same process (lower overhead)
- ✅ **Non-Zero Execution Counts**: Proper recording of statement/function hits

**Key Design**: Uses `/dev/shm` (shared memory tmpfs) which:
- Is available in ALL containers by default
- Requires NO volume mounts
- Is RAM-backed (fast and secure)
- Works with `readOnlyRootFilesystem: true`

**Key Features**:
- Application-agnostic (no code changes needed)
- Works with read-only root filesystem
- Runs as non-root user (UID 65532)
- Thread-safe HTTP server
- Full ES module support

**HTTP Endpoints**:

```javascript
GET /coverage?name=<label>
  → Returns: { label, timestamp, coverage_data: base64(Istanbul JSON) }
  
GET /health
  → Returns: { status: "ok", coverage_enabled: true }
  
GET /coverage/reset
  → Clears V8 coverage data
```

**Coverage Flow**:
1. V8 coverage stored in `/dev/shm/coverage/tmp/`
2. c8 converts V8 → Istanbul and writes to `/dev/shm/coverage/coverage-final.json`
3. Server reads Istanbul JSON and returns via HTTP

#### 2. Coverage Client (`client/coverage_client.js`)

**Purpose**: Collects coverage data from Kubernetes pods via port-forwarding.

**Key Methods**:

```javascript
// Get pod name dynamically
static async getPodName(namespace, labelSelector)

// Collect coverage from pod
async collectCoverageFromPod(podName, testName, coveragePort, timeout, useKubectl)

// Generate reports
async generateCoverageReport(testName, sourceDir, remapPaths)
async generateHtmlReport(testName, sourceDir, remapPaths)
async generateXmlReport(testName, sourceDir, remapPaths)

// Reset coverage
async resetCoverage(podName, coveragePort, timeout, useKubectl)
```

**Port-Forward Methods**:

1. **kubectl binary** (default, reliable):
   - Spawns `kubectl port-forward` as subprocess
   - Uses HTTP requests to collect data
   - Works anywhere kubectl works

2. **Native Kubernetes client** (no kubectl required):
   - Uses `@kubernetes/client-node` package
   - Direct API communication
   - Useful in CI environments

**Intelligent Path Remapping**:

The client implements **automatic path detection** (similar to Python version):

1. **Detection Phase**:
   - Scans coverage data for files that don't exist locally (container paths)
   - Recursively collects all local source files with their relative paths
   - Matches container files to local files by comparing path suffixes (filename backwards)
   - Calculates best match score (longer suffix matches = higher score)

2. **Mapping Phase**:
   - Extracts container root from matched files (e.g., `/app/`)
   - Calculates corresponding local root (e.g., `/Users/user/project/`)
   - Selects the mapping with the most matches (most common root)

3. **Remapping Phase**:
   - Updates **both** outer keys and internal `path` fields in coverage data
   - Filters out instrumentation files (server/, client/, test/)
   - Only includes files that exist locally after remapping

**Example**:
- Container: `/app/app.js` → Local: `/Users/user/project/app.js`
- Container: `/app/lib/utils.js` → Local: `/Users/user/project/lib/utils.js`

**Why this matters**:
1. NYC needs to find source files to generate reports with line numbers
2. Container paths don't exist on the local machine
3. Coverage data contains absolute paths from the container
4. Internal `path` field must match for report generation to work

#### 3. Application (`app.js`)

Simple Express.js application demonstrating:
- Standard web server setup
- Graceful shutdown handling
- Multiple routes for testing

## Coverage Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                  Kubernetes Pod (Test Mode)                   │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ coverage_server.js (Port 9095)                          │ │
│  │                                                          │ │
│  │  1. Creates Inspector Session                           │ │
│  │  2. Enables Profiler.startPreciseCoverage              │ │
│  │  3. Imports app.js (ES module support)                  │ │
│  │  4. On /coverage request:                               │ │
│  │     a. Profiler.takePreciseCoverage() → V8 data        │ │
│  │     b. Write V8 JSON to /dev/shm/coverage/tmp/         │ │
│  │     c. npx c8 report → Istanbul format                 │ │
│  │     d. Read Istanbul JSON                               │ │
│  │     e. Return as base64                                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ app.js (Port 9000) - Your Application                   │ │
│  │  - Running normally with V8 coverage enabled            │ │
│  │  - All code execution tracked by V8                     │ │
│  │  - Full ES module support                               │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           ↓
                    kubectl port-forward
                           ↓
┌──────────────────────────────────────────────────────────────┐
│                   Test Machine (Local)                        │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ test/e2e.js                                             │ │
│  │  1. Run tests against app (port 9000)                   │ │
│  │  2. Import CoverageClient                               │ │
│  │  3. After tests: collect coverage                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ client/coverage_client.js                               │ │
│  │  1. Port-forward to pod:9095                            │ │
│  │  2. GET /coverage → base64 Istanbul JSON               │ │
│  │  3. Decode JSON → Istanbul coverage data                │ │
│  │  4. Auto-detect paths (container → local)              │ │
│  │  5. Remap paths (update keys & internal path field)    │ │
│  │  6. Save to coverage-output/coverage_<test>.json        │ │
│  │  7. Call NYC to generate reports                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Reports Generated (all 3 by default)                    │ │
│  │  - coverage-output/report_<test>.txt                    │ │
│  │  - coverage-output/cobertura-coverage.xml               │ │
│  │  - coverage-output/html_<test>/index.html               │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Istanbul Coverage Format

Coverage data is stored in Istanbul format (JSON) with this structure:

```json
{
  "/app/app.js": {
    "path": "/app/app.js",
    "statementMap": { "0": { "start": {...}, "end": {...} }, ... },
    "fnMap": { "0": { "name": "...", "decl": {...}, ... }, ... },
    "branchMap": { "0": { "loc": {...}, "type": "...", ... }, ... },
    "s": { "0": 1, "1": 5, ... },  // Statement hit counts
    "f": { "0": 1, "1": 3, ... },  // Function hit counts
    "b": { "0": [1, 0], ... }      // Branch hit counts
  }
}
```

Key fields:
- `s`: Statement execution counts
- `f`: Function execution counts
- `b`: Branch execution counts (for if/else, switch, etc.)

## Security Considerations

### Read-Only Root Filesystem with NO Volume Mounts

The deployment uses `readOnlyRootFilesystem: true` with **NO volume mounts**:

```yaml
securityContext:
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
# NO volumeMounts needed!
```

**Why this matters**:
1. Prevents malicious code from modifying system files
2. Follows security best practices (CIS benchmarks)
3. Required by many enterprise security policies
4. No persistent storage = better security

**How we handle it**:
- NYC coverage data goes to `/dev/shm/coverage/` (in-memory tmpfs)
- `/dev/shm` is a RAM-backed filesystem available in ALL containers
- No volume mounts required
- Application code in `/app/` (read-only)
- No writes to root filesystem or persistent storage

**Benefits of /dev/shm**:
- ✅ Always available (no configuration needed)
- ✅ RAM-backed (fast performance)
- ✅ Automatically cleaned up when container stops
- ✅ No persistent storage concerns
- ✅ Works with strictest security policies

### Non-Root User

The container runs as UID 65532 (nobody):
```dockerfile
USER 65532:65532
```

Benefits:
- Prevents privilege escalation
- Limits damage from compromised processes
- Follows principle of least privilege

## Performance Considerations

### Coverage Overhead

V8 Inspector API + c8 adds some overhead:
- **CPU**: ~5-15% increase (lower than source transformation)
- **Memory**: ~20-50 MB for coverage data
- **Startup time**: ~50-100ms additional

For production: Use the `production` target which doesn't include coverage.

### Optimization Tips

1. **Exclude unnecessary files** in `server/coverage_server.js`:
```javascript
--exclude='server/**' --exclude='client/**' --exclude='test/**' --exclude='node_modules/**'
```

2. **Use c8's built-in filtering** for focused coverage:
```javascript
--src=/app  // Only cover files in /app directory
```

3. **Disable HTML reports in CI** for faster runs:
```bash
GENERATE_HTML_REPORTS=false node test/e2e.js
```

## Kubernetes Deployment

### Multi-Stage Dockerfile

```dockerfile
# Base stage - dependencies
FROM node:20-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# Production - no coverage
FROM node:20-slim AS production
WORKDIR /app
COPY --from=base /app /app
CMD ["node", "app.js"]

# Test - with coverage
FROM node:20-slim AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci  # Install devDependencies (includes nyc)
COPY . .
ENV COVERAGE_PORT=9095
USER 65532:65532
CMD ["node", "/app/server/coverage_server.js", "/app/app.js"]
```

**Build targets**:
- `production`: Minimal, no devDependencies, no coverage
- `test`: Includes NYC and coverage wrapper

### Resource Limits

Recommended resource limits:

```yaml
resources:
  requests:
    memory: "128Mi"  # Minimum needed
    cpu: "100m"      # 0.1 CPU cores
  limits:
    memory: "256Mi"  # Maximum allowed
    cpu: "200m"      # 0.2 CPU cores
```

Adjust based on your application's needs.

## CI/CD Integration

### GitHub Actions

```yaml
name: E2E Tests with Coverage

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Kind
        uses: helm/kind-action@v1
        with:
          config: kind-config.yaml
      
      - name: Build and load image
        run: |
          docker build --target test -t localhost/node-coverage-http:test .
          kind load docker-image localhost/node-coverage-http:test
      
      - name: Deploy to Kind
        run: |
          kubectl apply -f k8s-deployment.yaml
          kubectl wait --for=condition=ready pod -l app=coverage-demo-node \
            -n coverage-demo-node --timeout=60s
      
      - name: Run E2E tests
        run: |
          cd test
          npm install
          node e2e.js
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./test/coverage-output/coverage.xml
```

## Troubleshooting

### Coverage Data Not Found

**Symptom**: HTTP 500 error when calling `/coverage`

**Causes**:
1. NYC hasn't created `.nyc_output/` yet
2. `/tmp` volume not mounted
3. Permissions issue

**Solution**:
```bash
# Check pod logs
kubectl logs -n coverage-demo-node deployment/coverage-demo-node

# Check if /tmp is writable
kubectl exec -n coverage-demo-node deployment/coverage-demo-node -- ls -la /tmp/coverage
```

### Path Remapping Issues

**Symptom**: "Source file not found" in reports

**Causes**:
1. Container paths don't match local paths
2. Source files moved or renamed
3. Working directory mismatch

**Solution**:
```javascript
// Explicitly specify source directory
await client.generateCoverageReport('test1', '/absolute/path/to/source', true);
```

### Port-Forward Failures

**Symptom**: Connection refused or timeout

**Causes**:
1. kubectl not configured
2. Pod not running
3. Firewall blocking

**Solution**:
```bash
# Test kubectl connectivity
kubectl get pods -n coverage-demo-node

# Try native port-forward
USE_KUBECTL=false node test/e2e.js

# Check pod status
kubectl describe pod -n coverage-demo-node -l app=coverage-demo-node
```

## Python Version

A similar implementation for Python applications is available at [py-coverage-http](https://github.com/psturc/py-coverage-http).

## Why c8 + Inspector API Instead of NYC?

Initially, this project used NYC (nyc v15-v17), but we switched to c8 + Inspector API because:

1. **ES Module Issues with NYC**: NYC v15-v17 had known limitations with ES modules:
   - Would instrument files but report 0% coverage
   - Execution counts were not recorded properly
   - Statement/function hit counts remained at 0

2. **Real-Time Collection**: NYC child process approach couldn't collect coverage from long-running servers without restart

3. **Native V8 Coverage**: Inspector API provides native V8 coverage data:
   - No source transformation needed
   - More accurate
   - Lower overhead
   - Better ES module support

4. **c8 Benefits**:
   - Built on V8's native coverage (same as Chrome DevTools)
   - Excellent ES module support
   - Can convert V8 → Istanbul format for report compatibility
   - Actively maintained

**Result**: 80.64% coverage with accurate execution counts vs. 0% with NYC

## Future Enhancements

Possible improvements:
1. **Streaming coverage**: Send coverage incrementally instead of all at once
2. **Differential coverage**: Compare with baseline coverage
3. **Coverage thresholds**: Fail tests if coverage drops below threshold
4. **Multi-pod aggregation**: Collect from multiple pods automatically
5. **WebSocket support**: Real-time coverage updates via WebSocket

## References

- [c8 Documentation](https://github.com/bcoe/c8) - Native V8 coverage
- [Node.js Inspector API](https://nodejs.org/api/inspector.html) - V8 Inspector
- [NYC Documentation](https://github.com/istanbuljs/nyc) - Istanbul (for report generation)
- [Istanbul Coverage Format](https://github.com/istanbuljs/istanbuljs.github.io/blob/master/content/docs/advanced/coverage-format.md)
- [V8 Coverage](https://v8.dev/blog/javascript-code-coverage) - V8's native coverage
- [Kubernetes Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Cobertura XML Format](http://cobertura.github.io/cobertura/)

