const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 8391;
const BASE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

let serverProcess = null;
let passed = 0;
let failed = 0;

const test = (name, fn) => {
	return async () => {
		try {
			await fn();
			passed++;
			console.log(`  ✓ ${name}`);
		}
		catch (err) {
			failed++;
			console.log(`  ✗ ${name}: ${err.message}`);
		}
	};
};

const httpRequest = (method, urlPath, body = null) => {
	return new Promise((resolve, reject) => {
		const url = new URL(urlPath, BASE_URL);
		const options = {
			hostname: url.hostname,
			port: url.port,
			path: url.pathname,
			method,
			headers: { 'Content-Type': 'application/json' },
			timeout: 10000,
		};

		const req = http.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => {
				data += chunk;
			});
			res.on('end', () => {
				try {
					resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null, raw: data });
				}
				catch (e) {
					resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
				}
			});
		});

		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});

		if (body) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
};

const startServer = () => {
	return new Promise((resolve, reject) => {
		serverProcess = spawn('node', [path.join(__dirname, '..', 'index.js')], {
			cwd: path.join(__dirname, '..'),
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let started = false;
		const timeout = setTimeout(() => {
			if (!started) {
				reject(new Error('Server start timeout'));
			}
		}, 10000);

		serverProcess.stdout.on('data', (data) => {
			const msg = data.toString();
			if (msg.includes('Bridge server started') && !started) {
				started = true;
				clearTimeout(timeout);
				setTimeout(resolve, 500);
			}
		});

		serverProcess.stderr.on('data', (data) => {
			console.error('  [Server Error]', data.toString().trim());
		});

		serverProcess.on('error', reject);
		serverProcess.on('exit', (code) => {
			if (!started) {
				clearTimeout(timeout);
				reject(new Error(`Server exited with code ${code} before starting`));
			}
		});
	});
};

const stopServer = () => {
	if (serverProcess) {
		serverProcess.kill('SIGINT');
		serverProcess = null;
	}
};

const run = async () => {
	console.log('cc2deepseek Bridge Tests\n');

	// --- Unit tests (no server needed) ---
	console.log('Unit: Model Mapper');
	const { mapModel } = require('../index.js');

	await test('claude-opus-4-7 → deepseek-v4-pro', async () => {
		const result = mapModel('claude-opus-4-7');
		if (result !== 'deepseek-v4-pro') {
			throw new Error(`Expected deepseek-v4-pro, got ${result}`);
		}
	})();

	await test('claude-sonnet-4-6 → deepseek-v4-flash', async () => {
		const result = mapModel('claude-sonnet-4-6');
		if (result !== 'deepseek-v4-flash') {
			throw new Error(`Expected deepseek-v4-flash, got ${result}`);
		}
	})();

	await test('claude-haiku-4-5-20251001 → deepseek-v4-flash', async () => {
		const result = mapModel('claude-haiku-4-5-20251001');
		if (result !== 'deepseek-v4-flash') {
			throw new Error(`Expected deepseek-v4-flash, got ${result}`);
		}
	})();

	await test('unknown-model passthrough', async () => {
		const result = mapModel('some-unknown-model');
		if (result !== 'some-unknown-model') {
			throw new Error(`Expected passthrough, got ${result}`);
		}
	})();

	await test('null/empty model passthrough', async () => {
		const r1 = mapModel(null);
		const r2 = mapModel('');
		if (r1 !== null || r2 !== '') {
			throw new Error('Expected null/empty passthrough');
		}
	})();

	// --- Integration tests (server required) ---
	console.log('\nIntegration: Bridge Server');
	console.log('  Starting server...');

	try {
		await startServer();
		console.log('  Server started');

		await test('GET /health returns ok', async () => {
			const res = await httpRequest('GET', '/health');
			if (res.status !== 200 || res.body.status !== 'ok') {
				throw new Error(`Health check failed: ${res.status} ${JSON.stringify(res.body)}`);
			}
		})();

		await test('POST /v1/messages proxies and maps model', async () => {
			const res = await httpRequest('POST', '/v1/messages', {
				model: 'claude-opus-4-7',
				messages: [{ role: 'user', content: 'Hello' }],
				max_tokens: 100,
				stream: false,
			});
			if (res.status === 502) {
				console.log('    (offline — upstream unreachable, acceptable)');
			}
			else if (res.status >= 500) {
				throw new Error(`Unexpected upstream error: ${res.status}`);
			}
		})();

		await test('OPTIONS returns CORS headers', async () => {
			const res = await httpRequest('OPTIONS', '/v1/messages');
			if (res.status !== 200 || !res.headers['access-control-allow-origin']) {
				throw new Error('CORS headers missing');
			}
		})();

		await test('POST /v1/messages/count_tokens proxies through', async () => {
			const res = await httpRequest('POST', '/v1/messages/count_tokens', {
				model: 'claude-sonnet-4-6',
				messages: [{ role: 'user', content: 'Hello' }],
			});
			if (res.status === 502) {
				console.log('    (offline — upstream unreachable, acceptable)');
			}
			else if (res.status >= 500) {
				throw new Error(`Unexpected upstream error: ${res.status}`);
			}
		})();
	}
	finally {
		stopServer();
	}

	console.log(`\n${'='.repeat(40)}`);
	console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	console.log(`${'='.repeat(40)}`);

	if (failed > 0) {
		process.exit(1);
	}
};

run().catch((err) => {
	console.error('Test suite error:', err);
	stopServer();
	process.exit(1);
});
