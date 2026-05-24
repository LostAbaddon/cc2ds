const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

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

const stripExtraUsage = (usage) => {
	if (!usage) {
		return usage;
	}
	const { cache_creation_input_tokens, cache_read_input_tokens, service_tier, ...clean } = usage;
	return clean;
};

const createResponseTransformer = (targetModel, originalModel) => {
	let msgId = null;

	return new Transform({
		transform(chunk, encoding, callback) {
			let str = chunk.toString();

			if (originalModel && originalModel !== targetModel) {
				str = str.replace(new RegExp(targetModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), originalModel);
			}

			const lines = str.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line.startsWith('data: ')) {
					continue;
				}

				const jsonStr = line.substring(6);
				let parsed;
				try {
					parsed = JSON.parse(jsonStr);
				}
				catch (e) {
					continue;
				}

				if (parsed.type === 'message_start' && parsed.message) {
					msgId = parsed.message.id;
					if (parsed.message.usage) {
						parsed.message.usage = stripExtraUsage(parsed.message.usage);
					}
					lines[i] = 'data: ' + JSON.stringify(parsed);
				}
				else if (parsed.type === 'content_block_start' && parsed.content_block && parsed.content_block.type === 'thinking') {
					if (parsed.content_block.signature === '' && msgId) {
						parsed.content_block.signature = msgId;
						lines[i] = 'data: ' + JSON.stringify(parsed);
					}
				}
				else if (parsed.type === 'message_delta') {
					if (parsed.usage) {
						parsed.usage = stripExtraUsage(parsed.usage);
					}
					lines[i] = 'data: ' + JSON.stringify(parsed);
				}
			}

			this.push(lines.join('\n'));
			callback();
		},
	});
};

const forwardRequest = (model, req, body, callback) => {
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

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		callback(err, proxyRes);
	};

	const proxyReq = https.request(options, (proxyRes) => {
		log('info', `Redirect: ${model}: DONE`);
		once(null, proxyRes);
	});

	proxyReq.on('error', (err) => {
		log('error', `Upstream error: ${model}: ${err.message}`);
		once(err, null);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		log('info', `Redirect: ${model}: TimeOut`);
		once(new Error('Upstream timeout'), null);
	});

	if (body) {
		proxyReq.write(body);
	}
	proxyReq.end();
};

const buildModelList = () => {
	const models = [];
	const today = new Date().toISOString().split('T')[0];
	for (const rule of config.modelMapping) {
		models.push({
			id: rule.prefix,
			type: 'model',
			display_name: rule.prefix,
			created_at: today,
		});
	}
	return { data: models, has_more: false, first_id: models[0]?.id || null, last_id: models[models.length - 1]?.id || null };
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

	if (req.url === '/v1/models' || req.url === '/v1/models?before_id=' || req.url === '/v1/models?after_id=') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(buildModelList()));
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

		let targetModel = "undefined";
		let originalModel = null;
		if (body && req.url.includes('/v1/messages')) {
			try {
				const parsed = JSON.parse(body);
				if (parsed.model) {
					originalModel = parsed.model;
					const mapped = mapModel(parsed.model);
					if (originalModel !== mapped) {
						targetModel = mapped;
						log('info', `Model: ${originalModel} → ${mapped}`);
					}
					parsed.model = mapped;

					if (parsed.thinking && parsed.thinking.type === 'adaptive') {
						parsed.thinking.type = 'enabled';
						log('info', `Thinking: adaptive → enabled for ${mapped}`);
					}

					body = JSON.stringify(parsed);
				}
			}
			catch (e) {
				log('warn', `Failed to parse request body: ${e.message}`);
			}
		}

		forwardRequest(targetModel, req, body, (err, proxyRes) => {
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

					const isStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

			if (isStream) {
				const transformer = createResponseTransformer(targetModel, originalModel);
				res.writeHead(proxyRes.statusCode, proxyRes.headers);
				proxyRes.pipe(transformer).pipe(res);
				transformer.on('error', (e) => {
					log('error', `Transformer stream error: ${e.message}`);
				});
			}
			else {
				let responseBody = '';
				proxyRes.on('data', (chunk) => {
					responseBody += chunk;
				});
				proxyRes.on('end', () => {
					try {
						const parsed = JSON.parse(responseBody);

						if (originalModel && originalModel !== targetModel) {
							parsed.model = originalModel;
						}
						if (parsed.usage) {
							parsed.usage = stripExtraUsage(parsed.usage);
						}
						if (parsed.content) {
							for (const block of parsed.content) {
								if (block.type === 'thinking' && block.signature === '' && parsed.id) {
									block.signature = parsed.id;
								}
							}
						}

						responseBody = JSON.stringify(parsed);
					}
					catch (e) {
						log('warn', `Failed to transform JSON response: ${e.message}`);
					}

					res.writeHead(proxyRes.statusCode, proxyRes.headers);
					res.end(responseBody);
				});
			}

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
