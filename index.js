const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const targetUrl = new URL(config.target.url);
const apiKey = config.target.apiKey;
const { port, host } = config.server;
const logLevel = config.logLevel || 'info';

const log = (level, ...args) => {
	const levels = { debug: 0, info: 1, warn: 2, error: 3 };
	if (levels[level] >= levels[logLevel]) {
		const ts = new Date().toISOString();
		console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
	}
};

const mapModel = (modelName) => {
	if (!modelName || !config.modelMapping) {
		return modelName;
	}
	for (const rule of config.modelMapping) {
		if (modelName.startsWith(rule.prefix)) {
			return rule.target;
		}
	}
	return modelName;
};

const forwardRequest = (req, body, callback) => {
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${apiKey}`,
	};
	if (body) {
		headers['Content-Length'] = Buffer.byteLength(body);
	}

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || 443,
		path: targetUrl.pathname + req.url,
		method: req.method,
		headers,
		rejectUnauthorized: false,
	};

	const proxyReq = https.request(options, (proxyRes) => {
		callback(null, proxyRes);
	});

	proxyReq.on('error', (err) => {
		log('error', `Upstream error: ${err.message}`);
		callback(err, null);
	});

	proxyReq.setTimeout(300000, () => {
		proxyReq.destroy();
		callback(new Error('Upstream timeout'), null);
	});

	if (body) {
		proxyReq.write(body);
	}
	proxyReq.end();
};

const server = http.createServer((req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', '*');

	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	if (req.url === '/health' || req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			status: 'ok',
			target: config.target.url,
			mappings: config.modelMapping.length,
		}));
		return;
	}

	let body = '';
	req.on('data', (chunk) => {
		body += chunk;
	});
	req.on('end', () => {
		log('debug', `${req.method} ${req.url}`);

		if (body && req.url.includes('/v1/messages')) {
			try {
				const parsed = JSON.parse(body);
				if (parsed.model) {
					const original = parsed.model;
					parsed.model = mapModel(parsed.model);
					if (original !== parsed.model) {
						log('info', `Model: ${original} → ${parsed.model}`);
					}
					body = JSON.stringify(parsed);
				}
			}
			catch (e) {
				log('warn', `Failed to parse request body: ${e.message}`);
			}
		}

		forwardRequest(req, body, (err, proxyRes) => {
			if (err) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'proxy_error',
						message: err.message,
					},
				}));
				return;
			}

			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(res);

			proxyRes.on('error', (e) => {
				log('error', `Response stream error: ${e.message}`);
			});
		});
	});
});

const startServer = () => {
	server.listen(port, host, () => {
		log('info', `Bridge server started on http://${host}:${port}`);
		log('info', `Forwarding to: ${config.target.url}`);
		log('info', 'Model mappings:');
		config.modelMapping.forEach((rule) => {
			log('info', `  ${rule.prefix}* → ${rule.target}`);
		});
	});

	process.on('SIGINT', () => {
		log('info', 'Shutting down...');
		server.close(() => {
			process.exit(0);
		});
	});

	process.on('SIGTERM', () => {
		log('info', 'Shutting down...');
		server.close(() => {
			process.exit(0);
		});
	});

	return server;
};

if (require.main === module) {
	startServer();
}

module.exports = { mapModel, startServer, config };
