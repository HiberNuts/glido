import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGENTS = 3;
const require = createRequire(import.meta.url);
const { version: CLIENT_VERSION } = require('../package.json');

export function buildTurnInput(prompt, images = []) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new TypeError('prompt must be a non-empty string');
  }
  if (!Array.isArray(images) || images.some((image) => typeof image !== 'string' || image.length === 0)) {
    throw new TypeError('images must be an array of non-empty paths');
  }
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...images.map((path) => ({ type: 'localImage', path, detail: null })),
  ];
}

export class CodexAppServer extends EventEmitter {
  constructor({
    command = 'codex',
    cwd = process.cwd(),
    config = [],
    timeout = DEFAULT_TIMEOUT_MS,
    agents = true,
  } = {}) {
    super();
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('command must be a non-empty string');
    }
    if (!Array.isArray(config)) throw new TypeError('config must be an array');
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError('timeout must be a positive number');
    }
    if (typeof agents !== 'boolean') throw new TypeError('agents must be a boolean');

    this.command = command;
    this.cwd = cwd;
    this.config = config.map(String);
    this.timeout = timeout;
    this.agents = agents;
    this.process = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    this._startPromise = null;
    this._readline = null;
    this._closing = false;
    this._closed = false;
    this._maxAgents = null;
    this._stderr = '';
    // App Server has an `error` notification; keep EventEmitter from treating it
    // as an unhandled JavaScript exception when a host does not subscribe.
    this.on('error', () => {});
  }

  async start() {
    if (this.initialized) return this;
    if (this._closed) throw new Error('Codex app server is closed');
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._start().then(() => this);
    try {
      return await this._startPromise;
    } catch (error) {
      this._startPromise = null;
      if (this.process && this.process.exitCode === null) this.process.kill();
      throw error;
    }
  }

  async request(method, params = {}) {
    if (!this.initialized) await this.start();
    return this._request(method, params);
  }

  notify(method, params = {}) {
    this._write({ method, params });
  }

  respond(id, result = {}) {
    this._write({ id, result });
  }

  respondError(id, error) {
    const normalized = error instanceof Error
      ? { code: error.code ?? -32603, message: error.message, data: error.data }
      : {
          code: error?.code ?? -32603,
          message: error?.message ?? String(error ?? 'Request failed'),
          data: error?.data,
        };
    if (normalized.data === undefined) delete normalized.data;
    this._write({ id, error: normalized });
  }

  async startThread({
    cwd = this.cwd,
    model,
    effort,
    prompt,
    images = [],
    maxAgents = DEFAULT_MAX_AGENTS,
  } = {}) {
    this._validatePrompt(prompt);
    buildTurnInput(prompt, images);
    this._setMaxAgents(maxAgents);
    await this.start();

    const threadParams = this._compact({
      cwd,
      model,
      serviceName: 'glido',
      config: effort ? { model_reasoning_effort: effort } : undefined,
    });
    const threadResult = await this._request('thread/start', threadParams);
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error('thread/start returned no thread id');

    const turnResult = await this._request('turn/start', this._turnParams({
      threadId,
      cwd,
      model,
      effort,
      prompt,
      images,
    }));
    const turnId = turnResult?.turn?.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    return { threadId, turnId };
  }

  async resumeThread({ threadId, cwd = this.cwd, model, effort, prompt, images = [], maxAgents = DEFAULT_MAX_AGENTS } = {}) {
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadId must be a non-empty string');
    }
    this._validatePrompt(prompt);
    buildTurnInput(prompt, images);
    this._setMaxAgents(maxAgents);
    await this.start();

    const resumeResult = await this._request('thread/resume', this._compact({
      threadId,
      cwd,
      model,
      config: effort ? { model_reasoning_effort: effort } : undefined,
    }));
    const resumedThreadId = resumeResult?.thread?.id ?? threadId;
    const turnResult = await this._request('turn/start', this._turnParams({
      threadId: resumedThreadId,
      cwd,
      model,
      effort,
      prompt,
      images,
    }));
    const turnId = turnResult?.turn?.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    return { threadId: resumedThreadId, turnId };
  }

  async startTurn({ threadId, cwd = this.cwd, model, effort, prompt, images = [] } = {}) {
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadId must be a non-empty string');
    }
    this._validatePrompt(prompt);
    buildTurnInput(prompt, images);
    await this.start();
    const turnResult = await this._request('turn/start', this._turnParams({
      threadId, cwd, model, effort, prompt, images,
    }));
    const turnId = turnResult?.turn?.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    return { threadId, turnId };
  }

  async interrupt({ threadId, turnId } = {}) {
    if (!threadId || !turnId) throw new TypeError('threadId and turnId are required');
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._closing = true;
    const child = this.process;
    if (!child || child.exitCode !== null) {
      this._readline?.close();
      return;
    }

    const exited = new Promise((resolve) => child.once('close', resolve));
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    child.stdin.end();
    await Promise.race([exited, wait(500)]);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, wait(500)]);
    }
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, wait(500)]);
    }
    this._readline?.close();
  }

  async _start() {
    const maxAgents = this._maxAgents ?? DEFAULT_MAX_AGENTS;
    this._maxAgents = maxAgents;
    this._stderr = '';
    const assignments = [
      ...this.config,
      `agents.enabled=${this.agents}`,
      ...(this.agents ? [`agents.max_concurrent_threads_per_session=${maxAgents}`] : []),
    ];
    const args = ['app-server', '--stdio'];
    for (const assignment of assignments) args.push('--config', assignment);

    const child = spawn(this.command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this._readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this._readline.on('line', (line) => this._handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk).slice(-4_096);
      this.emit('stderr', chunk);
    });
    child.on('error', (error) => this._handleProcessError(child, error));
    child.stdin.on('error', (error) => this._handleProcessError(child, error));
    child.stdout.on('error', (error) => this._handleProcessError(child, error));
    child.on('close', (code, signal) => this._handleExit(child, code, signal));

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await this._request('initialize', {
      clientInfo: { name: 'glido', title: 'Glido', version: CLIENT_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  _request(method, params) {
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(new TypeError('method must be a non-empty string'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this._write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _write(message) {
    if (!this.process || this.process.exitCode !== null || !this.process.stdin.writable) {
      throw new Error('Codex app server is not running');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('protocolError', new Error(`Invalid JSON from Codex app server: ${error.message}`));
      return;
    }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit('orphanResponse', message);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `${pending.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.hasOwn(message, 'id')) {
      const handled = this.listenerCount('serverRequest') > 0
        || this.listenerCount(message.method) > 0;
      this.emit('serverRequest', message);
      this.emit(message.method, message.params, message);
      if (!handled) this._rejectUnhandledServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
      this.emit(message.method, message.params, message);
      return;
    }
    this.emit('protocolError', new Error('Unrecognized message from Codex app server'));
  }

  _rejectUnhandledServerRequest(message) {
    const safeResults = {
      'item/commandExecution/requestApproval': { decision: 'decline' },
      'item/fileChange/requestApproval': { decision: 'decline' },
      'item/tool/requestUserInput': { answers: {} },
      'mcpServer/elicitation/request': { action: 'cancel', content: null, _meta: null },
      'item/tool/call': { contentItems: [], success: false },
      applyPatchApproval: { decision: 'abort' },
      execCommandApproval: { decision: 'abort' },
      'currentTime/read': { currentTimeAt: Math.floor(Date.now() / 1_000) },
    };
    if (Object.hasOwn(safeResults, message.method)) {
      this.respond(message.id, safeResults[message.method]);
    } else {
      this.respondError(message.id, {
        code: -32601,
        message: `Glido does not handle server request: ${message.method}`,
      });
    }
  }

  _handleProcessError(child, error) {
    if (child !== this.process) return;
    if (!this._closing) this.emit('processError', error);
    this._rejectPending(error);
  }

  _handleExit(child, code, signal) {
    if (child !== this.process) return;
    this.initialized = false;
    this.process = null;
    this._startPromise = null;
    const detail = this._stderr.trim();
    const suffix = detail ? `: ${detail}` : '';
    this._rejectPending(new Error(
      `Codex app server exited${code === null ? '' : ` with code ${code}`}`
      + `${signal ? ` (${signal})` : ''}${suffix}`,
    ));
    this.emit('exit', code, signal);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _setMaxAgents(value) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError('maxAgents must be a positive integer');
    }
    if (this.process && this._maxAgents !== value) {
      throw new Error(`App server already started with maxAgents=${this._maxAgents}`);
    }
    this._maxAgents = value;
  }

  _validatePrompt(prompt) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new TypeError('prompt must be a non-empty string');
    }
  }

  _turnParams({ threadId, cwd, model, effort, prompt, images = [] }) {
    return this._compact({
      threadId,
      input: buildTurnInput(prompt, images),
      cwd,
      model,
      effort,
    });
  }

  _compact(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
  }
}
