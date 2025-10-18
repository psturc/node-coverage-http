/**
 * E2E tests that collect coverage from running pods
 * 
 * This test suite demonstrates coverage collection from a Node.js app
 * running in Kubernetes with a read-only root filesystem.
 * 
 * Environment Variables:
 * - USE_KUBECTL=true|false          - Port-forward method (default: true)
 * - GENERATE_HTML_REPORTS=true|false - Generate HTML reports (default: false)
 * - K8S_NAMESPACE=<namespace>        - Kubernetes namespace (default: coverage-demo-node)
 * 
 * Coverage collection flow:
 * 1. Tests run against the application
 * 2. AFTER ALL TESTS: Collect coverage from the pod
 * 3. Generate reports (text, XML, and optionally HTML)
 */

import axios from 'axios';
import { CoverageClient } from '../client/coverage_client.js';

// Configuration
const NAMESPACE = process.env.K8S_NAMESPACE || 'coverage-demo-node';
const APP_URL = process.env.APP_URL || 'http://localhost:9000';
const COVERAGE_PORT = 9095;

// Port-forward method for coverage collection
const USE_KUBECTL_FOR_COVERAGE = process.env.USE_KUBECTL !== 'false';

// HTML report generation (enabled by default, can be disabled with GENERATE_HTML_REPORTS=false)
const GENERATE_HTML_REPORTS = process.env.GENERATE_HTML_REPORTS !== 'false';

// Test state
let coverageClient;
let podName;
let testResults = [];

/**
 * Initialize test environment
 */
async function setup() {
  console.log('\n' + '='.repeat(60));
  console.log('Setting up E2E tests...');
  console.log('='.repeat(60));

  // Initialize coverage client
  coverageClient = new CoverageClient(NAMESPACE, './coverage-output');

  // Discover pod name
  try {
    podName = await CoverageClient.getPodName(NAMESPACE, 'app=coverage-demo-node');
    console.log(`[test] Discovered pod: ${podName}`);
  } catch (error) {
    console.error(`[test] Failed to discover pod: ${error.message}`);
    console.error('[test] Make sure the pod is running and kubectl is configured');
    process.exit(1);
  }

  // Log port-forward method
  const method = USE_KUBECTL_FOR_COVERAGE ? 'kubectl binary' : 'native Kubernetes client';
  console.log(`[test] Coverage collection method: ${method}`);
  console.log(`[test] Application URL: ${APP_URL}`);
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('Running E2E tests...');
  console.log('='.repeat(60) + '\n');

  await test('Index endpoint', async () => {
    const response = await axios.get(`${APP_URL}/`);
    assert(response.status === 200, `Expected status 200, got ${response.status}`);
    assert(response.data.includes('Hello'), 'Response should contain "Hello"');
    console.log(`[test] ✓ Index endpoint returned: ${response.data}`);
  });

  await test('Status endpoint', async () => {
    const response = await axios.get(`${APP_URL}/status`);
    assert(response.status === 200, `Expected status 200, got ${response.status}`);
    assert(response.data.status === 'ok', 'Status should be "ok"');
    console.log(`[test] ✓ Status endpoint returned:`, response.data);
  });

  await test('API users endpoint', async () => {
    const response = await axios.get(`${APP_URL}/api/users`);
    assert(response.status === 200, `Expected status 200, got ${response.status}`);
    assert(Array.isArray(response.data), 'Response should be an array');
    assert(response.data.length > 0, 'Users array should not be empty');
    console.log(`[test] ✓ Users endpoint returned ${response.data.length} users`);
  });
}

/**
 * Collect coverage and generate reports
 */
async function collectCoverage() {
  console.log('\n' + '='.repeat(60));
  console.log('All tests complete - collecting coverage...');
  console.log('='.repeat(60) + '\n');

  try {
    // Collect coverage from the pod
    const coverageFile = await coverageClient.collectCoverageFromPod(
      podName,
      'e2e_tests',
      COVERAGE_PORT,
      30,
      USE_KUBECTL_FOR_COVERAGE
    );

    if (!coverageFile) {
      console.error('[coverage] ⚠ Failed to collect coverage');
      return;
    }

    console.log(`[coverage] ✓ Coverage collected: ${coverageFile}`);

    // Generate text report (always, with path remapping)
    console.log('[coverage] Generating text coverage report...');
    try {
      await coverageClient.generateCoverageReport('e2e_tests', '..', true);
    } catch (error) {
      console.error(`[coverage] ⚠ Text report generation failed: ${error.message}`);
    }

    // Generate XML report (always, for CI/Codecov, with path remapping)
    console.log('[coverage] Generating XML coverage report...');
    try {
      await coverageClient.generateXmlReport('e2e_tests', '..', true);
    } catch (error) {
      console.error(`[coverage] ⚠ XML generation failed: ${error.message}`);
    }

    // Generate HTML report (if enabled, with path remapping)
    if (GENERATE_HTML_REPORTS) {
      console.log('[coverage] Generating HTML coverage report...');
      try {
        await coverageClient.generateHtmlReport('e2e_tests', '..', true);
      } catch (error) {
        console.error(`[coverage] ⚠ HTML report generation failed: ${error.message}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Coverage Reports Generated:');
    console.log('='.repeat(60));
    if (GENERATE_HTML_REPORTS) {
      console.log('📊 HTML Report:  ./coverage-output/html_e2e_tests/index.html');
    }
    console.log('📄 Text Report:  ./coverage-output/report_e2e_tests.txt');
    console.log('📦 XML Report:   ./coverage-output/cobertura-coverage.xml');
    console.log('💾 Coverage Data: ./coverage-output/coverage_e2e_tests.json');
    console.log('='.repeat(60));
  } catch (error) {
    console.error(`[coverage] ⚠ Error collecting coverage: ${error.message}`);
    console.error(error.stack);
  }
}

/**
 * Print test summary
 */
function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));

  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  const total = testResults.length;

  console.log(`Total: ${total}`);
  console.log(`✓ Passed: ${passed}`);
  if (failed > 0) {
    console.log(`✗ Failed: ${failed}`);
  }
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log('\nFailed tests:');
    testResults.filter(r => !r.passed).forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    });
  }

  return failed === 0;
}

/**
 * Simple test runner
 */
async function test(name, fn) {
  try {
    await fn();
    testResults.push({ name, passed: true });
  } catch (error) {
    console.error(`[test] ✗ ${name}: ${error.message}`);
    testResults.push({ name, passed: false, error: error.message });
  }
}

/**
 * Simple assertion function
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

/**
 * Main test execution
 */
async function main() {
  try {
    await setup();
    await runTests();
    await collectCoverage();
    
    const success = printSummary();
    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error('[test] Fatal error:', error);
    process.exit(1);
  }
}

// Run tests
main();

